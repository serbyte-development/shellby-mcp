import { z } from "zod"
import { MCP_CONFIG } from "../../config.js"
import { recordToolError } from "../../mcp/tool-call-tracker.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import { ChatGptDelegationError } from "./subagent-error.js"
import { agentActivities, agentResponseStatuses, type Subagents } from "./subagents.js"

const SUBAGENT_UNAVAILABLE_ERROR =
  "SUBAGENT_UNAVAILABLE: The subagent service is temporarily unavailable. Retry the same subagent call once. If it fails again, continue without delegation. Do not change the task or prompt as a workaround."
const SUBAGENT_FAILED_ERROR =
  "subagent_failed: The subagent failed unexpectedly. Continue the task without delegation."

// Reject obsolete fields instead of silently turning a requested fork into a fresh chat.
const subagentInputSchema = z.strictObject({
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > 0, "agent_id cannot be only whitespace.")
    .transform((value) => value.trim())
    .describe("Unique subagent agent ID. Reuse to continue it; use a new ID for independent work."),
  prompt: z
    .string()
    .refine((value) => value.trim().length > 0, "prompt cannot be only whitespace.")
    .transform((value) => value.trim())
    .describe("Instruction prompt or follow-up turn prompt."),
  start_from: z.string().trim().optional().describe("URL to use when given"),
})

const subagentRunResultSchema = z.object({
  agent_id: z.string(),
  turn_id: z
    .string()
    .optional()
    .describe(
      "Unique ID for one submitted turn. Pass it to subagent_result to retrieve that turn."
    ),
  status: z.enum(["running", "failed"]),
  error: z.string().optional(),
})

const subagentResultSchema = z.object({
  turn_id: z.string(),
  status: z.enum(agentResponseStatuses),
  activity: z
    .enum(agentActivities)
    .optional()
    .describe("Current coarse activity while status is running."),
  activity_age_ms: z
    .int()
    .nonnegative()
    .optional()
    .describe("Time since the last observable subagent progress while status is running."),
  response: z.string().optional(),
  error: z.string().optional(),
})

export function registerSubagentTools(registerTool: ToolRegistrar, subagents: Subagents): void {
  registerTool(
    "subagent_run",
    {
      description:
        "Submit 1-3 subagent tasks and continue working. Retrieve returned turn_id values with subagent_result.",
      inputSchema: z.object({
        agents: z
          .array(subagentInputSchema)
          .min(1)
          .max(3)
          .refine(
            (agents) => new Set(agents.map((agent) => agent.agent_id)).size === agents.length,
            "agent_id values must be unique."
          ),
      }),
      outputSchema: z.object({
        turns: z.array(subagentRunResultSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ agents }, ctx) => {
      const results = await subagents.runAgents(
        agents.map((agent) => ({
          agentId: agent.agent_id,
          prompt: agent.prompt,
          startSource: agent.start_from,
        })),
        { signal: ctx.mcpReq.signal }
      )
      const turns = results.map((result) =>
        result.status === "failed"
          ? runFailure(result.agentId, result.error)
          : { agent_id: result.agentId, turn_id: result.turnId, status: result.status }
      )

      return delegatedTurnsResult(turns)
    }
  )

  registerTool(
    "subagent_result",
    {
      description:
        "Retrieve status or results for 1-3 submitted subagent turns. Be patient, subagents may take up to 30 minutes to complete.",
      inputSchema: z.object({
        turn_ids: z
          .array(
            z
              .string()
              .max(128)
              .refine((value) => value.trim().length > 0, "turn_id cannot be only whitespace.")
              .transform((value) => value.trim())
          )
          .min(1)
          .max(3)
          .describe("turn_id values returned by subagent_run."),
        wait_ms: z
          .int()
          .min(0)
          .max(MCP_CONFIG.chatGpt.maxPollWaitMs)
          .default(MCP_CONFIG.chatGpt.defaultPollWaitMs)
          .describe("Returns immediately if completed."),
      }),
      outputSchema: z.object({
        turns: z.array(subagentResultSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ turn_ids, wait_ms }, ctx) => {
      const responses = await subagents.getAgentResponses(turn_ids, wait_ms, ctx.mcpReq.signal)
      const results = responses.map((result) => {
        let error: string | undefined
        if (result.status === "failed") {
          const retainedFailure = `${result.errorCode ?? "subagent_failed"}: ${result.errorMessage ?? "Subagent turn failed."}`
          recordToolError("error" in result ? result.error : retainedFailure)
          error =
            "error" in result
              ? subagentErrorText(result.error)
              : subagentFailureText(result.errorCode, result.errorMessage)
        }
        return {
          turn_id: result.turnId,
          status: result.status,
          activity: result.activity,
          activity_age_ms: result.activityAgeMs,
          response: result.response,
          error,
        }
      })

      return delegatedTurnsResult(results)
    }
  )
}

function runFailure(agentId: string, error: unknown): z.infer<typeof subagentRunResultSchema> {
  recordToolError(error)
  return {
    agent_id: agentId,
    status: "failed",
    error: subagentErrorText(error),
  }
}

function subagentErrorText(error: unknown): string {
  return error instanceof ChatGptDelegationError
    ? subagentFailureText(error.code, error.message)
    : SUBAGENT_FAILED_ERROR
}

function subagentFailureText(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "BROWSER_UNAVAILABLE":
    case "CHATGPT_NOT_AUTHENTICATED":
    case "CHATGPT_UI_CHANGED":
      return SUBAGENT_UNAVAILABLE_ERROR
    case "SUBAGENT_RATE_LIMITED":
      return "SUBAGENT_RATE_LIMITED: New subagent turns are temporarily rate limited. Existing turns remain available through subagent_result. Do not retry automatically."
    case "AGENT_TARGET_LOST":
      return "AGENT_TARGET_LOST: The subagent's execution state is no longer available. Start a new subagent with a new agent_id if delegation is still needed."
    case "REQUEST_ABORTED":
      return "REQUEST_ABORTED: The subagent request was cancelled. A submitted turn will not be retried automatically."
    case undefined:
    case "subagent_failed":
      return SUBAGENT_FAILED_ERROR
    default:
      return `${code}: ${message ?? "Subagent turn failed."}`
  }
}

/** Preserve every batch entry; any failed entry marks the MCP call as an error. */
export function delegatedTurnsResult<T extends { status: string }>(turns: T[]) {
  return {
    structuredContent: { turns },
    content: [],
    isError: turns.some((turn) => turn.status === "failed"),
  }
}
