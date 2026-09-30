import assert from "node:assert/strict"
import test from "node:test"
import {
  type AgentIdentity,
  bindAgentParent,
  getAgentIdentity,
  runWithAgent,
} from "../../src/agent/context.js"
import { type AgentObserver, createAgentObserver } from "../../src/agent/observer.js"
import { ToolCallTracker } from "../../src/mcp/tool-call-tracker.js"
import { countTokens } from "../../src/tokenizer.js"
import { publishCall } from "../fixtures/tool-call.js"

test("publishes cumulative token totals beyond recent history, including concurrent calls", () => {
  const observer = createAgentObserver()
  const updates: ReturnType<AgentObserver["listAgents"]> = []
  const unsubscribe = observer.subscribe(({ agent }) => updates.push(agent))
  const agent = runWithAgent("observer-token-totals", () => getAgentIdentity()!)
  const input = { command: "printf hello" }
  const output = "Full response, before preview truncation.\n".repeat(1_000)
  const inputTokens = countTokens(JSON.stringify(input))
  const outputTokens = countTokens(output)
  const pending = Array.from({ length: 15 }, () => {
    const tracker = new ToolCallTracker({ agentObserver: observer })
    runWithAgent(agent.sessionId, () =>
      tracker.startRequest({
        id: 1,
        method: "tools/call",
        params: { name: "shell_run", arguments: input },
      })
    )
    return tracker
  })
  assert.deepEqual(observer.listAgents()[0]?.toolUsage, {
    callCount: 15,
    inputTokens: inputTokens * 15,
    outputTokens: 0,
  })
  // Finish outside the originating context; attribution belongs to the registered call.
  runWithAgent("observer-unrelated-finisher", () => {
    for (const tracker of pending.reverse()) {
      tracker.respond({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: output }] },
      })
      tracker.finishRequest({ httpStatus: 200, state: "finished" })
    }
  })
  unsubscribe()
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.recent.length, 12)
  assert.equal(snapshot?.current, undefined)
  assert.match(snapshot?.recent[0]?.response ?? "", /Dashboard output truncated/u)
  assert.deepEqual(snapshot?.toolUsage, {
    callCount: 15,
    inputTokens: inputTokens * 15,
    outputTokens: outputTokens * 15,
  })
  assert.deepEqual(updates.at(-1)?.toolUsage, snapshot?.toolUsage)
  assert.deepEqual(updates[0]?.toolUsage, { callCount: 1, inputTokens, outputTokens: 0 })
})

test("publishes late parent links without inventing activity, and unsubscribes cleanly", (t) => {
  const observer = createAgentObserver()
  const parent = runWithAgent("observer-parent", () => getAgentIdentity()!)
  const child = runWithAgent("observer-child", () => getAgentIdentity()!)
  publishCall(observer, parent, "subagent_run", {}, 1_000)
  publishCall(observer, child, "shell_run", { command: "pwd" }, 2_000)
  const updates: ReturnType<AgentObserver["listAgents"]> = []
  const unsubscribe = observer.subscribe(({ agent }) => updates.push(agent))
  t.after(unsubscribe)
  assert.equal(observer.listAgents().find((agent) => agent.id === child.agent)?.parentId, undefined)

  bindAgentParent(child.sessionId, parent.sessionId)
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.id, child.agent)
  assert.equal(updates[0]?.parentId, parent.agent)
  assert.equal(updates[0]?.lastSeenAt, 2_000)
  assert.doesNotMatch(JSON.stringify(updates), /observer-parent|observer-child/u)
  bindAgentParent(child.sessionId, parent.sessionId)
  assert.equal(updates.length, 1, "Repeated evidence does not emit duplicate updates")
  unsubscribe()
  const ancestor = runWithAgent("observer-ancestor", () => getAgentIdentity()!)
  bindAgentParent(parent.sessionId, ancestor.sessionId)
  assert.equal(updates.length, 1)
  assert.equal(
    observer.listAgents().find((agent) => agent.id === parent.agent)?.parentId,
    ancestor.agent
  )
})

test("retains bounded final response text and metadata without binary payloads", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "responses", agent: "agent-responses" }
  const callId = publishCall(observer, agent, "asset", {})
  callId.finish({
    response: {
      content: [
        { type: "text", text: "Actual output\n\n**Notice:** Keep going" },
        { type: "image", mimeType: "image/png", data: "PRIVATE_BASE64" },
        {
          type: "resource",
          resource: { uri: "file:///fixture", mimeType: "application/pdf", blob: "PRIVATE_BLOB" },
        },
      ],
      structuredContent: { count: 2, data: "Ordinary structured data" },
    },
  })
  const response = observer.listAgents()[0]?.recent[0]?.response ?? ""
  assert.match(response, /Actual output\n\n\*\*Notice:\*\* Keep going/u)
  assert.match(response, /image\/png/u)
  assert.match(response, /"count": 2/u)
  assert.match(response, /Ordinary structured data/u)
  assert.doesNotMatch(response, /PRIVATE_BASE64|PRIVATE_BLOB/u)
  assert.equal(
    observer.listAgents()[0]?.recent[0]?.outputTokens,
    countTokens(
      `Actual output\n\n**Notice:** Keep going\n${JSON.stringify({ count: 2, data: "Ordinary structured data" })}`
    )
  )

  const largeCall = publishCall(observer, agent, "large", {})
  largeCall.finish({
    status: "failed",
    response: {
      isError: true,
      content: [{ type: "text", text: "x".repeat(40_000) }],
    },
  })
  const large = observer.listAgents()[0]?.recent[0]
  assert.equal(large?.status, "failed")
  assert.ok((large?.response?.length ?? 0) < 33_000)
  assert.match(large?.response ?? "", /Dashboard output truncated/u)
  assert.equal(large?.outputTokens, countTokens("x".repeat(40_000)))
  assert.notEqual(large?.outputTokens, countTokens(large?.response ?? ""))
})

test("tracks current and recent tool activity for one agent", () => {
  let timestamp = 1_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "dashboard" }

  const callId = publishCall(observer, agent, "shell_run", { command: "npm test" }, timestamp)
  assert.ok(callId)
  assert.deepEqual(observer.listAgents()[0]?.current, {
    id: callId.id,
    tool: "shell_run",
    summary: "npm test",
    detail: "npm test",
    detailLanguage: "bash",
    inputTokens: countTokens(JSON.stringify({ command: "npm test" })),
    startedAt: 1_000,
    status: "running",
  })

  timestamp = 1_500
  callId.finish({ finishedAt: timestamp })
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.current, undefined)
  assert.equal(snapshot?.recent[0]?.status, "completed")
  assert.equal(snapshot?.recent[0]?.finishedAt, 1_500)
  assert.equal(snapshot?.recent[0]?.outputTokens, undefined)
})

test("counts full input arguments and distinguishes empty output from unavailable output", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "empty-tokens", agent: "agent-empty" }
  const call = publishCall(observer, agent, "shell_run", { command: "" })
  assert.equal(observer.listAgents()[0]?.current?.inputTokens, countTokens('{"command":""}'))
  assert.equal(observer.listAgents()[0]?.current?.outputTokens, undefined)
  call.finish({ response: { content: [{ type: "text", text: "" }] } })
  assert.equal(observer.listAgents()[0]?.recent[0]?.outputTokens, 0)
})

test("queues and delivers steering instructions once", () => {
  let timestamp = 2_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "dashboard" }

  publishCall(observer, agent, "shell_run", { command: "npm test" }, timestamp)
  const instruction = observer.queueInstruction("agent-1", " Focus only on the dashboard. ")
  assert.equal(instruction?.message, "Focus only on the dashboard.")

  timestamp = 2_500
  assert.deepEqual(observer.drainInstructions(agent), [
    "Human instruction: Focus only on the dashboard.",
  ])
  assert.deepEqual(observer.drainInstructions(agent), [])
  assert.equal(observer.listAgents()[0]?.instructions[0]?.deliveredAt, 2_500)
})

test("cancels queued steering instructions before delivery", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  publishCall(observer, agent, "shell_run", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Do not run tests")
  assert.ok(instruction)
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), true)
  assert.deepEqual(observer.drainInstructions(agent), [])
  assert.deepEqual(observer.listAgents()[0]?.instructions, [])
})

test("does not cancel an instruction after it is delivered", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  publishCall(observer, agent, "shell_run", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Keep going")
  assert.ok(instruction)
  assert.deepEqual(observer.drainInstructions(agent), ["Human instruction: Keep going"])
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), false)
})

test("keeps steering instructions scoped to the intended agent", () => {
  const observer = createAgentObserver()
  const first: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }
  const second: AgentIdentity = { sessionId: "session-b", agent: "agent-2" }

  publishCall(observer, first, "shell_run", { command: "pwd" })
  publishCall(observer, second, "shell_run", { command: "pwd" })
  observer.queueInstruction("agent-2", "Second agent only")

  assert.deepEqual(observer.drainInstructions(first), [])
  assert.deepEqual(observer.drainInstructions(second), ["Human instruction: Second agent only"])
})

test("emits snapshots when agent state changes", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }
  const events: string[] = []
  const unsubscribe = observer.subscribe((event) => events.push(`${event.type}:${event.agent.id}`))

  const callId = publishCall(observer, agent, "fetch_url", { url: "https://example.com" })
  callId.finish()
  unsubscribe()

  assert.deepEqual(events, ["agent_changed:agent-1", "agent_changed:agent-1"])
})

test("keeps concurrent tool calls from the same agent", () => {
  let timestamp = 3_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  const first = publishCall(observer, agent, "shell_run", { command: "npm test" }, timestamp)
  timestamp = 3_100
  const second = publishCall(
    observer,
    agent,
    "fetch_url",
    { url: "https://example.com" },
    timestamp
  )
  assert.equal(observer.listAgents()[0]?.current?.id, second.id)

  timestamp = 3_200
  second.finish({ finishedAt: timestamp })
  assert.equal(observer.listAgents()[0]?.current?.id, first.id)

  timestamp = 3_300
  first.finish({ finishedAt: timestamp })
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.current, undefined)
  assert.deepEqual(
    snapshot?.recent.map((call) => call.id),
    [first.id, second.id]
  )
})
