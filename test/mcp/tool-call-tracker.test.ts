import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { z } from "zod"

import { getAgentIdentity, runWithAgent, setAgentTaskSlug } from "../../src/agent/context.js"
import { ObservedMcpServer } from "../../src/mcp/observed-server.js"
import {
  type CompletedToolCall,
  getAgentToolCallCount,
  recordToolError,
  type ToolCallEvent,
  ToolCallTracker,
} from "../../src/mcp/tool-call-tracker.js"
import { createToolRegistrar } from "../../src/mcp/tool-registration-boundary.js"

test("counts each call once per agent across request trackers, including rejected attempts", () => {
  runWithAgent("call-count-first", () => {
    const agent = getAgentIdentity()!
    assert.equal(getAgentToolCallCount(agent), 0)
    const tracker = new ToolCallTracker()
    const request = { id: 1, method: "tools/call", params: { name: "shell_list" } }
    tracker.startRequest({ id: 0, method: "tools/list" })
    assert.equal(getAgentToolCallCount(agent), 0)
    tracker.startRequest(request)
    tracker.startRequest(request)
    assert.equal(getAgentToolCallCount(agent), 1)
    tracker.respond({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Rejected" } })
    tracker.finishRequest({ httpStatus: 200, state: "finished" })
    tracker.finishRequest({ httpStatus: 200, state: "closed" })
    assert.equal(getAgentToolCallCount(agent), 1)
    const nextRequest = new ToolCallTracker()
    nextRequest.startRequest(request)
    nextRequest.finishRequest({ httpStatus: 400, state: "finished" })
    assert.equal(getAgentToolCallCount(agent), 2)
    runWithAgent("call-count-second", () => {
      const other = getAgentIdentity()!
      assert.equal(getAgentToolCallCount(other), 0)
      const independent = new ToolCallTracker()
      independent.startRequest(request)
      independent.finishRequest({ httpStatus: 200, state: "finished" })
      assert.equal(getAgentToolCallCount(other), 1)
    })
    assert.equal(getAgentToolCallCount(agent), 2)
  })
})

test("one lifecycle correlates same-name batch responses and completes both consumers once", () => {
  const events: ToolCallEvent[] = []
  const audits: CompletedToolCall[] = []
  let now = 1_000
  const tracker = new ToolCallTracker(
    {
      agentObserver: { observeToolCall: (call) => events.push(call) },
      auditLogger: { recordToolCall: (call) => audits.push(call), recordToolsList() {} },
    },
    () => now
  )
  tracker.startRequest(
    [1, 2].map((id) => ({
      id,
      method: "tools/call",
      params: { name: "shell_list", arguments: { marker: id } },
    }))
  )
  now = 1_200
  tracker.respond({
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: "second" }] },
  })
  now = 1_500
  tracker.respond({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Rejected by SDK" } })
  tracker.respond({ jsonrpc: "2.0", id: 1, result: {} })
  tracker.finishRequest({ httpStatus: 200, state: "finished" })
  tracker.finishRequest({ httpStatus: 200, state: "closed" })
  assert.equal(events.length, 4)
  assert.equal(audits.length, 2)
  assert.equal(events[2], audits[0], "Both consumers receive the same completion")
  assert.equal(events[3], audits[1])
  assert.deepEqual(
    audits.map((call) => [call.input, call.status, call.finishedAt - call.startedAt]),
    [
      [{ marker: 2 }, "completed", 200],
      [{ marker: 1 }, "failed", 500],
    ]
  )
  assert.equal(audits[0]?.id, events[1]?.id)
  assert.equal(audits[1]?.id, events[0]?.id)
  assert.deepEqual(audits[1]?.response, {
    isError: true,
    content: [{ type: "text", text: "Rejected by SDK" }],
  })
})

test("retains undispatched HTTP failures and cannot reopen an ended request", () => {
  const audits: CompletedToolCall[] = []
  const tracker = new ToolCallTracker({
    auditLogger: {
      recordToolCall: (call) => audits.push(call),
      recordToolsList() {},
    },
  })
  const payload = { method: "tools/call", params: { name: "shell_list" } }
  tracker.startRequest(payload)
  tracker.finishRequest({ httpStatus: 400, state: "finished" })
  tracker.startRequest(payload)
  tracker.finishRequest({ httpStatus: 400, state: "closed" })
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.status, "failed")
  assert.equal(audits[0]?.httpStatus, 400)
  assert.equal(audits[0]?.response, undefined)
  assert.equal(audits[0]?.error, undefined, "Transport metadata does not invent a tool error")
})

test("a failed consumer does not prevent another consumer from recording the call", (t) => {
  const warnings = t.mock.method(console, "warn", () => {})
  const audits: CompletedToolCall[] = []
  const tracker = new ToolCallTracker({
    agentObserver: {
      observeToolCall() {
        throw new Error("Dashboard unavailable")
      },
    },
    auditLogger: { recordToolCall: (call) => audits.push(call), recordToolsList() {} },
  })
  tracker.startRequest({ id: 1, method: "tools/call", params: { name: "shell_list" } })
  tracker.respond({ jsonrpc: "2.0", id: 1, result: {} })
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.status, "completed")
  assert.equal(warnings.mock.callCount(), 2)
})

test("concurrent handlers retain their own original diagnostics and ignore late errors", {
  timeout: 10_000,
}, async (t) => {
  const audits: CompletedToolCall[] = []
  const tracker = new ToolCallTracker({
    auditLogger: {
      recordToolCall: (call) => audits.push(call),
      recordToolsList() {},
    },
  })
  const server = new ObservedMcpServer({ name: "diagnostics", version: "1" }, {}, tracker)
  const client = new Client({ name: "diagnostics-client", version: "1" })
  t.after(() => Promise.all([server.close(), client.close()]))
  let release!: () => void
  let entered!: () => void
  let releaseLate!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve
  })
  t.after(() => {
    release()
    releaseLate()
  })
  const register = createToolRegistrar(server, { structuredOutput: true })
  register("diagnostic", { inputSchema: z.object({ name: z.string() }) }, async ({ name }) => {
    if (name === "slow") {
      entered()
      await held
    }
    recordToolError(new Error(`${name} original error`))
    void late.then(() => recordToolError(new Error("late error")))
    return { isError: true, content: [{ type: "text", text: "Public guidance" }] }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  await runWithAgent("diagnostic-session", async () => {
    setAgentTaskSlug("diagnostics")
    const slow = client.callTool({ name: "diagnostic", arguments: { name: "slow" } })
    await started
    await client.callTool({ name: "diagnostic", arguments: { name: "fast" } })
    release()
    await slow
    releaseLate()
    await setImmediate()
  })
  assert.deepEqual(
    audits.map((call) => call.errors.map((error) => (error as Error).message)),
    [["fast original error"], ["slow original error"]]
  )
  assert.deepEqual(
    audits.map((call) => call.input),
    [{ name: "fast" }, { name: "slow" }]
  )
  assert.ok(audits.every((call) => JSON.stringify(call.response).includes("Public guidance")))
})
