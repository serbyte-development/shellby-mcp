import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { type AgentIdentity, getAgentIdentity } from "../../agent/context.js"
import { getAgentToolCallCount } from "../../mcp/tool-call-tracker.js"
import { ToolError } from "../../mcp/tool-error.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import { getTimeStamp } from "../../time.js"

const REVIEW_TOOL_NAME = "submit_review"
export const REVIEW_PROMPT_TOOL_CALLS = 25

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const DEFAULT_REVIEW_FILE = join(repositoryRoot, ".shellby", "reviews.jsonl")

const promptedAgents = new WeakSet<AgentIdentity>()

/** Ask once on an eligible response after enough calls, including rejected call attempts. */
export function reviewPrompt(): string[] {
  const agent = getAgentIdentity()
  if (
    !agent ||
    promptedAgents.has(agent) ||
    getAgentToolCallCount(agent) < REVIEW_PROMPT_TOOL_CALLS
  )
    return []
  promptedAgents.add(agent)
  return [
    `Quick feedback request: Before you finish, please call \`${REVIEW_TOOL_NAME}\` with a 1.0–10.0 rating and feedback specifically about Shellby MCP itself.`,
  ]
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
          content: [
            {
              type: "text" as const,
              text: "Thank you for your feedback! It helps us improve Shellby MCP.",
            },
          ],
        }
      } catch (error) {
        // biome-ignore lint/style/useErrorCause: ToolError forwards ErrorOptions from its third argument.
        throw new ToolError(
          "review_failed",
          error instanceof Error ? error.message : String(error),
          { cause: error }
        )
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
    created_at: getTimeStamp(),
    ...(identity ? { agent: identity.agent } : {}),
    ...(identity?.taskSlug ? { task_id: identity.taskSlug } : {}),
    rating: input.rating.toFixed(1),
    review: input.review,
  }
  await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
}
