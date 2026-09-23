import { recordToolError } from "../../server/audit/audit-request.js"
import type { ChatGptDelegationPollResult, ChatGptDelegationService } from "./contracts.js"

export interface DelegatedTurnResult {
  turn_id: string
  status: ChatGptDelegationPollResult["status"]
  activity?: ChatGptDelegationPollResult["activity"]
  activity_age_ms?: number
  response?: string
  error?: string
}

interface PollDelegatedTurnsOptions {
  service: ChatGptDelegationService
  turnIds: readonly string[]
  waitMs: number
  signal?: AbortSignal
  formatFailure: (result: ChatGptDelegationPollResult) => string
  formatError: (error: unknown) => string
}

/** Preserve every batch entry; any failed entry marks the MCP call as an error. */
export function delegatedTurnsResult<T extends { status: string }>(turns: T[]) {
  return {
    structuredContent: { turns },
    content: [],
    isError: turns.some((turn) => turn.status === "failed"),
  }
}

/** Poll delegated turns concurrently and project the service result into the shared MCP shape. */
export function pollDelegatedTurns(
  options: PollDelegatedTurnsOptions
): Promise<DelegatedTurnResult[]> {
  return Promise.all(
    options.turnIds.map(async (turnId) => {
      try {
        const result = await options.service.poll(turnId, options.waitMs, options.signal)
        if (result.status === "failed")
          recordToolError(
            `${result.errorCode ?? "subagent_failed"}: ${result.errorMessage ?? "Subagent turn failed."}`
          )
        return {
          turn_id: turnId,
          status: result.status,
          activity: result.activity,
          activity_age_ms: result.activityAgeMs,
          response: result.response,
          error: result.status === "failed" ? options.formatFailure(result) : undefined,
        }
      } catch (error) {
        recordToolError(error)
        return {
          turn_id: turnId,
          status: "failed" as const,
          error: options.formatError(error),
        }
      }
    })
  )
}
