import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import { chromium } from "playwright-core"

import { runWithAgent } from "../../../src/agent/context.js"
import { MCP_CONFIG } from "../../../src/config.js"
import { createSubagents } from "../../../src/tools/delegation/subagents.js"
import { browserFixture } from "../../fixtures/subagent-browser.js"
import { getAgentResponse, sendAgentMessage } from "../../fixtures/subagents.js"

test("an idle history check keeps observation alive and a later answer releases the agent", async (t) => {
  const { service, browser, send } = createFixture(t)
  const turn = await send("worker")
  const submittedAt = Date.now()
  t.mock.timers.tick(4 * 60_000)
  await setImmediate()
  assert.equal(browser.historyReads, 1)
  assert.equal(browser.pages.length, 1)
  assert.equal(browser.pages[0]!.isClosed(), false)
  const running = await getAgentResponse(service, turn, 0)
  assert.equal(running.status, "running")
  assert.ok(running.activityAgeMs! >= Date.now() - submittedAt)
  t.mock.timers.tick(60_000)
  await setImmediate()
  assert.equal(browser.historyReads, 1)
  await assert.rejects(send("worker"), { code: "AGENT_BUSY" })

  browser.completeTurn(1, "late answer")
  await setImmediate()
  assert.equal((await getAgentResponse(service, turn, 0)).response, "late answer")
  await send("worker")
  assert.equal(browser.submissions, 2)
})

test("navigation during prompt entry prevents Send and leaves the saved agent reusable", async (t) => {
  const { service, browser, send } = createFixture(t)
  const first = await send("worker")
  browser.completeTurn(1, "first answer")
  await setImmediate()
  const page = browser.pages[0]!
  const savedConversationUrl = page.url()
  t.mock.method(page.keyboard, "insertText", async () => {
    await page.goto("https://chatgpt.com/c/unrelated-conversation")
  })

  await assert.rejects(send("worker"), { code: "AGENT_TARGET_LOST" })
  assert.equal(browser.submissions, 1)
  assert.equal((await getAgentResponse(service, first, 0)).response, "first answer")

  await send("worker")
  assert.equal(browser.submissions, 2)
  assert.equal(browser.pages.length, 2)
  assert.equal(browser.pages[1]!.url(), savedConversationUrl)
})

test("a rate limit appearing during prompt entry prevents Send and blocks later startups", async (t) => {
  const { service, browser, send } = createFixture(t)
  const first = await send("worker")
  browser.completeTurn(1, "first answer")
  await setImmediate()
  const page = browser.pages[0]!
  let rateLimitVisible = false
  const locator = page.locator.bind(page)
  t.mock.method(page, "locator", (selector: string) => {
    const result = locator(selector)
    if (selector === '[data-testid="modal-conversation-history-rate-limit"]')
      t.mock.method(result, "isVisible", async () => rateLimitVisible)
    return result
  })
  t.mock.method(page.keyboard, "insertText", async () => {
    rateLimitVisible = true
  })

  await assert.rejects(send("worker"), { code: "SUBAGENT_RATE_LIMITED" })
  await assert.rejects(send("replacement"), { code: "SUBAGENT_RATE_LIMITED" })
  assert.equal(browser.submissions, 1)
  assert.equal(browser.pages.length, 1)
  assert.equal((await getAgentResponse(service, first, 0)).response, "first answer")
})

test("retains the latest 100 settled results per caller in completion order and preserves running turns", async (t) => {
  const { service, browser, send } = createFixture(t)
  const other = await runWithAgent("other-retention-caller", () => send("worker"))
  browser.completeTurn(1, "other caller")
  const slow = await send("slow")
  const active = await send("active")
  await assert.rejects(send("active"), { code: "AGENT_BUSY" })
  const turns: string[] = []

  for (let index = 1; index <= 100; index++) {
    turns.push(await send("worker"))
    browser.completeTurn(browser.submissions, `response ${index}`)
    await setImmediate()
  }
  browser.completeTurn(2, "finished later")
  const latest = await send("worker")
  browser.completeTurn(browser.submissions, "latest response")
  await setImmediate()

  for (const turn of turns.slice(0, 2)) {
    await assert.rejects(getAgentResponse(service, turn, 0), { code: "UNKNOWN_TURN" })
  }
  assert.equal((await getAgentResponse(service, turns[2]!, 0)).response, "response 3")
  assert.equal((await getAgentResponse(service, slow, 0)).response, "finished later")
  assert.equal((await getAgentResponse(service, latest, 0)).response, "latest response")
  assert.equal((await getAgentResponse(service, active, 0)).status, "running")
  assert.equal(
    (await runWithAgent("other-retention-caller", () => getAgentResponse(service, other, 0)))
      .response,
    "other caller"
  )
  await assert.rejects(getAgentResponse(service, other, 0), { code: "UNKNOWN_TURN" })
})

test("settled results expire after 24 hours; duplicate completions cannot change them", async (t) => {
  const { service, browser, send } = createFixture(t)
  const completed = await send("completed")
  const failed = await send("failed")
  const active = await send("active")
  browser.completeTurn(1, "done")
  await browser.pages[1]!.close()
  await advance(t, service.getAgentResponses([failed], 1_000))
  assert.equal((await getAgentResponse(service, failed, 0)).status, "failed")
  browser.completeTurn(1, "duplicate")
  browser.completeTurn(2, "too late")
  await setImmediate()
  assert.equal((await getAgentResponse(service, completed, 0)).response, "done")
  assert.equal((await getAgentResponse(service, failed, 0)).status, "failed")
  await assert.rejects(send("failed"), { code: "AGENT_BUSY" })

  // Advance retention's clock without firing idle browser cleanup for the active turn.
  t.mock.timers.setTime(Date.now() + 24 * 60 * 60_000)
  await assert.rejects(getAgentResponse(service, completed, 0), { code: "UNKNOWN_TURN" })
  await assert.rejects(getAgentResponse(service, failed, 0), { code: "UNKNOWN_TURN" })
  assert.equal((await getAgentResponse(service, active, 0)).status, "running")
})

test("runAgents waits for all submissions, preserves failures, and applies the existing pacing", async (t) => {
  const { service, browser } = createFixture(t)
  const submittedAt: number[] = []
  let resolved = false
  const batch = service
    .runAgents([
      { agentId: "first", prompt: "one" },
      { agentId: "first", prompt: "busy" },
      { agentId: "third", prompt: "three" },
    ])
    .then((turns) => {
      resolved = true
      return turns
    })
  let lastCount = 0
  const turns = await advance(t, batch, () => {
    if (browser.submissions > lastCount) {
      lastCount = browser.submissions
      submittedAt.push(Date.now())
      if (lastCount === 1) assert.equal(resolved, false)
    }
  })
  assert.deepEqual(
    turns.map((turn) => turn.status),
    ["running", "failed", "running"]
  )
  assert.ok(submittedAt[1]! - submittedAt[0]! >= 12_000)
  assert.equal(browser.submissions, 2)
  const ids = turns.flatMap((turn) => (turn.status === "running" ? [turn.turnId] : []))
  const results = await service.getAgentResponses(ids, 0)
  assert.ok(results.every((turn) => turn.status === "running" && !("error" in turn)))
})

test("cancelling batch pacing leaves submitted work running and skips remaining entries", async (t) => {
  const { service, browser } = createFixture(t)
  const controller = new AbortController()
  const results = await advance(
    t,
    service.runAgents(
      [
        { agentId: "first", prompt: "one" },
        { agentId: "second", prompt: "two" },
        { agentId: "third", prompt: "three" },
      ],
      { signal: controller.signal }
    ),
    () => {
      if (browser.submissions === 1) controller.abort()
    }
  )
  assert.equal(results.length, 2)
  assert.equal(results[0]!.status, "running")
  assert.equal(results[1]!.status, "failed")
  assert.equal(browser.submissions, 1)
  browser.completeTurn(1, "still completes")
  await setImmediate()
  assert.ok(results[0]?.status === "running")
  assert.equal((await getAgentResponse(service, results[0].turnId, 0)).response, "still completes")
})

test("result polling is concurrent, caller-scoped, and cancellation does not cancel generation", async (t) => {
  const { service, browser, send } = createFixture(t)
  const first = await send("first")
  const second = await send("second")
  const startedAt = Date.now()
  const results = await advance(t, service.getAgentResponses([first, "missing", second], 5_000))
  assert.deepEqual(
    results.map((turn) => turn.status),
    ["running", "failed", "running"]
  )
  assert.ok(Date.now() - startedAt < 10_000, "polls must share the wait period")
  const cancelled = await service.getAgentResponses([first], 5_000, AbortSignal.abort())
  assert.equal(cancelled[0]!.status, "failed")
  browser.completeTurn(1, "done after polling cancellation")
  await setImmediate()
  assert.equal(
    (await getAgentResponse(service, first, 0)).response,
    "done after polling cancellation"
  )
})

function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagent-lifecycle-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 })
  syncBuiltinESMExports()
  t.mock.method(console, "warn", () => {})
  const browser = browserFixture({ completeOnSubmit: false, stableUrlOnSubmit: true })
  t.mock.method(chromium, "connectOverCDP", async () => browser.browser)
  const service = createSubagents()
  t.after(async () => {
    await service.dispose()
    t.mock.timers.reset()
    syncBuiltinESMExports()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    service,
    browser,
    send: (agentId: string) => advance(t, sendAgentMessage(service, { agentId, prompt: "Work" })),
  }
}

/** Let real promise/CDP callbacks run between simulated timers; no production test hooks. */
async function advance<T>(t: TestContext, pending: Promise<T>, inspect?: () => void): Promise<T> {
  let done = false
  void pending
    .finally(() => {
      done = true
    })
    .catch(() => {})
  for (let step = 0; step < 100; step++) {
    if (done) break
    await setImmediate()
    inspect?.()
    if (!done) t.mock.timers.tick(500)
  }
  assert.ok(done, "operation did not finish within simulated time")
  return pending
}
