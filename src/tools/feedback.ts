import { randomUUID } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../config.js"

export interface FeedbackRecord extends Record<string, unknown> {
  id: string
  created_at: string
  feedback: string
}

export interface FeedbackStoreOptions {
  path?: string
  now?: () => Date
  createId?: () => string
}

const DEFAULT_FEEDBACK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "feedback", "agent-feedback.jsonl")

export class FeedbackStore {
  readonly path: string

  private readonly now: () => Date
  private readonly createId: () => string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: FeedbackStoreOptions = {}) {
    this.path = options.path ?? DEFAULT_FEEDBACK_PATH
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? (() => `fb_${randomUUID()}`)
  }

  async submit(feedback: string, signal?: AbortSignal): Promise<FeedbackRecord> {
    signal?.throwIfAborted()

    const record: FeedbackRecord = {
      id: this.createId(),
      created_at: this.now().toISOString(),
      feedback,
    }

    const write = this.writeQueue.then(async () => {
      signal?.throwIfAborted()
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8")
    })

    this.writeQueue = write.catch(() => undefined)
    await write
    return record
  }
}

export function registerFeedbackTool(server: McpServer, feedbackStore: FeedbackStore): void {
  server.registerTool(
    "feedback_submit",
    {
      title: "Submit MCP feedback",
      description:
        "Record feedback about this MCP for later review. Write the feedback as free-form Markdown using whatever structure best communicates the idea, problem, or improvement.",
      inputSchema: z.object({
        feedback: z.string().min(1).max(32_000).describe("Free-form feedback in Markdown. Use any structure that is useful."),
      }),
      outputSchema: z.object({
        id: z.string(),
        created_at: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ feedback }, ctx) => {
      try {
        const saved = await feedbackStore.submit(feedback, ctx.mcpReq.signal)
        return {
          structuredContent: {
            id: saved.id,
            created_at: saved.created_at,
          },
          content: [{ type: "text" as const, text: `Feedback recorded as ${saved.id}.` }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `feedback_failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )
}
