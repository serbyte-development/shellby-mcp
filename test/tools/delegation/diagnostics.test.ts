import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import type { Page } from "playwright-core"
import { DelegationDiagnostics } from "../../../src/tools/delegation/diagnostics.js"

test("failure diagnostics correlate the operation, browser error, and page state without request secrets", async (t) => {
  const warn = t.mock.method(console, "warn", () => {})
  const page = pageFixture()
  const diagnostics = new DelegationDiagnostics("worker", {
    sessionId: "private-session-id",
    agent: "agent-1",
    taskSlug: "investigation",
  })
  diagnostics.watch(page)
  diagnostics.watch(page)
  diagnostics.stage("enter-prompt")
  page.emit("console", {
    type: () => "error",
    text: () =>
      "ReactRenderingError: example is not a function at https://chatgpt.com/app.js?token=secret-token",
  })
  page.emit("response", {
    url: () =>
      "https://user:secret-password@chatgpt.com/backend-api/me?token=secret-token#secret-hash",
    status: () => 403,
    request: () => ({
      resourceType: () => "fetch",
      postData: () => {
        throw new Error("Diagnostics must not read request bodies")
      },
    }),
  })
  diagnostics.submitted("worker_turn_1", "user-message-1")
  const error = new Error("Editor disappeared at http://127.0.0.1:9222.", {
    cause: new Error("Authorization: Bearer secret-auth"),
  })
  await diagnostics.failure(error)
  await diagnostics.failure(error)
  diagnostics.dispose()

  assert.equal(warn.mock.callCount(), 1)
  const line = String(warn.mock.calls[0]?.arguments[0])
  assert.ok(line.startsWith("[delegation] "))
  const report = JSON.parse(line.slice("[delegation] ".length))
  assert.equal(report.phase, "enter-prompt")
  assert.equal(report.agent_id, "worker")
  assert.equal(report.caller, "agent-1/investigation")
  assert.equal(report.submission_observed, true)
  assert.equal(report.turn_id, "worker_turn_1")
  assert.equal(report.pages[0].try_again_visible, true)
  assert.equal(report.pages[0].composer_visible, false)
  assert.equal(report.error.message, "Editor disappeared at http://127.0.0.1:9222/")
  assert.ok(
    report.recent_events.some((event: { event: string }) => event.event === "console.error")
  )
  assert.ok(report.recent_events.some((event: { status?: number }) => event.status === 403))
  assert.doesNotMatch(
    line,
    /secret-token|secret-password|secret-hash|secret-auth|private-session-id/u
  )
  assert.equal(page.listenerCount("response"), 0)
  assert.equal(page.listenerCount("console"), 0)
})

test("diagnostics bound a noisy browser's retained events", async (t) => {
  const warn = t.mock.method(console, "warn", () => {})
  const page = pageFixture()
  const diagnostics = new DelegationDiagnostics("worker", undefined)
  diagnostics.watch(page)
  for (let index = 0; index < 100; index++) {
    page.emit("console", { type: () => "error", text: () => `${index}: ${"x".repeat(5_000)}` })
  }
  await diagnostics.failure(new Error("Startup failed"))
  diagnostics.dispose()
  const line = String(warn.mock.calls[0]?.arguments[0])
  const report = JSON.parse(line.slice("[delegation] ".length))
  assert.ok(report.dropped_events >= 80)
  assert.equal(report.recent_events.length, 20)
  assert.ok(Buffer.byteLength(line) < 30_000)
})

test("a stuck page snapshot cannot indefinitely delay reporting or cleanup", async (t) => {
  const warn = t.mock.method(console, "warn", () => {})
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const page = pageFixture()
  t.mock.method(page, "evaluate", () => new Promise(() => {}))
  const diagnostics = new DelegationDiagnostics("worker", undefined)
  diagnostics.watch(page)
  const reporting = diagnostics.failure(new Error("Startup failed"))
  t.mock.timers.tick(1_000)
  await reporting
  diagnostics.dispose()
  const report = JSON.parse(String(warn.mock.calls[0]?.arguments[0]).slice("[delegation] ".length))
  assert.equal(report.pages[0].unavailable, "snapshot timed out")
})

test("successful operations stay quiet and release browser listeners", (t) => {
  const warn = t.mock.method(console, "warn", () => {})
  const page = pageFixture()
  const diagnostics = new DelegationDiagnostics("worker", undefined)
  diagnostics.watch(page)
  diagnostics.stage("submit-prompt")
  diagnostics.submitted("worker_turn_1", "user-message-1")
  diagnostics.dispose()
  assert.equal(warn.mock.callCount(), 0)
  assert.equal(page.eventNames().length, 0)
})

function pageFixture(): Page & EventEmitter {
  return Object.assign(new EventEmitter(), {
    url: () => "https://chatgpt.com/c/saved-conversation",
    isClosed: () => false,
    evaluate: async () => ({
      ready_state: "complete",
      composer_visible: false,
      try_again_visible: true,
    }),
  }) as unknown as Page & EventEmitter
}
