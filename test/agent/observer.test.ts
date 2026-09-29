import assert from "node:assert/strict"
import test from "node:test"
import type { AgentIdentity } from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"

test("retains bounded final response text and metadata without binary payloads", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "responses", agent: "agent-responses" }
  const callId = observer.startTool(agent, "asset", {})
  observer.finishTool(agent, callId, {
    content: [
      { type: "text", text: "Actual output\n\n**Notice:** Keep going" },
      { type: "image", mimeType: "image/png", data: "PRIVATE_BASE64" },
      {
        type: "resource",
        resource: { uri: "file:///fixture", mimeType: "application/pdf", blob: "PRIVATE_BLOB" },
      },
    ],
    structuredContent: { count: 2, data: "Ordinary structured data" },
  })
  const response = observer.listAgents()[0]?.recent[0]?.response ?? ""
  assert.match(response, /Actual output\n\n\*\*Notice:\*\* Keep going/u)
  assert.match(response, /image\/png/u)
  assert.match(response, /"count": 2/u)
  assert.match(response, /Ordinary structured data/u)
  assert.doesNotMatch(response, /PRIVATE_BASE64|PRIVATE_BLOB/u)

  const largeCall = observer.startTool(agent, "large", {})
  observer.failTool(agent, largeCall, {
    isError: true,
    content: [{ type: "text", text: "x".repeat(40_000) }],
  })
  const large = observer.listAgents()[0]?.recent[0]
  assert.equal(large?.status, "failed")
  assert.ok((large?.response?.length ?? 0) < 33_000)
  assert.match(large?.response ?? "", /Dashboard output truncated/u)
})

test("tracks current and recent tool activity for one agent", () => {
  let timestamp = 1_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "dashboard" }

  const callId = observer.startTool(agent, "shell_run", { command: "npm test" })
  assert.ok(callId)
  assert.deepEqual(observer.listAgents()[0]?.current, {
    id: callId,
    tool: "shell_run",
    summary: "npm test",
    detail: "npm test",
    detailLanguage: "bash",
    startedAt: 1_000,
    status: "running",
  })

  timestamp = 1_500
  observer.finishTool(agent, callId)
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.current, undefined)
  assert.equal(snapshot?.recent[0]?.status, "completed")
  assert.equal(snapshot?.recent[0]?.finishedAt, 1_500)
})

test("queues and delivers steering instructions once", () => {
  let timestamp = 2_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", taskSlug: "dashboard" }

  observer.startTool(agent, "shell_run", { command: "npm test" })
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

  observer.startTool(agent, "shell_run", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Do not run tests")
  assert.ok(instruction)
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), true)
  assert.deepEqual(observer.drainInstructions(agent), [])
  assert.deepEqual(observer.listAgents()[0]?.instructions, [])
})

test("does not cancel an instruction after it is delivered", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  observer.startTool(agent, "shell_run", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Keep going")
  assert.ok(instruction)
  assert.deepEqual(observer.drainInstructions(agent), ["Human instruction: Keep going"])
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), false)
})

test("keeps steering instructions scoped to the intended agent", () => {
  const observer = createAgentObserver()
  const first: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }
  const second: AgentIdentity = { sessionId: "session-b", agent: "agent-2" }

  observer.startTool(first, "shell_run", { command: "pwd" })
  observer.startTool(second, "shell_run", { command: "pwd" })
  observer.queueInstruction("agent-2", "Second agent only")

  assert.deepEqual(observer.drainInstructions(first), [])
  assert.deepEqual(observer.drainInstructions(second), ["Human instruction: Second agent only"])
})

test("emits snapshots when agent state changes", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }
  const events: string[] = []
  const unsubscribe = observer.subscribe((event) => events.push(`${event.type}:${event.agent.id}`))

  const callId = observer.startTool(agent, "fetch_url", { url: "https://example.com" })
  observer.finishTool(agent, callId)
  unsubscribe()

  assert.deepEqual(events, ["agent_changed:agent-1", "agent_changed:agent-1"])
})

test("keeps concurrent tool calls from the same agent", () => {
  let timestamp = 3_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1" }

  const first = observer.startTool(agent, "shell_run", { command: "npm test" })
  timestamp = 3_100
  const second = observer.startTool(agent, "fetch_url", { url: "https://example.com" })
  assert.equal(observer.listAgents()[0]?.current?.id, second)

  timestamp = 3_200
  observer.finishTool(agent, second)
  assert.equal(observer.listAgents()[0]?.current?.id, first)

  timestamp = 3_300
  observer.finishTool(agent, first)
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.current, undefined)
  assert.deepEqual(
    snapshot?.recent.map((call) => call.id),
    [first, second]
  )
})
