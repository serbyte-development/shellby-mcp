import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ChatGptSubagentError, type ChatGptSubagentService } from "./chatgpt-subagent.js"

const SUBAGENT_START_DELAYS_MS = [0, 5_000, 7_000] as const

const subagentRequestSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > 0, "agent_id cannot be only whitespace.")
    .describe("Stable caller-chosen ID that identifies one persistent subagent conversation."),
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

const subagentStartResultSchema = z.object({
  agent_id: z.string(),
  turn_id: z.string().optional(),
  status: z.enum(["running", "failed"]),
  submitted: z.boolean(),
  conversation_id: z.string().optional(),
  conversation_url: z.string().optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
})

const subagentPollResultSchema = z.object({
  agent_id: z.string().optional(),
  turn_id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  activity: z
    .enum(["Working", "Searching the web", "Using tools", "Generating response"])
    .optional()
    .describe("Current coarse activity while status is running."),
  activity_age_ms: z.int().nonnegative().optional().describe("Milliseconds since the last observable subagent progress while status is running."),
  conversation_id: z.string().optional(),
  conversation_url: z.string().optional(),
  message_id: z.string().optional(),
  response: z.string().optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
})

export function registerSubagentTools(server: McpServer, chatGptSubagents: ChatGptSubagentService): void {
  server.registerTool(
    "subagent_start",
    {
      title: "Start ChatGPT subagents",
      description:
        "Delegate 1-3 independent tasks to ChatGPT subagents. Agents start in array order with natural staggered delays: first immediately, second 5 seconds later, third 7 seconds after that. Use distinct agent_id values for non-overlapping work, then poll the returned turn_ids together with subagent_poll. Reusing an existing agent_id continues that conversation until its local state expires after 30 minutes idle.",
      inputSchema: z.object({
        agents: z
          .array(subagentRequestSchema)
          .min(1)
          .max(3)
          .refine((agents) => new Set(agents.map((agent) => agent.agent_id)).size === agents.length, "agent_id values must be unique within a batch."),
      }),
      outputSchema: z.object({
        turns: z.array(subagentStartResultSchema),
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
      const turns: Array<z.infer<typeof subagentStartResultSchema>> = []

      for (let index = 0; index < agents.length; index += 1) {
        const agent = agents[index]
        if (!agent) continue

        if (index > 0) {
          try {
            await delay(SUBAGENT_START_DELAYS_MS[index] ?? 0, ctx.mcpReq.signal)
          } catch (error) {
            turns.push(startFailure(agent.agent_id, error))
            break
          }
        }

        try {
          const result = await chatGptSubagents.ask({ agentId: agent.agent_id, prompt: agent.prompt, oververbosity: agent.oververbosity }, ctx.mcpReq.signal)
          turns.push({
            agent_id: result.agentId,
            turn_id: result.turnId,
            status: result.status,
            submitted: result.submitted,
            conversation_id: result.conversationId,
            conversation_url: result.conversationUrl,
          })
        } catch (error) {
          turns.push(startFailure(agent.agent_id, error))
        }
      }

      return {
        structuredContent: { turns },
        content: [{ type: "text" as const, text: turns.map(startResultText).join("\n") }],
      }
    }
  )

  server.registerTool(
    "subagent_poll",
    {
      title: "Check ChatGPT subagent turn statuses",
      description:
        "Check 1-3 previously submitted subagent turns concurrently. Pass the turn_ids returned by subagent_start. Local completed-turn state expires with its agent after 30 minutes idle; the ChatGPT conversation itself is not deleted.",
      inputSchema: z.object({
        turn_ids: z.array(z.string().min(1).max(128)).min(1).max(3).describe("Turns to check concurrently, returned by subagent_start."),
        wait_ms: z.int().min(0).max(60_000).default(0).describe("How long this check may wait for completion. Use 0 for an immediate status check."),
      }),
      outputSchema: z.object({
        turns: z.array(subagentPollResultSchema),
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
              turn: {
                agent_id: result.agentId,
                turn_id: result.turnId,
                status: result.status,
                activity: result.activity,
                activity_age_ms: result.activityAgeMs,
                conversation_id: result.conversationId,
                conversation_url: result.conversationUrl,
                message_id: result.messageId,
                response: result.response,
                error_code: result.errorCode,
                error_message: result.errorMessage,
              },
              text: pollResultText(result),
            }
          } catch (error) {
            const details = subagentErrorDetails(error)
            return {
              turn: {
                turn_id: turnId,
                status: "failed" as const,
                error_code: details.code,
                error_message: details.message,
              },
              text: `${turnId}: ${details.code}: ${details.message}`,
            }
          }
        })
      )

      return {
        structuredContent: { turns: results.map((result) => result.turn) },
        content: [{ type: "text" as const, text: results.map((result) => result.text).join("\n\n") }],
      }
    }
  )
}

function startFailure(agentId: string, error: unknown): z.infer<typeof subagentStartResultSchema> {
  const details = subagentErrorDetails(error)
  return {
    agent_id: agentId,
    status: "failed",
    submitted: false,
    error_code: details.code,
    error_message: details.message,
  }
}

function startResultText(result: z.infer<typeof subagentStartResultSchema>): string {
  return result.status === "running"
    ? `Submitted ChatGPT subagent turn ${result.turn_id} for ${result.agent_id}; use subagent_poll to check it.`
    : `${result.agent_id}: ${result.error_code ?? "subagent_failed"}: ${result.error_message ?? "ChatGPT subagent start failed."}`
}

function pollResultText(result: Awaited<ReturnType<ChatGptSubagentService["poll"]>>): string {
  return result.status === "completed"
    ? (result.response ?? `ChatGPT subagent turn ${result.turnId} completed.`)
    : result.status === "failed"
      ? `${result.errorCode ?? "subagent_failed"}: ${result.errorMessage ?? "ChatGPT subagent turn failed."}`
      : `ChatGPT subagent turn ${result.turnId} is still running: ${result.activity ?? "Working"}; last observable progress ${result.activityAgeMs ?? 0} ms ago.`
}

function subagentErrorDetails(error: unknown): { code: string; message: string } {
  return error instanceof ChatGptSubagentError
    ? { code: error.code, message: error.message }
    : { code: "subagent_failed", message: error instanceof Error ? error.message : String(error) }
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
