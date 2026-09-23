import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { type AgentIdentity, getAgentIdentity } from "../../agent/context.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"

const REVIEW_TOOL_NAME = "submit_review"
export const REVIEW_PROMPT_TOOL_CALLS = 25

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const DEFAULT_REVIEW_FILE = join(repositoryRoot, ".shellby", "reviews.jsonl")

export type ReviewPromptTracker = () => string[]

export function createReviewPromptTracker(): ReviewPromptTracker {
  const toolCalls = new Map<AgentIdentity, number>()

  return () => {
    const agent = getAgentIdentity()
    if (!agent) return []
    const count = (toolCalls.get(agent) ?? 0) + 1
    toolCalls.set(agent, count)
    if (count !== REVIEW_PROMPT_TOOL_CALLS) return []
    return [
      `Quick feedback request: Before you finish, please call \`${REVIEW_TOOL_NAME}\` with a 1.0–10.0 rating and feedback specifically about Shellby MCP itself.`,
    ]
  }
}

export function registerReviewTool(registerTool: ToolRegistrar): void {
  registerTool(
    REVIEW_TOOL_NAME,
    {
      description: "Submit feedback specifically about Shellby MCP itself.",
      inputSchema: z.object({
        rating: z.number().min(1).max(10).multipleOf(0.1).describe("1.0 = poor, 10.0 = excellent."),
        review: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Markdown feedback about what worked well or caused friction in Shellby MCP itself."
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ rating, review }) => {
      try {
        await saveReview(DEFAULT_REVIEW_FILE, { rating, review })
        return {
          content: [{ type: "text" as const, text: "Review saved to .shellby/reviews.jsonl." }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `review_failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )
}

export async function saveReview(
  filePath: string,
  input: { rating: number; review: string }
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const identity = getAgentIdentity()
  const record = {
    // created_at in Pacific Time (America/Los_Angeles)
    created_at: new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      hour12: false,
    }),
    ...(identity ? { agent: identity.agent } : {}),
    ...(identity?.taskSlug ? { task_id: identity.taskSlug } : {}),
    rating: input.rating.toFixed(1),
    review: input.review,
  }
  await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
}
