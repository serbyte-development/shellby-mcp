import assert from "node:assert/strict"
import test from "node:test"
import { recordedCodeModeWait } from "./subagent-live-harness.js"

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
