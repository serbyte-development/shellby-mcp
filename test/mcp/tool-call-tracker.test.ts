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
  getAgentToolUsage,
  recordToolError,
  type ToolCallEvent,
  ToolCallTracker,
} from "../../src/mcp/tool-call-tracker.js"
import { createToolRegistrar } from "../../src/mcp/tool-registration-boundary.js"
import { countTokens } from "../../src/tokenizer.js"

test("counts full arguments and final response once for all consumers", (t) => {
  const events: ToolCallEvent[] = []
  const audits: CompletedToolCall[] = []
  const tracker = new ToolCallTracker({
    agentObserver: { observeToolCall: (call) => events.push(call) },
    auditLogger: { recordToolCall: (call) => audits.push(call), recordToolsList() {} },
  })
  const args = { command: "printf hello", cwd: "/workspace", max_output_tokens: 20_000 }
  const inputJson = t.mock.fn(() => args)
  tracker.startRequest({
    id: 1,
    method: "tools/call",
    params: { name: "shell_run", arguments: { toJSON: inputJson } },
  })
  const expectedInput = countTokens(JSON.stringify(args))
  assert.equal(events[0]?.inputTokens, expectedInput)

  const text = "Complete response, longer than the dashboard preview.\n".repeat(1_000)
  const structured = { status: "done", count: 1_000 }
  const outputJson = t.mock.fn(() => structured)
  const response = {
    content: [
      { type: "text", text },
      { type: "text", text: "Notice: additional context" },
      { type: "image", data: "binary", mimeType: "image/png" },
      { type: "audio", data: "binary", mimeType: "audio/wav" },
      {
        type: "resource",
        resource: { uri: "file:///asset", blob: "binary", mimeType: "application/pdf" },
      },
      { type: "resource", resource: { uri: "file:///note", text: "Resource text" } },
    ],
    structuredContent: { toJSON: outputJson },
  }
  tracker.respond({ jsonrpc: "2.0", id: 1, result: response })
  tracker.respond({ jsonrpc: "2.0", id: 1, result: response })
  tracker.finishRequest({ httpStatus: 200, state: "finished" })
  assert.equal(events[1], audits[0])
  assert.equal(audits[0]?.inputTokens, expectedInput)
  assert.equal(
    audits[0]?.outputTokens,
    countTokens(
      [
        text,
        "Notice: additional context",
        JSON.stringify(response.content[5]),
        JSON.stringify(structured),
      ].join("\n")
    )
  )
  assert.equal(inputJson.mock.callCount(), 1, "Input is measured only at registration")
  assert.equal(outputJson.mock.callCount(), 1, "Final output is measured only once")
})

test("token accounting failures do not interrupt tools or lose lifecycle events", (t) => {
  const warnings = t.mock.method(console, "warn", () => {})
  const events: ToolCallEvent[] = []
  const audits: CompletedToolCall[] = []
  const tracker = new ToolCallTracker({
    agentObserver: { observeToolCall: (call) => events.push(call) },
    auditLogger: { recordToolCall: (call) => audits.push(call), recordToolsList() {} },
  })
  const badJson = {
    toJSON() {
      throw new Error("Cannot serialize this value")
    },
  }
  tracker.startRequest({
    id: 1,
    method: "tools/call",
    params: { name: "custom", arguments: badJson },
  })
  tracker.respond({ jsonrpc: "2.0", id: 1, result: { structuredContent: badJson } })
  assert.equal(events.length, 2)
  assert.equal(events[1], audits[0])
  assert.equal(audits[0]?.status, "completed")
  assert.equal(audits[0]?.inputTokens, undefined)
  assert.equal(audits[0]?.outputTokens, undefined)
  assert.equal(warnings.mock.callCount(), 2)
})

test("counts usage once per agent across request trackers, including rejected attempts", () => {
  runWithAgent("call-count-first", () => {
    const agent = getAgentIdentity()!
    const empty = { callCount: 0, inputTokens: 0, outputTokens: 0 }
    assert.deepEqual(getAgentToolUsage(agent), empty)
    const tracker = new ToolCallTracker()
    const request = { id: 1, method: "tools/call", params: { name: "shell_list" } }
    const inputTokens = countTokens("{}")
    tracker.startRequest({ id: 0, method: "tools/list" })
    assert.deepEqual(getAgentToolUsage(agent), empty)
    tracker.startRequest(request)
    tracker.startRequest(request)
    const beforeResponse = getAgentToolUsage(agent)
    assert.deepEqual(beforeResponse, { callCount: 1, inputTokens, outputTokens: 0 })
    tracker.respond({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Rejected" } })
    tracker.respond({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Rejected" } })
    tracker.finishRequest({ httpStatus: 200, state: "finished" })
    tracker.finishRequest({ httpStatus: 200, state: "closed" })
    const outputTokens = countTokens("Rejected")
    assert.deepEqual(getAgentToolUsage(agent), { callCount: 1, inputTokens, outputTokens })
    assert.equal(beforeResponse.outputTokens, 0, "Previously returned snapshots stay unchanged")
    const nextRequest = new ToolCallTracker()
    nextRequest.startRequest(request)
    nextRequest.finishRequest({ httpStatus: 400, state: "finished" })
    const expected = { callCount: 2, inputTokens: inputTokens * 2, outputTokens }
    assert.deepEqual(getAgentToolUsage(agent), expected)
    runWithAgent("call-count-second", () => {
      const other = getAgentIdentity()!
      assert.deepEqual(getAgentToolUsage(other), empty)
      const independent = new ToolCallTracker()
      independent.startRequest(request)
      independent.finishRequest({ httpStatus: 200, state: "finished" })
      assert.deepEqual(getAgentToolUsage(other), { callCount: 1, inputTokens, outputTokens: 0 })
    })
    assert.deepEqual(getAgentToolUsage(agent), expected)
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
  assert.equal(audits[1]?.outputTokens, countTokens("Rejected by SDK"))
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
  assert.equal(audits[0]?.inputTokens, countTokens("{}"))
  assert.equal(audits[0]?.outputTokens, undefined)
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
