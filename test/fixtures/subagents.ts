import assert from "node:assert/strict"
import type {
  AgentCallContext,
  AgentRequest,
  AgentResponse,
  Subagents,
} from "../../src/tools/delegation/subagents.js"

export async function sendAgentMessage(
  service: Subagents,
  request: AgentRequest,
  context: AgentCallContext = {}
): Promise<string> {
  const [result] = await service.runAgents([request], context)
  assert.ok(result)
  if (result.status === "failed") throw result.error
  return result.turnId
}

export async function getAgentResponse(
  service: Subagents,
  turnId: string,
  waitMs: number,
  signal?: AbortSignal
): Promise<AgentResponse> {
  const [result] = await service.getAgentResponses([turnId], waitMs, signal)
  assert.ok(result)
  if ("error" in result) throw result.error
  return result
}

/** Wire-adapter tests supply domain outcomes; scheduling is tested against createSubagents. */
export function stubSubagents(operations: {
  send: (request: AgentRequest, context: AgentCallContext) => Promise<string>
  read: (turnId: string) => Promise<AgentResponse>
  drainEvents?: () => string[]
}): Subagents {
  return {
    runAgents: (requests, context = {}) =>
      Promise.all(
        requests.map(async (request) => {
          try {
            return {
              agentId: request.agentId,
              status: "running" as const,
              turnId: await operations.send(request, context),
            }
          } catch (error) {
            return { agentId: request.agentId, status: "failed" as const, error }
          }
        })
      ),
    getAgentResponses: (turnIds) =>
      Promise.all(
        turnIds.map(async (turnId) => {
          try {
            return { turnId, ...(await operations.read(turnId)) }
          } catch (error) {
            return { turnId, status: "failed" as const, error }
          }
        })
      ),
    drainEvents: operations.drainEvents ?? (() => []),
    dispose: async () => {},
  }
}
