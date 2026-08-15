import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ChatGptSubagentError, type ChatGptSubagentService } from "./chatgpt-subagent-contracts.js"

const SUBAGENT_RUN_DELAYS_MS = [0, 5_000, 7_000] as const

const subagentRequestSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > 0, "agent_id cannot be only whitespace.")
    .transform((value) => value.trim())
    .describe(
      "Short task or role label for a persistent subagent, such as architecture-reviewer. Use to retain conversation context, or use a different ID for concurrent work."
    ),
  prompt: z.string().min(1).describe("Task or next message to send to the subagent."),
  oververbosity: z
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe(
      "Response verbosity for a new subagent conversation, from 1 to 5. Defaults to 2. Applied only when this agent_id is first created; later values do not change that conversation."
    ),
})

const subagentRunResultSchema = z.object({
  agent_id: z.string(),
  turn_id: z.string().optional().describe("Short operation ID, unique within this subagent. Use with subagent_result to retrieve this exact turn."),
  status: z.enum(["running", "failed"]),
  error: z.string().optional(),
})

const subagentResultSchema = z.object({
  turn_id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  activity: z
    .enum(["Working", "Searching the web", "Using tools", "Generating response"])
    .optional()
    .describe("Current coarse activity while status is running."),
  activity_age_ms: z.int().nonnegative().optional().describe("Milliseconds since the last observable subagent progress while status is running."),
  response: z.string().optional(),
  error: z.string().optional(),
})

export function registerSubagentTools(server: McpServer, chatGptSubagents: ChatGptSubagentService): void {
  server.registerTool(
    "subagent_run",
    {
      title: "Run ChatGPT subagent tasks",
      description:
        "Execute one task or a parallel task batch in named persistent ChatGPT subagents. Reuse agent_id to retain conversation context. Retrieve returned turn_ids with subagent_result.",
      inputSchema: z.object({
        agents: z
          .array(subagentRequestSchema)
          .min(1)
          .max(3)
          .refine((agents) => new Set(agents.map((agent) => agent.agent_id)).size === agents.length, "agent_id values must be unique within a batch."),
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
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ agents }, ctx) => {
      const turns: Array<z.infer<typeof subagentRunResultSchema>> = []

      for (let index = 0; index < agents.length; index += 1) {
        const agent = agents[index]
        if (!agent) continue

        if (index > 0) {
          try {
            await delay(SUBAGENT_RUN_DELAYS_MS[index] ?? 0, ctx.mcpReq.signal)
          } catch (error) {
            turns.push(runFailure(agent.agent_id, error))
            break
          }
        }

        try {
          const result = await chatGptSubagents.ask({ agentId: agent.agent_id, prompt: agent.prompt, oververbosity: agent.oververbosity }, ctx.mcpReq.signal)
          turns.push({
            agent_id: result.agentId,
            turn_id: result.turnId,
            status: result.status,
          })
        } catch (error) {
          turns.push(runFailure(agent.agent_id, error))
        }
      }

      return {
        structuredContent: { turns },
        content: [{ type: "text" as const, text: `Submitted ${turns.length} ChatGPT subagent turn${turns.length === 1 ? "" : "s"}.` }],
      }
    }
  )

  server.registerTool(
    "subagent_result",
    {
      title: "Get ChatGPT subagent turn results",
      description:
        "Retrieve previously submitted subagent turns concurrently. Pass the `turn_ids` returned by `subagent_run`. A turn may still report running when checked early; result retrieval reconciles running state against the actual ChatGPT page. Local turn/runtime state expires after 30 minutes without observable progress; the ChatGPT conversation itself is not deleted.",
      inputSchema: z.object({
        turn_ids: z
          .array(z.string().min(1).max(128))
          .min(1)
          .max(3)
          .describe("Turn IDs returned by subagent_run calls. Use to retrieve the exact submitted turns concurrently."),
        wait_ms: z.int().min(0).max(60_000).default(0).describe("How long this check may wait for completion. Use 0 for an immediate status check."),
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
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ turn_ids, wait_ms }, ctx) => {
      const results = await Promise.all(
        turn_ids.map(async (turnId) => {
          try {
            const result = await chatGptSubagents.poll(turnId, wait_ms, ctx.mcpReq.signal)
            return {
              turn_id: result.turnId,
              status: result.status,
              activity: result.activity,
              activity_age_ms: result.activityAgeMs,
              response: result.response,
              error:
                result.status === "failed" ? `${result.errorCode ?? "subagent_failed"}: ${result.errorMessage ?? "ChatGPT subagent turn failed."}` : undefined,
            }
          } catch (error) {
            return {
              turn_id: turnId,
              status: "failed" as const,
              error: subagentErrorText(error),
            }
          }
        })
      )

      return {
        structuredContent: { turns: results },
        content: [{ type: "text" as const, text: `Retrieved ${results.length} ChatGPT subagent turn result${results.length === 1 ? "" : "s"}.` }],
      }
    }
  )
}

function runFailure(agentId: string, error: unknown): z.infer<typeof subagentRunResultSchema> {
  return {
    agent_id: agentId,
    status: "failed",
    error: subagentErrorText(error),
  }
}

function subagentErrorText(error: unknown): string {
  return error instanceof ChatGptSubagentError
    ? `${error.code}: ${error.message}`
    : `subagent_failed: ${error instanceof Error ? error.message : String(error)}`
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
