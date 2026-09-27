import assert from "node:assert/strict"
import test from "node:test"
import { recordedCodeModeWait, recordedCompletionLatency } from "./subagent-live-harness.js"

// This shape reflects live ChatGPT history: Code Mode bodies are redacted, but
// invocation/result identities and server timestamps survive reopening the chat.
const user = { id: "user", author: { role: "user" } }
const invocation = {
  id: "exec",
  author: { role: "assistant" },
  recipient: "functions.exec",
  create_time: 1_000,
  content: { parts: [""] },
}
const result = {
  id: "result",
  author: { role: "tool", name: "functions.exec" },
  create_time: 1_270.03,
  content: { parts: [""] },
  status: "finished_successfully",
  metadata: { parent_id: "exec" },
}

test("live wait evidence uses actual tool metadata when ChatGPT hides tool bodies", () => {
  const evidence = recordedCodeModeWait({ messages: [user, invocation, result] }, "user", 270_000)
  assert.equal(evidence.invocation_id, "exec")
  assert.equal(evidence.result_id, "result")
  assert.ok(Math.abs(evidence.elapsed_ms - 270_030) < 1)
})

test("a claimed wait cannot replace a real, sufficiently long, successful tool call", () => {
  const claim = { author: { role: "assistant" }, content: { parts: ["elapsed_ms: 270000"] } }
  assert.throws(
    () => recordedCodeModeWait({ messages: [user, claim] }, "user", 270_000),
    /actual Code Mode/u
  )
  for (const invalid of [
    { ...result, create_time: 1_001 },
    { ...result, create_time: undefined },
    { ...result, create_time: null },
    { ...result, id: undefined },
    { ...result, status: "failed" },
    { ...result, metadata: { parent_id: "unrelated" } },
  ]) {
    assert.throws(() =>
      recordedCodeModeWait({ messages: [user, invocation, invalid, claim] }, "user", 270_000)
    )
  }
})

test("reused conversations cannot borrow timer evidence from a different turn", () => {
  const other = { id: "other-user", author: { role: "user" } }
  assert.throws(
    () =>
      recordedCodeModeWait({ messages: [user, invocation, result, other] }, "other-user", 270_000),
    /actual Code Mode/u
  )
  assert.throws(
    () => recordedCodeModeWait({ messages: [user, other, invocation, result] }, "user", 270_000),
    /actual Code Mode/u
  )
})

const final = {
  id: "final-answer",
  author: { role: "assistant" },
  channel: "final",
  recipient: "all",
  status: "finished_successfully",
  end_turn: true,
  create_time: 990,
  update_time: 1_000,
}
const historyClock = {
  serverDate: new Date(1_030_000).toUTCString(),
  requestStartedAtMs: 1_030_400,
  responseReceivedAtMs: 1_030_600,
}

test("live completion latency uses the saved final update, accounting for clock skew and precision", () => {
  for (const offset of [0, 3_600_000, -600_000]) {
    const evidence = recordedCompletionLatency(
      { messages: [user, invocation, result, final] },
      "user",
      1_000_700 + offset,
      {
        ...historyClock,
        requestStartedAtMs: historyClock.requestStartedAtMs + offset,
        responseReceivedAtMs: historyClock.responseReceivedAtMs + offset,
      }
    )
    assert.equal(evidence.message_id, "final-answer")
    assert.equal(evidence.server_completed_at_ms, 1_000_000)
    assert.equal(evidence.minimum_latency_ms, 100)
    assert.equal(evidence.maximum_latency_ms, 1_300)
  }
  const slow = recordedCompletionLatency(
    { messages: [user, final] },
    "user",
    1_020_700,
    historyClock
  )
  assert.equal(slow.minimum_latency_ms, 20_100)
  assert.equal(slow.maximum_latency_ms, 21_300)
})

test("completion latency requires a genuine final answer and usable clock evidence", () => {
  for (const invalid of [
    { ...final, id: undefined },
    { ...final, author: { role: "tool" } },
    { ...final, channel: "analysis" },
    { ...final, recipient: "functions.exec" },
    { ...final, status: "in_progress" },
    { ...final, end_turn: false },
    { ...final, update_time: undefined },
    { ...final, update_time: null },
    { ...final, update_time: Number.NaN },
  ]) {
    assert.throws(() =>
      recordedCompletionLatency({ messages: [user, invalid] }, "user", 1_000_700, historyClock)
    )
  }
  for (const invalidClock of [
    { ...historyClock, serverDate: undefined },
    { ...historyClock, serverDate: "not a timestamp" },
    { ...historyClock, requestStartedAtMs: -1 },
    { ...historyClock, requestStartedAtMs: historyClock.responseReceivedAtMs + 1 },
    { ...historyClock, responseReceivedAtMs: Number.NaN },
  ]) {
    assert.throws(() =>
      recordedCompletionLatency({ messages: [user, final] }, "user", 1_000_700, invalidClock)
    )
  }
})

test("live completion timing cannot come from an earlier turn, later turn, or inactive branch", () => {
  const other = { id: "other-user", author: { role: "user" } }
  for (const messages of [
    [other, final, user],
    [user, other, final],
  ]) {
    assert.throws(() => recordedCompletionLatency({ messages }, "user", 1_000_700, historyClock))
  }
  const history = {
    current_node: "answer",
    mapping: {
      user: { message: user },
      answer: { message: final, parent: "user" },
      inactive: { message: { ...final, id: "wrong-answer", update_time: 500 }, parent: "user" },
    },
  }
  assert.equal(
    recordedCompletionLatency(history, "user", 1_000_700, historyClock).message_id,
    "final-answer"
  )
})
