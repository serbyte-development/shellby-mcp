import { asRecord, booleanValue, finiteNumber as numberValue } from "../../utils.js"
import type { ChatGptConversationMessage, ChatGptSubagentActivity } from "./chatgpt-subagent-contracts.js"

export interface TrackedConversationNode {
  id: string
  parent?: string
  children: string[]
  message: {
    id: string
    role?: string
    status?: string
    endTurn?: boolean | null
    recipient?: string | null
    createTime?: number
    text: string
    turnExchangeId?: string
    workingTurnId?: string
    isComplete?: boolean
  }
}

export class ChatGptStructuredTurnTracker {
  private topicId?: string
  private assistant?: TrackedConversationNode
  private assistantSource?: string
  private lastDeltaPath?: string
  private lastDeltaOperation?: string
  private directBound = false
  private readonly completionSources = new Set<string>()

  constructor(
    private readonly prompt: string,
    private readonly onActivity?: (activity: ChatGptSubagentActivity) => void
  ) {}

  ingestFrame(payloadData: string): string | undefined {
    const parsed = tryParseJson(payloadData)
    if (parsed === undefined) return undefined
    let response: string | undefined

    visitObjects(parsed, (record) => {
      const topicId = stringValue(record.topic_id)
      const envelope = asRecord(record.payload)
      if (!topicId?.startsWith("conversation-turn-") || envelope?.type !== "conversation-turn-stream") return
      const payload = asRecord(envelope.payload)
      if (!payload) return

      if (payload.type === "done") {
        if (this.topicId === topicId) {
          this.completionSources.add(topicId)
          response = this.finalAssistantText(topicId) ?? response
        }
        return
      }
      if (payload.type !== "stream-item") return

      const encodedItem = stringValue(payload.encoded_item)
      if (!encodedItem) return
      response = this.ingestStream(encodedItem, topicId) ?? response
    })

    return response
  }

  ingestSse(text: string): string | undefined {
    return this.ingestStream(text, "http")
  }

  private ingestStream(text: string, source: string): string | undefined {
    let assistantChanged = false
    let completionSignal = false

    for (const item of parseResponsePayloads(text)) {
      const itemRecord = asRecord(item)
      if (!itemRecord) continue
      const deltaValue = asRecord(itemRecord.v)
      const node = deltaValue ? normalizeConversationNode(deltaValue) : undefined
      if (node?.message.role === "user" && node.message.text.trim() === this.prompt.trim()) this.bindSource(source)

      const inputMessage = asRecord(itemRecord.input_message)
      const inputNode = inputMessage ? normalizeConversationNode({ message: inputMessage }) : undefined
      if (inputNode?.message.role === "user" && inputNode.message.text.trim() === this.prompt.trim()) this.bindSource(source)

      if (!this.isSourceBound(source)) continue
      this.onActivity?.(node ? classifyActivity(node) : "Working")
      if (node?.message.role === "assistant") {
        this.assistant = node
        this.assistantSource = source
        this.lastDeltaPath = undefined
        this.lastDeltaOperation = undefined
        assistantChanged = true
      }
      assistantChanged = this.applyDelta(itemRecord, source) || assistantChanged
      if (itemRecord.type === "message_stream_complete") completionSignal = true
    }

    if (completionSignal) this.completionSources.add(source)
    if (!assistantChanged && !completionSignal) return undefined
    return this.finalAssistantText(source)
  }

  private bindSource(source: string): void {
    if (source === "http") this.directBound = true
    else this.topicId = source
  }

  private isSourceBound(source: string): boolean {
    return source === "http" ? this.directBound : this.topicId === source
  }

  private applyDelta(delta: Record<string, unknown>, source: string): boolean {
    if (!this.assistant || this.assistantSource !== source) return false
    const explicitOperation = stringValue(delta.o)
    const operation = explicitOperation || this.lastDeltaOperation
    if (operation === "patch" && Array.isArray(delta.v)) {
      let changed = false
      for (const nested of delta.v) {
        const record = asRecord(nested)
        if (record) changed = this.applyDelta(record, source) || changed
      }
      return changed
    }

    const explicitPath = stringValue(delta.p)
    const path = explicitPath || this.lastDeltaPath
    if (explicitPath) this.lastDeltaPath = explicitPath
    if (explicitOperation) this.lastDeltaOperation = explicitOperation
    if (!path) return false

    if (operation === "append" && path === "/message/content/parts/0" && typeof delta.v === "string") {
      this.assistant.message.text += delta.v
      this.onActivity?.("Generating response")
      return true
    }
    if (operation === "replace" && path === "/message/status" && typeof delta.v === "string") {
      this.assistant.message.status = delta.v
      return true
    }
    if (operation === "replace" && path === "/message/end_turn" && typeof delta.v === "boolean") {
      this.assistant.message.endTurn = delta.v
      return true
    }
    return false
  }

  private finalAssistantText(source: string): string | undefined {
    if (!this.completionSources.has(source)) return undefined
    if (!this.assistant || this.assistantSource !== source || !isFinalAssistantNode(this.assistant)) return undefined
    return this.assistant.message.text
  }
}

export function findLatestAssistantAfterPrompt(messages: readonly ChatGptConversationMessage[], prompt?: string): ChatGptConversationMessage | undefined {
  if (messages.length === 0) return undefined
  const normalizedPrompt = prompt?.trim()
  let promptIndex = -1
  if (normalizedPrompt) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === "user" && message.text.trim() === normalizedPrompt) {
        promptIndex = index
        break
      }
    }
    if (promptIndex < 0) return undefined
  }

  for (let index = messages.length - 1; index > promptIndex; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && message.text) return message
  }
  return undefined
}

export function extractConversationNodes(payload: unknown): TrackedConversationNode[] {
  const nodes = new Map<string, TrackedConversationNode>()
  const visited = new Set<object>()

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return
    visited.add(value)
    const record = value as Record<string, unknown>
    const normalized = normalizeConversationNode(record)
    if (normalized) nodes.set(normalized.id, normalized)

    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const nested of Object.values(record)) visit(nested)
  }

  visit(payload)
  return [...nodes.values()]
}

export function extractConversationMessages(payload: unknown): ChatGptConversationMessage[] {
  const record = asRecord(payload)
  if (Array.isArray(record?.messages)) {
    const nodes = record.messages
      .map((message) => {
        const messageRecord = asRecord(message)
        return messageRecord ? normalizeConversationNode({ message: messageRecord }) : undefined
      })
      .filter((node): node is TrackedConversationNode => node !== undefined)
    return conversationMessages(nodes)
  }

  const currentNodeId = stringValue(record?.current_node)
  if (!currentNodeId) return []

  const nodes = new Map(extractConversationNodes(payload).map((node) => [node.id, node]))
  const branch: TrackedConversationNode[] = []
  const visited = new Set<string>()
  let nodeId: string | undefined = currentNodeId

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId)
    const node = nodes.get(nodeId)
    if (!node) break
    branch.push(node)
    nodeId = node.parent
  }

  branch.reverse()
  return conversationMessages(branch)
}

function conversationMessages(nodes: readonly TrackedConversationNode[]): ChatGptConversationMessage[] {
  const messages: ChatGptConversationMessage[] = []
  for (const node of nodes) {
    const { message } = node
    if (!message.text) continue
    if (message.role === "user") messages.push({ role: "user", text: message.text })
    else if (isFinalAssistantNode(node)) messages.push({ role: "assistant", text: message.text })
  }
  return messages
}

function normalizeConversationNode(record: Record<string, unknown>): TrackedConversationNode | undefined {
  const messageRecord = asRecord(record.message)
  if (!messageRecord) return undefined
  const messageId = stringValue(messageRecord.id)
  const author = asRecord(messageRecord.author)
  if (!messageId || !author) return undefined

  const metadata = asRecord(messageRecord.metadata)
  const content = asRecord(messageRecord.content)
  return {
    id: stringValue(record.id) ?? messageId,
    parent: stringValue(record.parent),
    children: stringArray(record.children),
    message: {
      id: messageId,
      role: stringValue(author.role),
      status: stringValue(messageRecord.status),
      endTurn: booleanOrNull(messageRecord.end_turn),
      recipient: nullableString(messageRecord.recipient),
      createTime: numberValue(messageRecord.create_time),
      text: extractMessageText(content),
      turnExchangeId: stringValue(metadata?.turn_exchange_id),
      workingTurnId: stringValue(metadata?.working_turn_id),
      isComplete: booleanValue(metadata?.is_complete),
    },
  }
}

function extractMessageText(content?: Record<string, unknown>): string {
  if (!content) return ""
  const parts = content.parts
  if (Array.isArray(parts)) {
    return parts
      .map((part) => (typeof part === "string" ? part : ""))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  return stringValue(content.text)?.trim() ?? ""
}

function isFinalAssistantNode(node: TrackedConversationNode): boolean {
  const message = node.message
  return (
    message.role === "assistant" &&
    message.status === "finished_successfully" &&
    Boolean(message.text) &&
    (!message.recipient || message.recipient === "all") &&
    message.endTurn === true
  )
}

function classifyActivity(node: TrackedConversationNode): ChatGptSubagentActivity {
  const recipient = node.message.recipient?.toLowerCase()
  if (recipient && recipient !== "all") {
    if (recipient.includes("web") || recipient.includes("search")) return "Searching the web"
    return "Using tools"
  }
  if (node.message.role === "assistant") return "Generating response"
  return "Working"
}

function parseResponsePayloads(text: string): unknown[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const direct = tryParseJson(trimmed)
  if (direct !== undefined) return [direct]

  const payloads: unknown[] = []
  for (const rawLine of trimmed.split(/\r?\n/)) {
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

function visitObjects(value: unknown, visitor: (record: Record<string, unknown>) => void, visited = new Set<object>()): void {
  if (!value || typeof value !== "object" || visited.has(value)) return
  visited.add(value)
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, visitor, visited)
    return
  }
  const record = value as Record<string, unknown>
  visitor(record)
  for (const nested of Object.values(record)) visitObjects(nested, visitor, visited)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : stringValue(value)
}

function booleanOrNull(value: unknown): boolean | null | undefined {
  return value === null ? null : booleanValue(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
