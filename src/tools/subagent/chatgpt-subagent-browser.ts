import { randomUUID } from "node:crypto"

import { type CDPSession, type Locator, type Page } from "playwright-core"

import { asRecord, booleanValue, finiteNumber as numberValue } from "../../utils.js"
import { ChatGptSubagentError, type ChatGptConversationMessage, type ChatGptSubagentActivity } from "./chatgpt-subagent-contracts.js"

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

export interface DomAssistantMessage {
  key: string
  text: string
}

export interface AssistantResponseObservation {
  response: Promise<string>
  dispose(): Promise<void>
}

export interface ManagedAgentPageState {
  agentId: string
  page: Page
  conversationId?: string
  conversationUrl?: string
}

export class ChatGptWebSocketTurnTracker {
  private topicId?: string
  private assistant?: TrackedConversationNode
  private lastDeltaPath?: string
  private lastDeltaOperation?: string
  private completionObserved = false

  constructor(
    private readonly prompt: string,
    private readonly onActivity?: (activity: ChatGptSubagentActivity) => void
  ) {}

  ingestFrame(payloadData: string): string | undefined {
    let assistantChanged = false
    let completionSignal = false
    const parsed = tryParseJson(payloadData)
    if (parsed === undefined) return undefined

    visitObjects(parsed, (record) => {
      const topicId = stringValue(record.topic_id)
      const envelope = asRecord(record.payload)
      if (!topicId?.startsWith("conversation-turn-") || envelope?.type !== "conversation-turn-stream") return
      const payload = asRecord(envelope.payload)
      if (!payload) return

      if (payload.type === "done") {
        if (this.topicId === topicId) completionSignal = true
        return
      }
      if (payload.type !== "stream-item") return

      const encodedItem = stringValue(payload.encoded_item)
      if (!encodedItem) return
      for (const item of parseResponsePayloads(encodedItem)) {
        const itemRecord = asRecord(item)
        if (!itemRecord) continue
        const deltaValue = asRecord(itemRecord.v)
        const node = deltaValue ? normalizeConversationNode(deltaValue) : undefined
        if (node?.message.role === "user" && node.message.text.trim() === this.prompt.trim()) {
          this.topicId = topicId
        }

        const inputMessage = asRecord(itemRecord.input_message)
        const inputNode = inputMessage ? normalizeConversationNode({ message: inputMessage }) : undefined
        if (inputNode?.message.role === "user" && inputNode.message.text.trim() === this.prompt.trim()) {
          this.topicId = topicId
        }

        if (this.topicId !== topicId) continue
        this.onActivity?.(node ? classifyActivity(node) : "Working")
        if (node?.message.role === "assistant") {
          this.assistant = node
          this.lastDeltaPath = undefined
          this.lastDeltaOperation = undefined
          assistantChanged = true
        }
        assistantChanged = this.applyDelta(itemRecord) || assistantChanged
        if (itemRecord.type === "message_stream_complete") completionSignal = true
      }
    })

    if (completionSignal) this.completionObserved = true
    if (!assistantChanged && !completionSignal) return undefined
    if (!this.completionObserved) return undefined
    return this.finalAssistantText()
  }

  private applyDelta(delta: Record<string, unknown>): boolean {
    if (!this.assistant) return false
    const explicitOperation = stringValue(delta.o)
    const operation = explicitOperation || this.lastDeltaOperation
    if (operation === "patch" && Array.isArray(delta.v)) {
      let changed = false
      for (const nested of delta.v) {
        const record = asRecord(nested)
        if (record) changed = this.applyDelta(record) || changed
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

  private finalAssistantText(): string | undefined {
    if (!this.assistant || !isFinalAssistantNode(this.assistant)) return undefined
    return this.assistant.message.text
  }
}

export async function observeAssistantResponse(
  page: Page,
  input: {
    baselineDom: readonly DomAssistantMessage[]
    prompt: string
    settleMs: number
    onActivity?: (activity: ChatGptSubagentActivity) => void
  }
): Promise<AssistantResponseObservation> {
  const tracker = new ChatGptWebSocketTurnTracker(input.prompt, input.onActivity)
  const observerToken = randomUUID()
  let cdp: CDPSession | undefined
  let websocketFailed = false
  let domFailed = false
  let settled = false
  let settleTimer: NodeJS.Timeout | undefined
  let cleanupPromise: Promise<void> | undefined
  let resolveResponse!: (response: string) => void
  let rejectResponse!: (error: unknown) => void
  const response = new Promise<string>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (settleTimer) clearTimeout(settleTimer)
      await page
        .evaluate(
          ({ token, registryKey }) => {
            const registry = (window as unknown as Record<string, Map<string, () => void>>)[registryKey]
            registry?.get(token)?.()
          },
          { token: observerToken, registryKey: "__unhingedAssistantResponseObservers" }
        )
        .catch(() => undefined)
      await cdp?.detach().catch(() => undefined)
    })()
    return cleanupPromise
  }

  const finish = (text: string): void => {
    if (settled) return
    settled = true
    resolveResponse(text)
    void cleanup()
  }

  const failSource = (source: "websocket" | "dom", error: unknown): void => {
    if (source === "websocket") websocketFailed = true
    else domFailed = true
    if (settled || !websocketFailed || !domFailed) return
    settled = true
    rejectResponse(error)
    void cleanup()
  }

  const scheduleStructuredResponse = (text: string): void => {
    if (settled) return
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => finish(text), input.settleMs)
  }

  const frameHandler = (event: { response?: { payloadData?: string } }): void => {
    const payloadData = event.response?.payloadData
    if (!payloadData) return
    try {
      const text = tracker.ingestFrame(payloadData)
      if (text) scheduleStructuredResponse(text)
    } catch (error) {
      failSource("websocket", error)
    }
  }

  try {
    cdp = await page.context().newCDPSession(page)
    await cdp.send("Network.enable")
    cdp.on("Network.webSocketFrameReceived", frameHandler)
    cdp.on("close", () => failSource("websocket", new Error("ChatGPT CDP session closed while waiting for the assistant response.")))
  } catch {
    websocketFailed = true
    await cdp?.detach().catch(() => undefined)
    cdp = undefined
  }

  const domPromise = page.evaluate(
    ({ baseline, settleMs, token, registryKey }) =>
      new Promise<string | null>((resolve) => {
        const stopSelector = 'button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label="Stop"]'
        const baselineByKey = new Map(baseline.map((message) => [message.key, message.text]))
        const registryHost = window as unknown as Record<string, Map<string, () => void>>
        const registry = (registryHost[registryKey] ??= new Map<string, () => void>())
        let timer: ReturnType<typeof setTimeout> | undefined
        let sawGenerating = false
        let lastText = ""
        let lastGenerating = false

        const isVisible = (element: Element | null): boolean => {
          if (!(element instanceof HTMLElement)) return false
          const style = window.getComputedStyle(element)
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0
        }

        const readCandidate = (): string => {
          const elements = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
          const candidates = elements
            .map((element, index) => {
              const owner = element.closest("[data-message-id]")
              const key = owner?.getAttribute("data-message-id") ?? element.getAttribute("data-message-id") ?? `assistant:${index}`
              return { key, text: (element.textContent ?? "").trim() }
            })
            .filter((message) => !baselineByKey.has(message.key) || baselineByKey.get(message.key) !== message.text)
          return candidates.at(-1)?.text ?? ""
        }

        const finishDom = (value: string | null): void => {
          if (timer) clearTimeout(timer)
          observer.disconnect()
          registry.delete(token)
          resolve(value)
        }

        const inspect = (): void => {
          const generating = isVisible(document.querySelector(stopSelector))
          if (generating) sawGenerating = true
          const text = readCandidate()
          if (generating !== lastGenerating || text !== lastText) {
            lastGenerating = generating
            lastText = text
            if (timer) clearTimeout(timer)
            timer = undefined
          }
          if (generating || !text || /^thinking\b/i.test(text) || timer) return

          const grace = sawGenerating ? settleMs : Math.max(settleMs, 2_000)
          const expectedText = text
          timer = setTimeout(() => {
            timer = undefined
            if (isVisible(document.querySelector(stopSelector))) return
            const current = readCandidate()
            if (!current || current !== expectedText) {
              inspect()
              return
            }
            finishDom(current)
          }, grace)
        }

        const observer = new MutationObserver(inspect)
        registry.set(token, () => finishDom(null))
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-label", "class", "data-testid"],
        })
        inspect()
      }),
    {
      baseline: input.baselineDom,
      settleMs: input.settleMs,
      token: observerToken,
      registryKey: "__unhingedAssistantResponseObservers",
    }
  )

  domPromise.then(
    (text) => {
      if (text) finish(text)
      else if (!settled) failSource("dom", new Error("ChatGPT DOM response observation stopped before completion."))
    },
    (error) => failSource("dom", error)
  )

  if (websocketFailed) {
    domPromise.catch(() => undefined)
  }

  return {
    response,
    async dispose() {
      if (!settled) {
        settled = true
        rejectResponse(new Error("ChatGPT assistant response observation was disposed."))
      }
      await cleanup()
    },
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

export async function assertConversationAvailable(page: Page, conversationId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
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

export async function findNewDomAssistantMessage(page: Page, baseline: readonly DomAssistantMessage[]): Promise<DomAssistantMessage | undefined> {
  const current = await readAssistantDomMessages(page)
  if (current.length === 0) return undefined
  const baselineKeys = new Set(baseline.map((message) => message.key))
  const newMessages = current.filter((message) => !baselineKeys.has(message.key))
  if (newMessages.length > 0) return newMessages.at(-1)
  if (current.length > baseline.length) return current.at(-1)
  return undefined
}

export async function navigateAndCaptureConversationPayload(
  page: Page,
  conversationUrl: string,
  conversationId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown | undefined> {
  const pathname = `/backend-api/conversation/${conversationId}`
  const responsePromise = page
    .waitForResponse(
      (response) => {
        try {
          const url = new URL(response.url())
          return url.hostname === "chatgpt.com" && url.pathname === pathname && response.status() === 200
        } catch {
          return false
        }
      },
      { timeout: Math.min(timeoutMs, 10_000) }
    )
    .then((response) => response.json())
    .catch(() => undefined)

  await waitForPromise(page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }), signal)
  throwIfAborted(signal)
  return waitForPromise(responsePromise, signal)
}

export async function waitForStableConversationLocation(state: ManagedAgentPageState, timeoutMs: number): Promise<boolean> {
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

async function retryAfterDismissingBlockingOverlay<T>(page: Page, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!(await dismissBlockingChatGptOverlay(page, signal))) throw error
    return action()
  }
}

function extractConversationId(url: string): string | undefined {
  const match = new URL(url).pathname.match(/(?:^|\/)c\/([^/?#]+)/)
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
