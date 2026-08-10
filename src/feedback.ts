import { randomUUID } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type FeedbackType = "problem" | "improvement" | "feature_request" | "dream_feature"

export interface FeedbackSubmission {
  type: FeedbackType
  summary: string
  details: string
  relatedTool?: string
}

export interface FeedbackRecord extends Record<string, unknown> {
  id: string
  created_at: string
  type: FeedbackType
  summary: string
  details: string
  related_tool?: string
}

export interface FeedbackStoreOptions {
  path?: string
  now?: () => Date
  createId?: () => string
}

export const DEFAULT_FEEDBACK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "feedback", "agent-feedback.jsonl")

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

  async submit(input: FeedbackSubmission, signal?: AbortSignal): Promise<FeedbackRecord> {
    signal?.throwIfAborted()

    const record: FeedbackRecord = {
      id: this.createId(),
      created_at: this.now().toISOString(),
      type: input.type,
      summary: input.summary,
      details: input.details,
      ...(input.relatedTool ? { related_tool: input.relatedTool } : {}),
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
