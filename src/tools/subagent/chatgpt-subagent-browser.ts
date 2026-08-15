import { type Locator, type Page, type Response } from "playwright-core"

import { asRecord, booleanValue, finiteNumber as numberValue } from "../../utils.js"
import {
  ChatGptSubagentError,
  type ChatGptConversationMessage,
  type ChatGptSubagentActivity,
} from "./chatgpt-subagent-contracts.js"

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

export interface FinalResponseQuery {
  baselineIds: ReadonlySet<string>
  prompt?: string
  sentAtSeconds?: number
}

export interface DomAssistantMessage {
  key: string
  text: string
}

export interface ManagedAgentPageState {
  agentId: string
  page: Page
  conversationId?: string
  conversationUrl?: string
}

export class ChatGptConversationTracker {
  private readonly messages = new Map<string, TrackedConversationNode>()
  private readonly responseHandler: (response: Response) => void
  private onActivity?: (activity: ChatGptSubagentActivity) => void
  private onUpdate?: () => void

  constructor(private readonly page?: Page) {
    this.responseHandler = (response) => {
      void this.consumeResponse(response)
    }
    page?.on("response", this.responseHandler)
  }

  dispose(): void {
    this.page?.off("response", this.responseHandler)
  }

  snapshotIds(): Set<string> {
    return new Set(this.messages.keys())
  }

  setActivityListener(listener?: (activity: ChatGptSubagentActivity) => void): void {
    this.onActivity = listener
  }

  setUpdateListener(listener?: () => void): void {
    this.onUpdate = listener
  }

  ingestPayload(payload: unknown): void {
    let changed = false
    for (const node of extractConversationNodes(payload)) {
      const previous = this.messages.get(node.id)
      this.messages.set(node.id, node)
      if (!previous || didTrackedNodeProgress(previous, node)) {
        changed = true
        this.onActivity?.(classifyActivity(node))
      }
    }
    if (changed) this.onUpdate?.()
  }

  findFinalResponse(query: FinalResponseQuery): TrackedConversationNode | undefined {
    const newNodes = [...this.messages.values()].filter((node) => !query.baselineIds.has(node.id))
    if (newNodes.length === 0) return undefined

    const userNode = findNewestMatchingUserNode(newNodes, query.prompt)
    if (query.prompt?.trim() && !userNode) return undefined
    const finals = newNodes.filter(isFinalAssistantNode)
    if (finals.length === 0) return undefined

    const ranked = finals
      .map((node) => ({
        node,
        score: scoreFinalCandidate(node, userNode, this.messages, query.sentAtSeconds),
      }))
      .filter(({ score }) => score >= 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        return (right.node.message.createTime ?? 0) - (left.node.message.createTime ?? 0)
      })

    return ranked[0]?.node
  }

  private async consumeResponse(response: Response): Promise<void> {
    if (!isConversationResponse(response)) return

    try {
      const text = await response.text()
      for (const payload of parseResponsePayloads(text)) {
        this.ingestPayload(payload)
      }
    } catch {
      // Streaming and aborted responses are allowed to be unreadable.
      // subagent_result reconciles against the DOM when network evidence is incomplete.
    }
  }
}

export function findLatestAssistantAfterPrompt(
  messages: readonly ChatGptConversationMessage[],
  prompt?: string
): ChatGptConversationMessage | undefined {
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
    if (!value || typeof value !== "object") return
    if (visited.has(value)) return
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
  const messages: ChatGptConversationMessage[] = []
  for (const node of branch) {
    const { message } = node
    if (!message.text) continue
    if (message.role === "user") {
      messages.push({ role: "user", text: message.text })
      continue
    }
    if (isFinalAssistantNode(node)) {
      messages.push({ role: "assistant", text: message.text })
    }
  }
  return messages
}

export async function findComposer(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<Locator> {
  const selectors = [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][aria-label*="Chat with ChatGPT" i]',
    '[contenteditable="true"][aria-label*="Ask ChatGPT" i]',
    'textarea[placeholder*="Ask ChatGPT" i]:not(.wcDTda_fallbackTextarea)',
  ]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of selectors) {
      const locator = page.locator(selector).first()
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator
    }
    await delay(200, signal)
  }
  throw new ChatGptSubagentError("CHATGPT_UI_CHANGED", `Could not find the ChatGPT composer within ${timeoutMs} ms.`)
}

export async function assertAuthenticated(page: Page): Promise<void> {
  const url = new URL(page.url())
  const loginRoute = /\/auth\/(login|signin)/i.test(url.pathname)
  const visibleLoginControl = await page
    .locator('a[href*="/auth/login"], a[href*="/auth/signin"], button:has-text("Log in")')
    .first()
    .isVisible()
    .catch(() => false)
  if (loginRoute || visibleLoginControl) {
    throw new ChatGptSubagentError(
      "CHATGPT_NOT_AUTHENTICATED",
      "The attached Chrome instance is not authenticated to ChatGPT. Sign in in that Chrome profile before using subagents."
    )
  }
}

export async function assertConversationAvailable(
  page: Page,
  conversationId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000)
  const unavailable = page.getByText(/conversation.*(?:not found|unavailable)|unable to load conversation/i).first()

  while (Date.now() < deadline) {
    throwIfAborted(signal)
    if (extractConversationId(page.url()) !== conversationId) {
      throw new ChatGptSubagentError(
        "SUBAGENT_CONVERSATION_NOT_FOUND",
        `ChatGPT conversation ${conversationId} is no longer available. It may have been deleted.`
      )
    }
    if (await unavailable.isVisible().catch(() => false)) {
      throw new ChatGptSubagentError(
        "SUBAGENT_CONVERSATION_NOT_FOUND",
        `ChatGPT conversation ${conversationId} is no longer available. It may have been deleted.`
      )
    }
    if ((await page.locator("[data-message-author-role]").count()) > 0) return
    await delay(200, signal)
  }

  throw new ChatGptSubagentError(
    "CHATGPT_UI_CHANGED",
    `ChatGPT conversation ${conversationId} did not render messages within ${Math.min(timeoutMs, 10_000)} ms.`
  )
}

export async function enterPrompt(page: Page, composer: Locator, prompt: string, signal?: AbortSignal): Promise<void> {
  await retryAfterDismissingBlockingOverlay(page, () => composer.click(), signal)
  await composer.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
  await composer.press("Backspace")
  await page.keyboard.insertText(prompt)
}

export async function submitComposer(page: Page, composer: Locator, signal?: AbortSignal): Promise<void> {
  const sendSelectors = ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send" i]']
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of sendSelectors) {
      const button = page.locator(selector).first()
      if ((await button.count()) > 0 && (await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))) {
        await retryAfterDismissingBlockingOverlay(page, () => button.click(), signal)
        return
      }
    }
    await delay(50, signal)
  }

  throwIfAborted(signal)
  await retryAfterDismissingBlockingOverlay(page, () => composer.press("Enter"), signal)
}

export async function dismissBlockingChatGptOverlay(page: Page, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal)
  const overlay = page.locator('#modal-beacon, [data-testid="modal-beacon"]').first()
  if ((await overlay.count()) === 0 || !(await overlay.isVisible().catch(() => false))) return false
  await page.keyboard.press("Escape")
  await delay(250, signal)
  return true
}

export async function readAssistantDomMessages(page: Page): Promise<DomAssistantMessage[]> {
  return page.locator('[data-message-author-role="assistant"]').evaluateAll((elements) =>
    elements.map((element, index) => {
      const owner = element.closest("[data-message-id]")
      const messageId = owner?.getAttribute("data-message-id") ?? element.getAttribute("data-message-id") ?? undefined
      return {
        key: messageId ?? `assistant:${index}`,
        text: (element.textContent ?? "").trim(),
      }
    })
  )
}

export async function findNewDomAssistantMessage(
  page: Page,
  baseline: readonly DomAssistantMessage[]
): Promise<DomAssistantMessage | undefined> {
  const current = await readAssistantDomMessages(page)
  if (current.length === 0) return undefined
  const baselineKeys = new Set(baseline.map((message) => message.key))
  const newMessages = current.filter((message) => !baselineKeys.has(message.key))
  if (newMessages.length > 0) return newMessages.at(-1)
  if (current.length > baseline.length) return current.at(-1)
  return undefined
}

export async function loadConversationPayload(page: Page, conversationId: string, timeoutMs: number): Promise<unknown> {
  const pathname = `/backend-api/conversation/${conversationId}`
  const responsePromise = page.waitForResponse(
    (response) => {
      try {
        const url = new URL(response.url())
        return url.hostname === "chatgpt.com" && url.pathname === pathname && response.status() === 200
      } catch {
        return false
      }
    },
    { timeout: timeoutMs }
  )

  await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => undefined)
  const response = await responsePromise
  return response.json()
}

export async function isGenerating(page: Page): Promise<boolean> {
  const selectors = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating" i]', 'button[aria-label="Stop"]']
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return true
  }
  return false
}

export async function getConversationStreamStatus(page: Page, conversationId: string): Promise<string | undefined> {
  try {
    return await page.evaluate(async (id) => {
      try {
        const response = await fetch(`/backend-api/conversation/${encodeURIComponent(id)}/stream_status`, {
          credentials: "same-origin",
        })
        if (!response.ok) return undefined
        const payload = (await response.json()) as { status?: unknown }
        return typeof payload.status === "string" ? payload.status : undefined
      } catch {
        return undefined
      }
    }, conversationId)
  } catch {
    return undefined
  }
}

export async function waitForStableConversationLocation(
  state: ManagedAgentPageState,
  timeoutMs: number
): Promise<boolean> {
  if (state.conversationId) return true

  try {
    await state.page.waitForURL((url) => extractConversationId(url.toString()) !== undefined, { timeout: timeoutMs })
    captureOrValidateConversationLocation(state)
    return state.conversationId !== undefined
  } catch {
    return false
  }
}

export function isExpectedAgentPage(state: ManagedAgentPageState): boolean {
  const currentUrl = state.page.url()
  if (!isChatGptUrl(currentUrl)) return false

  const currentConversationId = extractConversationId(currentUrl)
  if (state.conversationId) return currentConversationId === state.conversationId
  if (state.conversationUrl) {
    const expectedConversationId = extractConversationId(state.conversationUrl)
    return expectedConversationId ? currentConversationId === expectedConversationId : currentUrl === state.conversationUrl
  }
  return currentConversationId === undefined
}

export function assertPreSubmitLocation(state: ManagedAgentPageState): void {
  if (isExpectedAgentPage(state)) return
  throw new ChatGptSubagentError(
    "AGENT_TARGET_LOST",
    `ChatGPT subagent ${state.agentId} was navigated away from its managed page before submission. No prompt was sent and the changed tab will not be hijacked.`
  )
}

export function captureOrValidateConversationLocation(state: ManagedAgentPageState): void {
  const currentUrl = state.page.url()
  if (!isChatGptUrl(currentUrl)) {
    throw new ChatGptSubagentError(
      "AGENT_TARGET_LOST",
      `ChatGPT subagent ${state.agentId} was navigated away from ChatGPT while a turn was in progress. The submitted turn will not be retried automatically.`
    )
  }

  const currentConversationId = extractConversationId(currentUrl)
  if (state.conversationId && currentConversationId !== state.conversationId) {
    throw new ChatGptSubagentError(
      "AGENT_TARGET_LOST",
      `ChatGPT subagent ${state.agentId} was navigated away from its managed conversation while a turn was in progress. The submitted turn will not be retried automatically.`
    )
  }
  if (!state.conversationId && currentConversationId) {
    state.conversationId = currentConversationId
    state.conversationUrl = currentUrl
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new ChatGptSubagentError(
    "REQUEST_ABORTED",
    "The ChatGPT subagent request was cancelled. A turn that was already submitted will not be retried automatically."
  )
}

export async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  throwIfAborted(signal)

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
  if (message.role !== "assistant") return false
  if (message.status !== "finished_successfully") return false
  if (!message.text) return false
  if (message.recipient && message.recipient !== "all") return false
  return message.endTurn === true
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

function didTrackedNodeProgress(previous: TrackedConversationNode, next: TrackedConversationNode): boolean {
  return (
    previous.parent !== next.parent ||
    previous.children.join("\u0000") !== next.children.join("\u0000") ||
    previous.message.status !== next.message.status ||
    previous.message.endTurn !== next.message.endTurn ||
    previous.message.recipient !== next.message.recipient ||
    previous.message.text !== next.message.text ||
    previous.message.turnExchangeId !== next.message.turnExchangeId ||
    previous.message.workingTurnId !== next.message.workingTurnId ||
    previous.message.isComplete !== next.message.isComplete
  )
}

function findNewestMatchingUserNode(nodes: readonly TrackedConversationNode[], prompt?: string): TrackedConversationNode | undefined {
  const users = nodes.filter((node) => node.message.role === "user")
  if (users.length === 0) return undefined
  const normalizedPrompt = prompt?.trim()
  const candidates = normalizedPrompt ? users.filter((node) => node.message.text.trim() === normalizedPrompt) : users
  if (candidates.length === 0) return undefined
  return [...candidates].sort((left, right) => (right.message.createTime ?? 0) - (left.message.createTime ?? 0))[0]
}

function scoreFinalCandidate(
  candidate: TrackedConversationNode,
  userNode: TrackedConversationNode | undefined,
  messages: ReadonlyMap<string, TrackedConversationNode>,
  sentAtSeconds?: number
): number {
  if (userNode) {
    if (userNode.message.turnExchangeId && candidate.message.turnExchangeId === userNode.message.turnExchangeId) return 300
    if (isDescendantOf(candidate, userNode.id, messages)) return 200
    if (
      userNode.message.createTime !== undefined &&
      candidate.message.createTime !== undefined &&
      candidate.message.createTime >= userNode.message.createTime
    ) {
      return 100
    }
    return -1
  }

  if (sentAtSeconds !== undefined && candidate.message.createTime !== undefined && candidate.message.createTime + 1 < sentAtSeconds) return -1
  return 10
}

function isDescendantOf(node: TrackedConversationNode, ancestorId: string, messages: ReadonlyMap<string, TrackedConversationNode>): boolean {
  const visited = new Set<string>()
  let current: TrackedConversationNode | undefined = node
  while (current?.parent) {
    if (current.parent === ancestorId) return true
    if (visited.has(current.parent)) return false
    visited.add(current.parent)
    current = messages.get(current.parent)
  }
  return false
}

function isConversationResponse(response: Response): boolean {
  const url = response.url()
  if (!url.includes("chatgpt.com")) return false
  if (!url.toLowerCase().includes("conversation")) return false
  const contentType = response.headers()["content-type"]?.toLowerCase() ?? ""
  return contentType.includes("application/json") || contentType.includes("text/event-stream") || contentType.includes("text/plain")
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
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function retryAfterDismissingBlockingOverlay<T>(page: Page, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!(await dismissBlockingChatGptOverlay(page, signal))) throw error
    return action()
  }
}

function extractConversationId(url: string): string | undefined {
  const match = new URL(url).pathname.match(/^\/c\/([^/?#]+)/)
  if (!match) return undefined

  const rawConversationId = match[1]
  if (!rawConversationId) return undefined
  const conversationId = decodeURIComponent(rawConversationId)
  if (conversationId.toLowerCase().startsWith("web:")) return undefined
  return conversationId
}

function isChatGptUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "chatgpt.com"
  } catch {
    return false
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : stringValue(value)
}

function booleanOrNull(value: unknown): boolean | null | undefined {
  if (value === null) return null
  return booleanValue(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
