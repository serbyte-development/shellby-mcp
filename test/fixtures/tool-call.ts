import type { AgentIdentity } from "../../src/agent/context.js"
import type { AgentObserver } from "../../src/agent/observer.js"
import {
  type CompletedToolCall,
  type ToolCallEvent,
  ToolCallTracker,
} from "../../src/mcp/tool-call-tracker.js"

type StartedCall = Extract<ToolCallEvent, { status: "running" }>
type Outcome = Pick<CompletedToolCall, "response"> &
  Partial<Pick<CompletedToolCall, "status" | "finishedAt">>

/** Dashboard fixtures use the real tracker; tests supply identity, time, and the final response. */
export function publishCall(
  observer: AgentObserver,
  agent: AgentIdentity,
  tool: string,
  input: unknown,
  startedAt: number = Date.now()
): StartedCall & { finish(outcome?: Outcome): void } {
  let started!: StartedCall
  let timestamp = startedAt
  let outcome: Outcome = {}
  const tracker = new ToolCallTracker(
    {
      agentObserver: {
        observeToolCall(event) {
          if (event.status === "running") {
            started = { ...event, agent }
            observer.observeToolCall(started)
          } else {
            observer.observeToolCall({ ...event, agent, ...outcome })
          }
        },
      },
    },
    () => timestamp
  )
  tracker.startRequest({ id: 1, method: "tools/call", params: { name: tool, arguments: input } })
  return {
    ...started,
    finish(next = {}) {
      outcome = next
      timestamp = outcome.finishedAt ?? Date.now()
      if (outcome.response === undefined)
        tracker.finishRequest({ httpStatus: 200, state: "finished" })
      else
        tracker.respond({
          jsonrpc: "2.0",
          id: 1,
          result: outcome.response as Record<string, unknown>,
        })
    },
  }
}
