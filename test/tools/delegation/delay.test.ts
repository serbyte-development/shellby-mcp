import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import test from "node:test"
import { ChatGptDelegationError } from "../../../src/tools/delegation/contracts.js"
import { delay } from "../../../src/tools/delegation/delay.js"

test("delay completes with and without a signal and removes its abort listener", async () => {
  await delay(1)
  const controller = new AbortController()
  await delay(1, controller.signal)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("delay rejects an already-cancelled request with the delegation error code", async () => {
  await assert.rejects(delay(60_000, AbortSignal.abort()), {
    name: "ChatGptDelegationError",
    code: "REQUEST_ABORTED",
  })
})

test("cancelling a pending delay rejects and removes its abort listener", async () => {
  const controller = new AbortController()
  const pending = delay(60_000, controller.signal)
  controller.abort()
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ChatGptDelegationError && error.code === "REQUEST_ABORTED"
  )
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})
