import type { AgentIdentity } from "../../src/agent/context.js"
import type { AgentObserver } from "../../src/agent/observer.js"
import type { CompletedToolCall, ToolCallEvent } from "../../src/mcp/tool-call-tracker.js"

type StartedCall = Extract<ToolCallEvent, { status: "running" }>
let nextId = 0

/** Explicit lifecycle fixtures for dashboard projection tests; no request tracking. */
export function publishCall(
  observer: AgentObserver,
  agent: AgentIdentity,
  tool: string,
  input: unknown,
  startedAt: number = Date.now()
): StartedCall {
  const call: StartedCall = {
    id: `fixture-${++nextId}`,
    agent,
    tool,
    input,
    startedAt,
    status: "running",
  }
  observer.observeToolCall(call)
  return call
}

export function publishCompletion(
  observer: AgentObserver,
  call: StartedCall,
  outcome: Pick<CompletedToolCall, "response"> &
    Partial<Pick<CompletedToolCall, "status" | "finishedAt">> = {}
): void {
  observer.observeToolCall({
    ...call,
    status: "completed",
    finishedAt: Date.now(),
    errors: [],
    ...outcome,
  })
}
