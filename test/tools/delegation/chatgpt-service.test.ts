import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core"

import { MCP_CONFIG } from "../../../src/config.js"
import { extractConversationId } from "../../../src/tools/delegation/chatgpt-browser.js"
import { createChatGptDelegationService } from "../../../src/tools/delegation/chatgpt-service.js"
import { ChatGptDelegationError } from "../../../src/tools/delegation/contracts.js"
import { createDelegationStore } from "../../../src/tools/delegation/store.js"

test("saved agents start at the configured URL and resume after idle or external tab closure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-lifecycle-"))
  const previousStateDir = MCP_CONFIG.stateDir
  const previousProjectUrl = MCP_CONFIG.chatGpt.projectUrl
  MCP_CONFIG.stateDir = directory
  MCP_CONFIG.chatGpt.projectUrl = "https://chatgpt.com/g/g-p-fixture/project"
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 })
  const fixture = browserFixture()
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    MCP_CONFIG.chatGpt.projectUrl = previousProjectUrl
    rmSync(directory, { recursive: true, force: true })
  })

  const request = { agentId: "researcher", prompt: "Review this" }
  const turnId = await service.ask(request, {})
  const completed = await service.poll(turnId, 0)
  assert.equal(completed.status, "completed")
  assert.equal(completed.response, "Reviewed")
  assert.equal(fixture.navigations[0], MCP_CONFIG.chatGpt.projectUrl)

  t.mock.timers.tick(29 * 60_000)
  await setImmediate()
  assert.equal(fixture.pages[0]?.isClosed(), false)
  t.mock.timers.tick(60_000)
  await setImmediate()
  assert.equal(fixture.pages[0]?.isClosed(), true)
  assert.deepEqual(await service.poll(turnId, 0), completed)

  const nextTurnId = await service.ask({ ...request, prompt: "Follow up" }, {})
  assert.equal((await service.poll(nextTurnId, 0)).status, "completed")
  assert.equal(fixture.pages.length, 2)
  assert.equal(extractConversationId(fixture.pages[1]!.url()), "lifecycle-conversation")

  await fixture.pages[1]!.close()
  const thirdTurnId = await service.ask({ ...request, prompt: "Continue after tab closure" }, {})
  assert.equal((await service.poll(thirdTurnId, 0)).status, "completed")
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
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    service.ask({ agentId: "researcher", prompt: "Review this" }, {}),
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
  const service = createChatGptDelegationService()
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

  const turnId = await service.ask({ agentId: "researcher", prompt: "Review this" }, {})
  assert.match(turnId, /^researcher_turn_1_/u)
  assert.equal((await service.poll(turnId, 0)).status, "completed")
  assert.equal(fixture.submissions, 1)
  assert.equal(warn.mock.callCount(), 1)

  await assert.rejects(
    service.ask({ agentId: "researcher", prompt: "Follow up" }, {}),
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
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const request = { agentId: "researcher", prompt: "Review this" }
  const turnId = await service.ask(request, {})
  assert.equal((await service.poll(turnId, 0)).status, "completed")

  t.mock.timers.tick(29 * 60_000)
  await setImmediate()
  t.mock.timers.tick(60_000)
  await setImmediate()
  assert.equal(fixture.pages[0]?.isClosed(), false)

  const followUpTurnId = await service.ask({ ...request, prompt: "Follow up" }, {})
  assert.equal((await service.poll(followUpTurnId, 0)).status, "completed")
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
      const service = createChatGptDelegationService()
      t.after(async () => {
        await service.dispose()
        MCP_CONFIG.stateDir = previousStateDir
        rmSync(directory, { recursive: true, force: true })
      })

      const turnId = await service.ask({ agentId: "researcher", prompt: "Review this" }, {})
      assert.match(turnId, /^researcher_turn_1_/u)
      assert.equal(fixture.submissions, 1)
      assert.equal((await service.poll(turnId, 1_000)).response, "Reviewed")
    })
  }
}

test("submission failure disposes the unused observer without an unhandled rejection", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-submit-failure-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const fixture = browserFixture({ submissionError: new Error("Send unavailable") })
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    service.ask({ agentId: "researcher", prompt: "Review this" }, {}),
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
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const turnId = await service.ask(
    { agentId: "researcher", prompt: "Open https://example.com/ with `web.run`." },
    {}
  )
  const result = await service.poll(turnId, 0)
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
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    MCP_CONFIG.chatGpt.maxDelegatedAgents = previousLimit
    rmSync(directory, { recursive: true, force: true })
  })

  for (const agentId of ["first", "second"]) {
    await assert.rejects(service.ask({ agentId, prompt: "Review this" }, {}), /Send unavailable/u)
  }
  assert.equal(fixture.pages.length, 2)
  assert.ok(fixture.pages.every((page) => page.isClosed()))
  assert.equal(fixture.submissions, 0)
})

for (const branchInSamePage of [false, true]) {
  test(`forked subagents persist and continue (${branchInSamePage ? "same page" : "popup"})`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "shellby-forked-subagent-"))
    const previousStateDir = MCP_CONFIG.stateDir
    MCP_CONFIG.stateDir = directory
    const fixture = browserFixture({ branchInSamePage })
    t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
    const service = createChatGptDelegationService()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      rmSync(directory, { recursive: true, force: true })
    })

    const request = {
      agentId: "reviewer",
      prompt: "Review this",
      conversationId: "source",
    }
    const first = await service.ask(request, {})
    assert.match(first, /^reviewer_turn_1_/u)
    assert.equal((await service.poll(first, 0)).response, "Reviewed")
    await fixture.pages.at(-1)?.close()
    const second = await service.ask({ agentId: request.agentId, prompt: "Follow up" }, {})
    assert.match(second, /^reviewer_turn_2_/u)
    assert.equal((await service.poll(second, 0)).response, "Reviewed")
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
  const firstService = createChatGptDelegationService()
  let restored: ReturnType<typeof createChatGptDelegationService> | undefined
  t.after(async () => {
    await (restored ?? firstService).dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })
  const request = { agentId: "reviewer", prompt: "First" }
  const first = await firstService.ask(request, {})
  assert.equal((await firstService.poll(first, 0)).status, "completed")
  await firstService.dispose()
  const db = new DatabaseSync(join(directory, "subagents.sqlite"))
  db.exec("UPDATE agents SET turn_count = 'lost'")
  db.close()
  restored = createChatGptDelegationService()
  assert.deepEqual(restored.drainEvents(), ["existing_agent agent_id=reviewer"])
  const next = await restored.ask(
    { ...request, prompt: "Continue", conversationId: "ignored-source" },
    {}
  )
  assert.match(next, /^reviewer_turn_1_/u)
  assert.notEqual(next, first)
  assert.equal((await restored.poll(next, 0)).status, "completed")
  await assert.rejects(restored.poll(first, 0), { code: "UNKNOWN_TURN" })
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
    const service = createChatGptDelegationService()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      rmSync(directory, { recursive: true, force: true })
    })
    const request = { agentId: "reviewer", prompt: "First", conversationId: "source" }
    const first = await service.ask(request, {})
    assert.equal((await service.poll(first, 0)).status, "completed")
    const second = await service.ask({ ...request, prompt: "Second" }, {})
    assert.equal((await service.poll(second, 0)).status, "completed")
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
    const service = createChatGptDelegationService()
    t.after(async () => {
      await service.dispose()
      MCP_CONFIG.stateDir = previousStateDir
      MCP_CONFIG.chatGpt.maxDelegatedAgents = previousLimit
      rmSync(directory, { recursive: true, force: true })
    })
    for (const agentId of ["first", "second"]) {
      await assert.rejects(
        service.ask({ agentId, prompt: "Task", conversationId: "source" }, {}),
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

test("invalid conversation IDs fail before opening or submitting a conversation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-fork-options-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  t.mock.method(console, "warn", () => {})
  const fixture = browserFixture()
  t.mock.method(chromium, "connectOverCDP", async () => fixture.browser)
  const service = createChatGptDelegationService()
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })
  await assert.rejects(
    service.ask({ agentId: "reviewer", prompt: "Task", conversationId: "../source" }, {}),
    {
      code: "INVALID_ARGUMENT",
    }
  )
  assert.equal(fixture.pages.length, 0)
  assert.equal(fixture.submissions, 0)
})

function browserFixture(
  options: {
    pageCloseFailures?: number
    navigationStalls?: boolean
    afterSendError?: boolean
    submissionError?: Error
    serializePrompt?: boolean
    inlinePostData?: boolean
    branchInSamePage?: boolean
    branchError?: Error
    branchConversationId?: string
  } = {}
): {
  browser: Browser
  pages: Page[]
  readonly submissions: number
  readonly branches: number
  prompts: string[]
  navigations: string[]
} {
  const pages: Page[] = []
  const sessions = new Map<
    Page,
    EventEmitter & { send(method: string): Promise<unknown>; detach(): Promise<void> }
  >()
  let connected = true
  let submissions = 0
  let branches = 0
  const prompts: string[] = []
  const navigations: string[] = []
  let remainingPageCloseFailures = options.pageCloseFailures ?? 0
  const context = {
    pages: () => pages.filter((page) => !page.isClosed()),
    newCDPSession: async (page: Page) => sessions.get(page),
  }
  const browser = {
    isConnected: () => connected,
    contexts: () => [context],
    close: async () => {
      connected = false
    },
    newBrowserCDPSession: async () => ({
      detach: async () => {},
      send: async (method: string) => {
        assert.equal(method, "Target.createTarget")
        const targetId = `target-${pages.length}`
        let closed = false
        let url = "about:blank"
        let prompt = ""
        let requestPostData = ""
        const cdp = Object.assign(new EventEmitter(), {
          send: async (method: string) => {
            if (method === "Network.getRequestPostData") {
              await setImmediate()
              return { postData: requestPostData }
            }
            return { targetInfo: { targetId } }
          },
          detach: async () => {},
        })
        const page = Object.assign(new EventEmitter(), {
          isClosed: () => closed,
          close: async () => {
            if (remainingPageCloseFailures > 0) {
              remainingPageCloseFailures -= 1
              throw new Error("forced page close failure")
            }
            closed = true
          },
          url: () => url,
          goto: async (value: string) => {
            navigations.push(value)
            url = value
          },
          context: () => context as unknown as BrowserContext,
          keyboard: {
            insertText: async (value: string) => {
              prompt = value
            },
          },
          getByRole: (_role: string, input: { name: string }) => {
            const item = {
              last: () => item,
              count: async () => 1,
              isVisible: async () => true,
              hover: async () => {},
              press: async (key: string) => {
                if (key === "Enter") await item.click()
              },
              click: async () => {
                if (input.name !== "Branch in new Chat") return
                branches += 1
                const branchUrl = `https://chatgpt.com/c/${options.branchConversationId ?? `branch-${branches}`}`
                if (options.branchInSamePage) url = branchUrl
                else {
                  const browserSession = await browser.newBrowserCDPSession()
                  await browserSession.send("Target.createTarget", { url: "about:blank" })
                  const branch = pages.at(-1)!
                  await branch.goto(branchUrl)
                  ;(page as unknown as EventEmitter).emit("popup", branch)
                }
                if (options.branchError) throw options.branchError
              },
            }
            return item
          },
          locator: (selector: string) => {
            const visible =
              selector === "#prompt-textarea" ||
              selector === 'button[data-testid="send-button"]' ||
              selector.startsWith("section[") ||
              selector === 'button[aria-label="More actions"]'
            const locator = {
              first: () => locator,
              last: () => locator,
              locator: (nested: string) => page.locator(nested),
              scrollIntoViewIfNeeded: async () => {},
              hover: async () => {},
              count: async () => Number(visible),
              isVisible: async () => visible,
              isEnabled: async () => true,
              press: async () => {},
              click: async (clickOptions?: { noWaitAfter?: boolean }) => {
                if (selector !== 'button[data-testid="send-button"]') return
                if (options.submissionError) throw options.submissionError
                submissions += 1
                prompts.push(prompt)
                const userMessage = {
                  id: `submitted-user-${submissions}`,
                  author: { role: "user" },
                  content: {
                    parts: [
                      options.serializePrompt
                        ? prompt
                            .replaceAll(
                              "https://example.com/",
                              "[https://example.com/](https://example.com/)"
                            )
                            .replaceAll("`", "\\`")
                            .replaceAll("---", "\\---")
                        : prompt,
                    ],
                  },
                }
                const body = [
                  { v: { message: userMessage } },
                  {
                    v: {
                      message: {
                        author: { role: "assistant" },
                        content: { parts: ["Reviewed"] },
                        status: "finished_successfully",
                        end_turn: true,
                      },
                    },
                  },
                  {
                    type: "message_stream_complete",
                    conversation_id: extractConversationId(url) ?? "lifecycle-conversation",
                  },
                ]
                  .map((item) => `data: ${JSON.stringify(item)}\n\n`)
                  .join("")
                requestPostData = JSON.stringify({ action: "next", messages: [userMessage] })
                cdp.emit("Network.requestWillBeSent", {
                  requestId: "turn",
                  request: {
                    method: "POST",
                    url: "https://chatgpt.com/backend-api/f/conversation",
                    ...(options.inlinePostData === false ? {} : { postData: requestPostData }),
                  },
                })
                cdp.emit("Network.dataReceived", {
                  requestId: "turn",
                  data: Buffer.from(body).toString("base64"),
                })
                if (
                  options.afterSendError ||
                  (options.navigationStalls && !clickOptions?.noWaitAfter)
                )
                  throw new Error("Navigation timed out after Send")
              },
            }
            return locator
          },
        }) as unknown as Page
        pages.push(page)
        sessions.set(page, cdp)
        return { targetId }
      },
    }),
  } as unknown as Browser
  return {
    browser,
    pages,
    get submissions() {
      return submissions
    },
    get branches() {
      return branches
    },
    prompts,
    navigations,
  }
}
