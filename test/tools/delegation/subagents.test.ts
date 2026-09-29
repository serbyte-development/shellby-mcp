import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { chromium } from "playwright-core"
import { getAgentChildren, getAgentIdentity, runWithAgent } from "../../../src/agent/context.js"
import { stampAgentIdentity } from "../../../src/agent/identity-marker.js"
import { MCP_CONFIG } from "../../../src/config.js"
import { extractConversationId } from "../../../src/tools/delegation/chatgpt-browser.js"
import { createDelegationStore } from "../../../src/tools/delegation/store.js"
import { ChatGptDelegationError } from "../../../src/tools/delegation/subagent-error.js"
import { createSubagents } from "../../../src/tools/delegation/subagents.js"
import { browserFixture } from "../../fixtures/subagent-browser.js"
import { getAgentResponse, sendAgentMessage } from "../../fixtures/subagents.js"

for (const fork of [false, true]) {
  test(`observed MCP responses link ${fork ? "forked" : "fresh"} subagents to their parent without registration`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "shellby-agent-lineage-"))
    const previousStateDir = MCP_CONFIG.stateDir
    MCP_CONFIG.stateDir = directory
    const fixture = browserFixture({ completeOnSubmit: false, stableUrlOnSubmit: true })
    t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
    const service = createSubagents()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      rmSync(directory, { recursive: true, force: true })
    })
    const parent = runWithAgent(`lineage-parent-${fork}`, () => getAgentIdentity()!)
    const child = runWithAgent(`lineage-child-${fork}`, () => getAgentIdentity()!)
    const stamped = stampAgentIdentity({ content: [] }, child) as {
      content: Array<{ text: string }>
    }
    const toolText = stamped.content.map((item) => item.text).join("\n")
    const request = {
      agentId: "worker",
      prompt: "Review this",
      ...(fork ? { startSource: "https://chatgpt.com/c/source-conversation" } : {}),
    }
    const turnId = await runWithAgent(parent.sessionId, () => sendAgentMessage(service, request))
    assert.equal(child.parent, undefined)
    assert.equal(fixture.branches, Number(fork))
    assert.equal(fixture.prompts[0]?.includes("[sb:"), false)
    fixture.toolResponse(1, toolText)
    await setImmediate()
    assert.equal(child.parent, parent)
    assert.equal(child.taskSlug, undefined, "A tool result alone establishes the link")
    fixture.toolResponse(1, toolText)
    fixture.completeTurn(1, "Done")
    await setImmediate()
    assert.equal(
      (await runWithAgent(parent.sessionId, () => getAgentResponse(service, turnId, 0))).response,
      "Done"
    )
    assert.deepEqual(getAgentChildren(parent), [child])
    const store = createDelegationStore(join(directory, "subagents.sqlite"))
    t.after(() => store.close())
    assert.equal(store.get(parent, "worker")?.childSessionId, child.sessionId)

    const noMcpTurn = await runWithAgent(parent.sessionId, () =>
      sendAgentMessage(service, {
        agentId: "no-mcp",
        prompt: "Answer without tools",
      })
    )
    fixture.completeTurn(2, "No tools needed")
    await setImmediate()
    assert.equal(
      (await runWithAgent(parent.sessionId, () => getAgentResponse(service, noMcpTurn, 0))).status,
      "completed"
    )
    assert.equal(store.get(parent, "no-mcp")?.childSessionId, undefined)
    assert.ok(store.get(parent, "no-mcp")?.conversationUrl)
    assert.deepEqual(getAgentChildren(parent), [child])
  })
}

test("saved agents start at the configured URL and resume after idle or external tab closure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-lifecycle-"))
  const previousStateDir = MCP_CONFIG.stateDir
  const previousProjectUrl = MCP_CONFIG.chatGpt.projectUrl
  MCP_CONFIG.stateDir = directory
  MCP_CONFIG.chatGpt.projectUrl = "https://chatgpt.com/g/g-p-fixture/project"
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 })
  const fixture = browserFixture()
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    MCP_CONFIG.chatGpt.projectUrl = previousProjectUrl
    rmSync(directory, { recursive: true, force: true })
  })

  const request = { agentId: "researcher", prompt: "Review this" }
  const turnId = await sendAgentMessage(service, request, {})
  const completed = await getAgentResponse(service, turnId, 0)
  assert.equal(completed.status, "completed")
  assert.equal(completed.response, "Reviewed")
  assert.equal(fixture.navigations[0], MCP_CONFIG.chatGpt.projectUrl)

  t.mock.timers.tick(29 * 60_000)
  await setImmediate()
  assert.equal(fixture.pages[0]?.isClosed(), false)
  t.mock.timers.tick(60_000)
  await setImmediate()
  assert.equal(fixture.pages[0]?.isClosed(), true)
  assert.deepEqual(await getAgentResponse(service, turnId, 0), completed)

  const nextTurnId = await sendAgentMessage(service, { ...request, prompt: "Follow up" }, {})
  assert.equal((await getAgentResponse(service, nextTurnId, 0)).status, "completed")
  assert.equal(fixture.pages.length, 2)
  assert.equal(extractConversationId(fixture.pages[1]!.url()), "lifecycle-conversation")

  await fixture.pages[1]!.close()
  const thirdTurnId = await sendAgentMessage(
    service,
    { ...request, prompt: "Continue after tab closure" },
    {}
  )
  assert.equal((await getAgentResponse(service, thirdTurnId, 0)).status, "completed")
  assert.equal(fixture.pages.length, 3)
  assert.equal(extractConversationId(fixture.pages[2]!.url()), "lifecycle-conversation")
  assert.deepEqual(fixture.prompts.slice(1), ["Follow up", "Continue after tab closure"])
})

test("persistence initialization failure blocks delegation before browser connection", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-persistence-init-"))
  const blockedStateDir = join(directory, "state-file")
  writeFileSync(blockedStateDir, "blocked")
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = blockedStateDir
  const warn = t.mock.method(console, "warn", () => {})
  const connect = t.mock.method(chromium, "connectOverCDP", async () => browserFixture().browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    sendAgentMessage(service, { agentId: "researcher", prompt: "Review this" }, {}),
    (error: unknown) =>
      error instanceof ChatGptDelegationError &&
      error.code === "SUBAGENT_PERSISTENCE_UNAVAILABLE" &&
      /No new prompt was submitted/u.test(error.message)
  )
  assert.equal(connect.mock.callCount(), 0)
  const failures = warn.mock.calls
    .map((call) => String(call.arguments[0]))
    .filter((message) => message.startsWith("[delegation] "))
  assert.equal(failures.length, 1)
  const diagnostic = JSON.parse(failures[0]!.slice("[delegation] ".length))
  assert.equal(diagnostic.phase, "admission")
  assert.equal(diagnostic.error.code, "SUBAGENT_PERSISTENCE_UNAVAILABLE")
  assert.equal(diagnostic.submission_observed, false)
  assert.deepEqual(diagnostic.pages, [])
})

test("post-submit persistence failure keeps the turn valid and blocks later submission", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-persistence-write-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const warn = t.mock.method(console, "warn", () => {})
  const fixture = browserFixture()
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const breaker = new DatabaseSync(join(directory, "subagents.sqlite"))
  breaker.exec(`
    CREATE TRIGGER fail_agents_write
    BEFORE INSERT ON agents
    BEGIN
      SELECT RAISE(ABORT, 'forced write failure');
    END;
  `)
  breaker.close()

  const turnId = await sendAgentMessage(
    service,
    { agentId: "researcher", prompt: "Review this" },
    {}
  )
  assert.match(turnId, /^researcher_turn_1_/u)
  assert.equal((await getAgentResponse(service, turnId, 0)).status, "completed")
  assert.equal(fixture.submissions, 1)
  assert.equal(warn.mock.callCount(), 1)

  await assert.rejects(
    sendAgentMessage(service, { agentId: "researcher", prompt: "Follow up" }, {}),
    (error: unknown) =>
      error instanceof ChatGptDelegationError && error.code === "SUBAGENT_PERSISTENCE_UNAVAILABLE"
  )
  assert.equal(fixture.submissions, 1)
})

test("failed idle page close preserves the saved agent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-idle-close-failure-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 })
  const fixture = browserFixture({ pageCloseFailures: 1 })
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const request = { agentId: "researcher", prompt: "Review this" }
  const turnId = await sendAgentMessage(service, request, {})
  assert.equal((await getAgentResponse(service, turnId, 0)).status, "completed")

  t.mock.timers.tick(29 * 60_000)
  await setImmediate()
  t.mock.timers.tick(60_000)
  await setImmediate()
  assert.equal(fixture.pages[0]?.isClosed(), false)

  const followUpTurnId = await sendAgentMessage(service, { ...request, prompt: "Follow up" }, {})
  assert.equal((await getAgentResponse(service, followUpTurnId, 0)).status, "completed")
  assert.equal(fixture.submissions, 2)
})

for (const inlinePostData of [true, false]) {
  for (const afterSendError of [false, true]) {
    test(`submission preserves the tracked turn with ${inlinePostData ? "inline" : "delayed"} request data when ${afterSendError ? "the browser action fails after sending" : "navigation stalls after Send"}`, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "shellby-agent-submit-navigation-"))
      const previousStateDir = MCP_CONFIG.stateDir
      MCP_CONFIG.stateDir = directory
      const fixture = browserFixture({ navigationStalls: true, afterSendError, inlinePostData })
      t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
      const service = createSubagents()
      t.after(async () => {
        await service.dispose()
        MCP_CONFIG.stateDir = previousStateDir
        rmSync(directory, { recursive: true, force: true })
      })

      const turnId = await sendAgentMessage(
        service,
        { agentId: "researcher", prompt: "Review this" },
        {}
      )
      assert.match(turnId, /^researcher_turn_1_/u)
      assert.equal(fixture.submissions, 1)
      assert.equal((await getAgentResponse(service, turnId, 1_000)).response, "Reviewed")
    })
  }
}

test("submission failure disposes the unused observer without an unhandled rejection", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-submit-failure-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const fixture = browserFixture({ submissionError: new Error("Send unavailable") })
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    sendAgentMessage(service, { agentId: "researcher", prompt: "Review this" }, {}),
    /Send unavailable/u
  )
  await setImmediate()
  assert.equal(fixture.submissions, 0)
})

test("a prompt serialized as Markdown still completes the submitted turn", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-serialized-prompt-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const fixture = browserFixture({ serializePrompt: true })
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const turnId = await sendAgentMessage(
    service,
    { agentId: "researcher", prompt: "Open https://example.com/ with `web.run`." },
    {}
  )
  const result = await getAgentResponse(service, turnId, 0)
  assert.equal(result.status, "completed")
  assert.equal(result.response, "Reviewed")
  assert.equal(fixture.submissions, 1)
})

test("a failed first submission closes its unused page and releases agent capacity", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-unused-slot-"))
  const previousStateDir = MCP_CONFIG.stateDir
  const previousLimit = MCP_CONFIG.chatGpt.maxDelegatedAgents
  MCP_CONFIG.stateDir = directory
  MCP_CONFIG.chatGpt.maxDelegatedAgents = 1
  const fixture = browserFixture({ submissionError: new Error("Send unavailable") })
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    MCP_CONFIG.chatGpt.maxDelegatedAgents = previousLimit
    rmSync(directory, { recursive: true, force: true })
  })

  for (const agentId of ["first", "second"]) {
    await assert.rejects(
      sendAgentMessage(service, { agentId, prompt: "Review this" }, {}),
      /Send unavailable/u
    )
  }
  assert.equal(fixture.pages.length, 2)
  assert.ok(fixture.pages.every((page) => page.isClosed()))
  assert.equal(fixture.submissions, 0)
})

// Synthetic sources exercise URL normalization through the fake browser.
for (const { startSource, forkSourceId, branchInSamePage } of [
  { startSource: "source", forkSourceId: "source", branchInSamePage: false },
  {
    startSource: " https://chatgpt.com/c/fixture-conversation?view=chat#latest ",
    forkSourceId: "fixture-conversation",
    branchInSamePage: true,
  },
  {
    startSource: "https://chatgpt.com/g/g-p-fixture-project/c/fixture-project-conversation",
    forkSourceId: "fixture-project-conversation",
    branchInSamePage: false,
  },
]) {
  test(`forked subagents persist and continue from ${startSource.trim()}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "shellby-forked-subagent-"))
    const previousStateDir = MCP_CONFIG.stateDir
    MCP_CONFIG.stateDir = directory
    const fixture = browserFixture({ branchInSamePage })
    t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
    const service = createSubagents()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      rmSync(directory, { recursive: true, force: true })
    })

    const request = {
      agentId: "reviewer",
      prompt: "Review this",
      startSource,
    }
    const first = await sendAgentMessage(service, request, {})
    assert.equal(fixture.navigations[0], `https://chatgpt.com/c/${forkSourceId}`)
    assert.match(first, /^reviewer_turn_1_/u)
    assert.equal((await getAgentResponse(service, first, 0)).response, "Reviewed")
    await fixture.pages.at(-1)?.close()
    const second = await sendAgentMessage(
      service,
      { agentId: request.agentId, prompt: "Follow up" },
      {}
    )
    assert.match(second, /^reviewer_turn_2_/u)
    assert.equal((await getAgentResponse(service, second, 0)).response, "Reviewed")
    assert.equal(fixture.branches, 1)
    assert.equal(fixture.submissions, 2)
    assert.match(fixture.prompts[0]!, /Oververbosity: 1/u)
    assert.equal(fixture.prompts[1], "Follow up")
    assert.equal(fixture.pages.filter((page) => !page.isClosed()).length, 1)
    const store = createDelegationStore(join(directory, "subagents.sqlite"))
    assert.equal(
      store.get(undefined, "reviewer")?.conversationUrl,
      "https://chatgpt.com/c/branch-1"
    )
    store.close()
  })
}

test("saved conversations resume after losing counters and results without reforking or reusing polling IDs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-conversation-continuity-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const fixtures = [browserFixture(), browserFixture()]
  let connection = 0
  t.mock.method(chromium, "connectOverCDP", async () => fixtures[connection++]!.browser)
  const firstService = createSubagents()
  let restored: ReturnType<typeof createSubagents> | undefined
  t.after(async () => {
    await (restored ?? firstService).dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })
  const request = { agentId: "reviewer", prompt: "First" }
  const first = await sendAgentMessage(firstService, request, {})
  assert.equal((await getAgentResponse(firstService, first, 0)).status, "completed")
  await firstService.dispose()
  const db = new DatabaseSync(join(directory, "subagents.sqlite"))
  db.exec("UPDATE agents SET turn_count = 'lost'")
  db.close()
  restored = createSubagents()
  assert.deepEqual(restored.drainEvents(), ["existing_agent agent_id=reviewer"])
  const next = await sendAgentMessage(
    restored,
    { ...request, prompt: "Continue", startSource: "https://chatgpt.com/c/ignored-source" },
    {}
  )
  assert.match(next, /^reviewer_turn_1_/u)
  assert.notEqual(next, first)
  assert.equal((await getAgentResponse(restored, next, 0)).status, "completed")
  await assert.rejects(getAgentResponse(restored, first, 0), { code: "UNKNOWN_TURN" })
  assert.equal(fixtures[1]!.branches, 0)
  assert.equal(extractConversationId(fixtures[1]!.pages[0]!.url()), "lifecycle-conversation")
  assert.deepEqual(fixtures[1]!.prompts, ["Continue"])
})

for (const branchConversationId of [
  "web:pending-branch",
  "WEB%3Apending-branch",
  "local-chatgpt%3Apending-branch",
]) {
  test(`forks with a ${branchConversationId} URL acquire saved identity from the submitted turn`, async (t) => {
    assert.equal(extractConversationId(`https://chatgpt.com/c/${branchConversationId}`), undefined)
    const directory = mkdtempSync(join(tmpdir(), "shellby-fork-client-url-"))
    const previousStateDir = MCP_CONFIG.stateDir
    MCP_CONFIG.stateDir = directory
    const fixture = browserFixture({ branchConversationId })
    t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
    const service = createSubagents()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      rmSync(directory, { recursive: true, force: true })
    })
    const request = { agentId: "reviewer", prompt: "First", startSource: "source" }
    const first = await sendAgentMessage(service, request, {})
    assert.equal((await getAgentResponse(service, first, 0)).status, "completed")
    const second = await sendAgentMessage(service, { ...request, prompt: "Second" }, {})
    assert.equal((await getAgentResponse(service, second, 0)).status, "completed")
    assert.equal(fixture.branches, 1)
    assert.equal(extractConversationId(fixture.pages.at(-1)!.url()), "lifecycle-conversation")
    assert.equal(fixture.prompts[1], "Second")
    const store = createDelegationStore(join(directory, "subagents.sqlite"))
    assert.equal(
      extractConversationId(store.get(undefined, "reviewer")!.conversationUrl),
      "lifecycle-conversation"
    )
    store.close()
  })
}

for (const failure of ["branch", "submission"] as const) {
  test(`failed fork ${failure} closes its pages and releases capacity`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "shellby-fork-cleanup-"))
    const previousStateDir = MCP_CONFIG.stateDir
    const previousLimit = MCP_CONFIG.chatGpt.maxDelegatedAgents
    MCP_CONFIG.stateDir = directory
    MCP_CONFIG.chatGpt.maxDelegatedAgents = 1
    t.mock.method(console, "warn", () => {})
    const error = new Error("forced failure")
    const fixture = browserFixture(
      failure === "branch" ? { branchError: error } : { submissionError: error }
    )
    t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
    const service = createSubagents()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      MCP_CONFIG.chatGpt.maxDelegatedAgents = previousLimit
      rmSync(directory, { recursive: true, force: true })
    })
    for (const agentId of ["first", "second"]) {
      await assert.rejects(
        sendAgentMessage(service, { agentId, prompt: "Task", startSource: "source" }, {}),
        /forced failure/u
      )
    }
    assert.equal(fixture.branches, 2)
    assert.equal(fixture.submissions, 0)
    assert.ok(fixture.pages.every((page) => page.isClosed()))
    const store = createDelegationStore(join(directory, "subagents.sqlite"))
    assert.deepEqual(store.list(undefined), [])
    store.close()
  })
}

test("invalid start sources fail before opening or submitting a conversation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-fork-options-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  t.mock.method(console, "warn", () => {})
  const fixture = browserFixture()
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })
  for (const startSource of [
    " ",
    "../source",
    "a".repeat(129),
    "https://chatgpt.com/g/g-p-project/project",
    "https://example.com/c/source",
    "https://chatgpt.com.example.com/c/source",
    "http://chatgpt.com/c/source",
    "https://chatgpt.com/c/",
    "https://chatgpt.com/c/%2Fsource",
    "https://chatgpt.com/c/%ZZ",
    "https://chatgpt.com/c/WEB:pending",
    "https://chatgpt.com/c/local-chatgpt%3Apending",
    "web:pending",
  ]) {
    await assert.rejects(
      sendAgentMessage(service, { agentId: "reviewer", prompt: "Task", startSource }, {}),
      { code: "INVALID_ARGUMENT" },
      startSource
    )
  }
  assert.equal(fixture.pages.length, 0)
  assert.equal(fixture.submissions, 0)
})
