import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ChatGptSubagentError, type ChatGptSubagentService } from "./chatgpt-subagent.js"

export function registerSubagentTools(server: McpServer, chatGptSubagents: ChatGptSubagentService): void {
  server.registerTool(
    "chatgpt_subagent",
    {
      title: "Message a ChatGPT subagent",
      description:
        "Delegate or continue work with a ChatGPT subagent. Choose an agent_id, send a prompt, then poll the returned <agent_id>_turn_N turn_id with chatgpt_subagent_poll. Later calls with the same agent_id continue that conversation until its local state expires after 30 minutes idle.",
      inputSchema: z.object({
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
      }),
      outputSchema: z.object({
        agent_id: z.string(),
        turn_id: z.string(),
        status: z.literal("running"),
        submitted: z.literal(true),
        conversation_id: z.string().optional(),
        conversation_url: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ agent_id, prompt, oververbosity }, ctx) => {
      try {
        const result = await chatGptSubagents.ask({ agentId: agent_id, prompt, oververbosity }, ctx.mcpReq.signal)
        const structuredContent = {
          agent_id: result.agentId,
          turn_id: result.turnId,
          status: result.status,
          submitted: result.submitted,
          conversation_id: result.conversationId,
          conversation_url: result.conversationUrl,
        }
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `Submitted ChatGPT subagent turn ${result.turnId} for ${result.agentId}; use chatgpt_subagent_poll to check it.`,
            },
          ],
        }
      } catch (error) {
        return subagentToolError(error)
      }
    }
  )

  server.registerTool(
    "chatgpt_subagent_poll",
    {
      title: "Check a ChatGPT subagent turn status",
      description:
        "Check a previously submitted subagent turn. Use the <agent_id>_turn_N turn_id returned by chatgpt_subagent. Local completed-turn state expires with its agent after 30 minutes idle; the ChatGPT conversation itself is not deleted.",
      inputSchema: z.object({
        turn_id: z.string().min(1).max(128).describe("Turn to check, returned by chatgpt_subagent."),
        wait_ms: z.int().min(0).max(60_000).default(0).describe("How long this check may wait for completion. Use 0 for an immediate status check."),
      }),
      outputSchema: z.object({
        agent_id: z.string(),
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
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ turn_id, wait_ms }, ctx) => {
      try {
        const result = await chatGptSubagents.poll(turn_id, wait_ms, ctx.mcpReq.signal)
        const structuredContent = {
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
        }
        const text =
          result.status === "completed"
            ? (result.response ?? "ChatGPT subagent turn completed.")
            : result.status === "failed"
              ? `${result.errorCode ?? "subagent_failed"}: ${result.errorMessage ?? "ChatGPT subagent turn failed."}`
              : `ChatGPT subagent turn ${result.turnId} is still running: ${result.activity ?? "Working"}; last observable progress ${result.activityAgeMs ?? 0} ms ago.`
        return {
          structuredContent,
          content: [{ type: "text" as const, text }],
        }
      } catch (error) {
        return subagentToolError(error)
      }
    }
  )
}

function subagentToolError(error: unknown) {
  const text =
    error instanceof ChatGptSubagentError ? `${error.code}: ${error.message}` : `subagent_failed: ${error instanceof Error ? error.message : String(error)}`
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}
