import { asRecord } from "../../utils.js"
import type { ChatGptDelegationActivity } from "./contracts.js"

const LINE_SEPARATOR = /\r?\n/u

export interface ChatGptTurnCompletion {
  text: string
  conversationId?: string
  turnId?: string
}

interface NormalizedMessage {
  id?: string
  role?: string
  status?: string
  endTurn?: boolean | null
  recipient?: string | null
  text: string
}

/** Reconstruct the turn for an outgoing user-message ID, independent of composer text serialization. */
export class ChatGptTurnTracker {
  private sourceId?: string
  private sourceTurnId?: string
  private conversationId?: string
  private assistant?: NormalizedMessage
  private lastDeltaPath?: string
  private lastDeltaOperation?: string
  private complete = false

  constructor(
    private readonly submittedMessageId: string,
    private readonly onActivity?: (activity?: ChatGptDelegationActivity) => void,
    private readonly onConversationId?: (conversationId: string) => void
  ) {}

  ingestFrame(payloadData: string): ChatGptTurnCompletion | undefined {
    const parsed = tryParseJson(payloadData)
    if (parsed === undefined) return undefined
    let completion: ChatGptTurnCompletion | undefined

    visitObjects(parsed, (record) => {
      const topicId = stringValue(record.topic_id)
      const envelope = asRecord(record.payload)
      if (
        !topicId?.startsWith("conversation-turn-") ||
        envelope?.type !== "conversation-turn-stream"
      )
        return
      const payload = asRecord(envelope.payload)
      if (!payload) return

      if (payload.type === "done") {
        if (this.sourceId !== topicId) return
        this.captureConversationId(payload)
        this.complete = true
        completion = this.result() ?? completion
        return
      }
      if (payload.type !== "stream-item") return

      const encodedItem = stringValue(payload.encoded_item)
      if (!encodedItem) return
      completion =
        this.ingestStream(encodedItem, topicId, topicId.slice("conversation-turn-".length)) ??
        completion
    })

    return completion
  }

  ingestSse(text: string): ChatGptTurnCompletion | undefined {
    return this.ingestStream(text, "http")
  }

  private ingestStream(
    text: string,
    sourceId: string,
    turnId?: string
  ): ChatGptTurnCompletion | undefined {
    for (const item of parseResponsePayloads(text)) {
      const record = asRecord(item)
      if (!record) continue

      const value = asRecord(record.v)
      const message = value ? normalizeMessage(value) : undefined
      this.bindUserMessage(message, sourceId, turnId)

      const inputMessage = asRecord(record.input_message)
      const input = inputMessage ? normalizeMessage({ message: inputMessage }) : undefined
      this.bindUserMessage(input, sourceId, turnId)

      if (this.sourceId !== sourceId) continue
      this.captureConversationId(record)
      if (message) this.onActivity?.(classifyActivity(message))

      if (message?.role === "assistant") {
        this.assistant = { ...message }
        this.lastDeltaPath = undefined
        this.lastDeltaOperation = undefined
      }

      this.applyDelta(record)
      if (record.type === "message_stream_complete") this.complete = true
    }

    if (this.sourceId === sourceId && text.length > 0) this.onActivity?.()

    return this.result()
  }

  private bindUserMessage(
    message: NormalizedMessage | undefined,
    sourceId: string,
    turnId?: string
  ): void {
    if (message?.role === "user" && message.id === this.submittedMessageId) {
      this.bind(sourceId, turnId)
    }
  }

  private bind(sourceId: string, turnId?: string): void {
    if (this.sourceId) return
    this.sourceId = sourceId
    this.sourceTurnId = turnId
  }

  private captureConversationId(record: Record<string, unknown>): void {
    const conversationId = stringValue(record.conversation_id)
    if (this.conversationId || !conversationId) return
    this.conversationId = conversationId
    this.onConversationId?.(conversationId)
  }

  private applyDelta(delta: Record<string, unknown>): void {
    if (!this.assistant) return
    const explicitOperation = stringValue(delta.o)
    const operation = explicitOperation ? explicitOperation : this.lastDeltaOperation
    if (operation === "patch" && Array.isArray(delta.v)) {
      for (const nested of delta.v) {
        const record = asRecord(nested)
        if (record) this.applyDelta(record)
      }
      return
    }

    const explicitPath = stringValue(delta.p)
    const path = explicitPath ? explicitPath : this.lastDeltaPath
    if (explicitPath) this.lastDeltaPath = explicitPath
    if (explicitOperation) this.lastDeltaOperation = explicitOperation
    if (!path) return

    this.applyAssistantDelta(operation, path, delta.v)
  }

  private applyAssistantDelta(operation: string | undefined, path: string, value: unknown): void {
    if (!this.assistant) return
    const target = `${operation ?? ""}:${path}`
    if (target === "append:/message/content/parts/0" && typeof value === "string") {
      this.assistant.text += value
      this.onActivity?.("Generating response")
      return
    }
    if (target === "replace:/message/status" && typeof value === "string") {
      this.assistant.status = value
      return
    }
    if (target === "replace:/message/end_turn" && typeof value === "boolean") {
      this.assistant.endTurn = value
      return
    }
    if (target === "replace:/message/recipient" && (typeof value === "string" || value === null)) {
      this.assistant.recipient = value
    }
  }

  private result(): ChatGptTurnCompletion | undefined {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome misses mutation of completion state inside callback traversal.
    if (!this.complete || !this.sourceId || !this.assistant) return undefined
    if (this.assistant.status !== "finished_successfully" || this.assistant.endTurn !== true)
      return undefined
    if (this.assistant.recipient && this.assistant.recipient !== "all") return undefined
    if (!this.assistant.text) return undefined
    return {
      text: this.assistant.text,
      conversationId: this.conversationId,
      turnId: this.sourceTurnId,
    }
  }
}

function normalizeMessage(record: Record<string, unknown>): NormalizedMessage | undefined {
  const message = asRecord(record.message)
  if (!message) return undefined
  const author = asRecord(message.author)
  if (!author) return undefined
  return {
    id: stringValue(message.id),
    role: stringValue(author.role),
    status: stringValue(message.status),
    endTurn: nullableBoolean(message.end_turn),
    recipient: nullableString(message.recipient),
    text: extractMessageText(asRecord(message.content)),
  }
}

function extractMessageText(content?: Record<string, unknown>): string {
  if (!content) return ""
  if (Array.isArray(content.parts))
    return content.parts.filter((part): part is string => typeof part === "string").join("\n")
  return stringValue(content.text) ?? ""
}

function classifyActivity(message: NormalizedMessage): ChatGptDelegationActivity {
  const recipient = message.recipient?.toLowerCase()
  if (recipient && recipient !== "all")
    return recipient.includes("web") || recipient.includes("search")
      ? "Searching the web"
      : "Using tools"
  return message.role === "assistant" ? "Generating response" : "Working"
}

function parseResponsePayloads(text: string): unknown[] {
  const payloads: unknown[] = []
  for (const rawLine of text.split(LINE_SEPARATOR)) {
    const line = rawLine.trim()
    if (!line || line === "data: [DONE]") continue
    const candidate = line.startsWith("data:") ? line.slice(5).trim() : line
    const parsed = tryParseJson(candidate)
    if (parsed !== undefined) payloads.push(parsed)
  }
  return payloads
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function visitObjects(
  value: unknown,
  visitor: (record: Record<string, unknown>) => void,
  seen = new Set<object>()
): void {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, visitor, seen)
    return
  }
  const record = asRecord(value)
  if (!record) return
  visitor(record)
  for (const nested of Object.values(record)) visitObjects(nested, visitor, seen)
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  return typeof value === "boolean" || value === null ? value : undefined
}

function nullableString(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Identify the newly submitted user message in a conversation POST; ignore other actions. */
export function submittedUserMessageId(postData: string): string | undefined {
  const request = asRecord(tryParseJson(postData))
  if (request?.action !== "next" || !Array.isArray(request.messages)) return undefined
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(request.messages[index])
    if (asRecord(message?.author)?.role === "user") return stringValue(message?.id)
  }
  return undefined
}

export interface ConversationMessage {
  id?: string
  role: "user" | "assistant"
  text: string
}

export function findLatestAssistantAfterMessage(
  messages: readonly ConversationMessage[],
  submittedMessageId: string | undefined,
  expectedUserTurnCount: number
): ConversationMessage | undefined {
  if (!submittedMessageId) return undefined
  const userTurnCount = messages.filter((message) => message.role === "user").length
  if (userTurnCount !== expectedUserTurnCount) return undefined

  let promptIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user" && message.id === submittedMessageId) {
      promptIndex = index
      break
    }
  }
  if (promptIndex < 0) return undefined

  for (let index = messages.length - 1; index > promptIndex; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && message.text) return message
  }
  return undefined
}

/** Normalize conversation history for the one-shot recovery check and frozen fixtures. */
export function extractConversationMessages(payload: unknown): ConversationMessage[] {
  const root = asRecord(payload)
  if (Array.isArray(root?.messages))
    return root.messages
      .map(messageFromRaw)
      .filter((value): value is ConversationMessage => value !== undefined)
  const current = stringValue(root?.current_node)
  const mapping = asRecord(root?.mapping)
  if (!current || !mapping) return []
  const branch: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let id: string | undefined = current
  while (id && !seen.has(id)) {
    seen.add(id)
    const node = asRecord(mapping[id])
    if (!node) break
    branch.push(node)
    id = stringValue(node.parent)
  }
  return branch
    .reverse()
    .map((node) => messageFromRaw(node.message))
    .filter((value): value is ConversationMessage => value !== undefined)
}

function messageFromRaw(value: unknown): ConversationMessage | undefined {
  const message = asRecord(value)
  const author = asRecord(message?.author)
  const role = stringValue(author?.role)
  const text = extractMessageText(asRecord(message?.content))
  if (!text || (role !== "user" && role !== "assistant")) return undefined
  if (role === "assistant") {
    if (message?.end_turn !== true) return undefined
    const recipient = message.recipient
    if (recipient && recipient !== "all") return undefined
  }
  return { id: stringValue(message?.id), role, text }
}
