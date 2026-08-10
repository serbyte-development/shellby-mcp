import { randomUUID } from "node:crypto"

import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from "playwright-core"

export const DEFAULT_CHATGPT_CDP_ENDPOINT = "http://127.0.0.1:9222"

const CAVEMAN_PROMPT =
  "If no level specified, use full. Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step]."

export interface ChatGptSubagentOptions {
  cdpEndpoint: string
  connectTimeoutMs?: number
  chatGptUrl?: string
  maxConcurrentAgents?: number
  minInterTurnDelayMs?: number
  interactionDelayMs?: number
  timeoutMs?: number
  pollIntervalMs?: number
  responseStableMs?: number
}

export interface ChatGptSubagentRequest {
  prompt: string
  agentId: string
  oververbosity?: number
}

export interface ChatGptSubagentStartResult {
  agentId: string
  turnId: string
  status: "running"
  submitted: true
  conversationId?: string
  conversationUrl?: string
}

export interface ChatGptSubagentPollResult {
  agentId: string
  turnId: string
  status: "running" | "completed" | "failed"
  activity?: ChatGptSubagentActivity
  activityAgeMs?: number
  conversationId?: string
  conversationUrl?: string
  messageId?: string
  response?: string
  errorCode?: string
  errorMessage?: string
}

export type ChatGptSubagentActivity = "Working" | "Searching the web" | "Using tools" | "Generating response"

export interface ChatGptConversationMessage {
  id?: string
  role: "user" | "assistant"
  text: string
}

export type ChatGptSubagentErrorCode =
  | "BROWSER_UNAVAILABLE"
  | "CHATGPT_NOT_AUTHENTICATED"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_TURN"
  | "AGENT_BUSY"
  | "SUBAGENT_CAPACITY_REACHED"
  | "AGENT_TARGET_LOST"
  | "REQUEST_ABORTED"
  | "CHATGPT_UI_CHANGED"

export class ChatGptSubagentError extends Error {
  constructor(
    readonly code: ChatGptSubagentErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ChatGptSubagentError"
  }
}

export interface ChatGptSubagentService {
  ask(request: ChatGptSubagentRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult>
  poll(turnId: string, waitMs?: number, signal?: AbortSignal): Promise<ChatGptSubagentPollResult>
  dispose(): Promise<void>
}

interface BrowserAgentState {
  agentId: string
  page: Page
  tracker: ChatGptConversationTracker
  hasSubmittedTurn: boolean
  conversationId?: string
  conversationUrl?: string
  targetId?: string
  lastReturnedMessageId?: string
  lastCompletedAt?: number
}

interface BrowserTurnState {
  turnId: string
  agentId: string
  status: "running" | "completed" | "failed"
  activity: ChatGptSubagentActivity
  lastActivityAt: number
  conversationId?: string
  conversationUrl?: string
  messageId?: string
  response?: string
  errorCode?: string
  errorMessage?: string
  completion: Promise<void>
}

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

export class ChatGptConversationTracker {
  private readonly messages = new Map<string, TrackedConversationNode>()
  private readonly responseHandler: (response: Response) => void
  private onActivity?: (activity: ChatGptSubagentActivity) => void

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

  ingestPayload(payload: unknown): void {
    for (const node of extractConversationNodes(payload)) {
      const previous = this.messages.get(node.id)
      this.messages.set(node.id, node)
      if (!previous || didTrackedNodeProgress(previous, node)) {
        this.onActivity?.(classifyActivity(node))
      }
    }
  }

  findFinalResponse(query: FinalResponseQuery): TrackedConversationNode | undefined {
    const newNodes = [...this.messages.values()].filter((node) => !query.baselineIds.has(node.id))
    if (newNodes.length === 0) return undefined

    const userNode = findNewestMatchingUserNode(newNodes, query.prompt)
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
      // Streaming and aborted responses are allowed to be unreadable. DOM
      // completion detection remains the fallback for the caller.
    }
  }
}

export class ChatGptSubagentModule {
  private readonly connectTimeoutMs: number
  private readonly chatGptUrl: string
  private readonly maxConcurrentAgents: number
  private readonly minInterTurnDelayMs: number
  private readonly interactionDelayMs: number
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly responseStableMs: number
  private readonly agents = new Map<string, BrowserAgentState>()
  private readonly turns = new Map<string, BrowserTurnState>()
  private readonly activeTurnsByAgent = new Map<string, string>()
  private readonly activeAgentIds = new Set<string>()
  private activeGenerationCount = 0
  private browser?: Browser
  private context?: BrowserContext
  private connectPromise?: Promise<void>

  constructor(private readonly options: ChatGptSubagentOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000
    this.chatGptUrl = options.chatGptUrl ?? "https://chatgpt.com/"
    this.maxConcurrentAgents = positiveInteger(options.maxConcurrentAgents, 2)
    this.minInterTurnDelayMs = nonNegativeInteger(options.minInterTurnDelayMs, 1_500)
    this.interactionDelayMs = nonNegativeInteger(options.interactionDelayMs, 300)
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    this.responseStableMs = options.responseStableMs ?? 750
  }

  async connect(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (this.browser?.isConnected() && this.context) return

    this.connectPromise ??= this.connectOnce().finally(() => {
      this.connectPromise = undefined
    })
    await waitForPromise(this.connectPromise, signal)
  }

  async ask(request: ChatGptSubagentRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult> {
    const prompt = request.prompt.trim()
    if (!prompt) throw new Error("Subagent prompt cannot be empty.")
    const oververbosity = normalizeOververbosity(request.oververbosity)
    validateAgentId(request.agentId)
    this.beginAgentOperation(request.agentId, true)
    let state: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      await this.connect(signal)
      state = this.agents.get(request.agentId)
      if (!state) state = await this.createAgent(request.agentId, signal)

      await this.waitForInterTurn(state, signal)
      const active = await this.ensureActivePage(state, signal)
      throwIfAborted(signal)
      if (await isGenerating(active.page)) {
        throw new ChatGptSubagentError(
          "AGENT_BUSY",
          `ChatGPT subagent ${active.agentId} is still generating. Do not retry automatically; wait before sending another turn.`
        )
      }

      const baselineNetworkIds = active.tracker.snapshotIds()
      const baselineDom = await readAssistantDomMessages(active.page)
      const sentAtSeconds = Date.now() / 1000

      const composer = await findComposer(active.page, this.timeoutMs, signal)
      await delay(this.interactionDelayMs, signal)
      throwIfAborted(signal)
      assertPreSubmitLocation(active)
      const submittedPrompt = active.hasSubmittedTurn ? prompt : appendFirstTurnMode(prompt, oververbosity)
      await enterPrompt(active.page, composer, submittedPrompt)
      await delay(this.interactionDelayMs, signal)
      throwIfAborted(signal)
      assertPreSubmitLocation(active)
      await submitComposer(active.page, composer, signal)
      active.hasSubmittedTurn = true
      const turnId = `turn_${randomUUID()}`
      const turn: BrowserTurnState = {
        turnId,
        agentId: active.agentId,
        status: "running",
        activity: "Generating response",
        lastActivityAt: Date.now(),
        conversationId: active.conversationId,
        conversationUrl: active.conversationUrl,
        completion: Promise.resolve(),
      }
      this.turns.set(turnId, turn)
      this.activeTurnsByAgent.set(active.agentId, turnId)
      active.tracker.setActivityListener((activity) => {
        if (turn.status !== "running") return
        turn.activity = activity
        turn.lastActivityAt = Date.now()
      })
      turn.completion = this.trackTurn(turn, active, {
        baselineNetworkIds,
        baselineDom,
        prompt: submittedPrompt,
        sentAtSeconds,
      })
      operationTransferred = true

      return {
        agentId: active.agentId,
        turnId,
        status: "running",
        submitted: true,
        conversationId: active.conversationId,
        conversationUrl: active.conversationUrl,
      }
    } catch (error) {
      if (state && error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST" && !state.conversationUrl) {
        this.discardUnrecoverableAgent(state)
      }
      throw error
    } finally {
      if (!operationTransferred) this.endAgentOperation(request.agentId, true)
    }
  }

  async poll(turnId: string, waitMs = 0, signal?: AbortSignal): Promise<ChatGptSubagentPollResult> {
    const normalizedTurnId = turnId.trim()
    if (!normalizedTurnId) throw new Error("turnId cannot be empty.")
    const turn = this.turns.get(normalizedTurnId)
    if (!turn) {
      throw new ChatGptSubagentError("UNKNOWN_TURN", `Unknown ChatGPT subagent turn: ${normalizedTurnId}`)
    }

    const boundedWaitMs = Math.min(Math.max(0, waitMs), 10_000)
    if (turn.status === "running" && boundedWaitMs > 0) {
      await Promise.race([turn.completion, delay(boundedWaitMs, signal)])
    }
    throwIfAborted(signal)
    return this.turnResult(turn)
  }

  async read(agentId: string): Promise<ChatGptConversationMessage[]> {
    validateAgentId(agentId)
    this.beginAgentOperation(agentId, false)
    try {
      await this.connect()
      const state = this.getExistingAgent(agentId)
      const active = await this.ensureActivePage(state)
      if (!active.conversationId) return readVisibleConversation(active.page)

      const payload = await loadConversationPayload(active.page, active.conversationId, this.timeoutMs)
      return extractConversationMessages(payload)
    } finally {
      this.endAgentOperation(agentId, false)
    }
  }

  async closeAgent(agentId: string): Promise<void> {
    validateAgentId(agentId)
    this.beginAgentOperation(agentId, false)
    const state = this.agents.get(agentId)
    try {
      if (!state) return
      state.tracker.dispose()
      if (!state.page.isClosed()) await state.page.close()
      this.agents.delete(agentId)
    } finally {
      this.endAgentOperation(agentId, false)
    }
  }

  async dispose(): Promise<void> {
    const states = [...this.agents.values()]
    const ownedPages: Page[] = []
    for (const state of states) {
      state.tracker.dispose()
      if (!state.page.isClosed() && isExpectedAgentPage(state)) {
        ownedPages.push(state.page)
      }
    }

    this.agents.clear()
    this.turns.clear()
    this.activeTurnsByAgent.clear()
    this.activeAgentIds.clear()
    this.activeGenerationCount = 0
    this.context = undefined
    this.browser = undefined
    this.connectPromise = undefined

    await Promise.allSettled(ownedPages.map((page) => page.close()))
  }

  listAgents(): Array<{
    agentId: string
    conversationId?: string
    conversationUrl?: string
    targetId?: string
    pageClosed: boolean
  }> {
    return [...this.agents.values()].map((state) => ({
      agentId: state.agentId,
      conversationId: state.conversationId,
      conversationUrl: state.conversationUrl,
      targetId: state.targetId,
      pageClosed: state.page.isClosed(),
    }))
  }

  private async connectOnce(): Promise<void> {
    try {
      this.browser = await chromium.connectOverCDP(this.options.cdpEndpoint, {
        timeout: this.connectTimeoutMs,
      })
    } catch (error) {
      this.browser = undefined
      this.context = undefined
      throw new ChatGptSubagentError(
        "BROWSER_UNAVAILABLE",
        [
          "ChatGPT agent browser is unavailable.",
          `Expected an already-running debuggable Chrome instance at ${this.options.cdpEndpoint}.`,
          "This module is attach-only and will not launch Chrome or choose a Chrome profile.",
        ].join(" "),
        { cause: error }
      )
    }

    const [context] = this.browser.contexts()
    if (!context) {
      this.browser = undefined
      this.context = undefined
      throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "Connected Chrome instance did not expose a browser context.")
    }
    this.context = context
  }

  private async createAgent(agentId: string, signal?: AbortSignal): Promise<BrowserAgentState> {
    const context = this.requireContext()
    const page = await context.newPage()
    const tracker = new ChatGptConversationTracker(page)
    const state: BrowserAgentState = {
      agentId,
      page,
      tracker,
      hasSubmittedTurn: false,
    }

    try {
      throwIfAborted(signal)
      state.targetId = await getPageTargetId(context, page)
      await waitForPromise(page.goto(this.chatGptUrl, { waitUntil: "domcontentloaded" }), signal)
      throwIfAborted(signal)
      await assertAuthenticated(page)
      await findComposer(page, this.timeoutMs, signal)
      this.agents.set(state.agentId, state)
      return state
    } catch (error) {
      tracker.dispose()
      if (!page.isClosed()) await page.close()
      throw error
    }
  }

  private getExistingAgent(agentId: string): BrowserAgentState {
    const state = this.agents.get(agentId)
    if (!state) {
      throw new ChatGptSubagentError("UNKNOWN_AGENT", `Unknown ChatGPT subagent: ${agentId}`)
    }
    return state
  }

  private async ensureActivePage(state: BrowserAgentState, signal?: AbortSignal): Promise<BrowserAgentState> {
    throwIfAborted(signal)
    if (!state.page.isClosed() && isExpectedAgentPage(state)) return state
    if (!state.conversationUrl) {
      this.discardUnrecoverableAgent(state)
      throw new ChatGptSubagentError(
        "AGENT_TARGET_LOST",
        `ChatGPT subagent ${state.agentId} no longer owns its original page and has no saved conversation to recover.`
      )
    }

    const context = this.requireContext()
    const page = await context.newPage()
    const tracker = new ChatGptConversationTracker(page)
    try {
      await waitForPromise(page.goto(state.conversationUrl, { waitUntil: "domcontentloaded" }), signal)
      throwIfAborted(signal)
      await assertAuthenticated(page)
      await findComposer(page, this.timeoutMs, signal)
      await page
        .locator("[data-message-author-role]")
        .first()
        .waitFor({
          state: "attached",
          timeout: Math.min(this.timeoutMs, 10_000),
        })

      state.tracker.dispose()
      state.page = page
      state.tracker = tracker
      state.targetId = await getPageTargetId(context, page)
      return state
    } catch (error) {
      tracker.dispose()
      if (!page.isClosed()) await page.close().catch(() => undefined)
      throw error
    }
  }

  private async waitForResponse(
    state: BrowserAgentState,
    input: {
      baselineNetworkIds: ReadonlySet<string>
      baselineDom: readonly DomAssistantMessage[]
      prompt: string
      sentAtSeconds: number
    },
    signal?: AbortSignal
  ): Promise<{ messageId?: string; text: string }> {
    let stableCandidate: { key: string; text: string; since: number } | undefined

    while (true) {
      throwIfAborted(signal)
      if (state.page.isClosed()) {
        throw new ChatGptSubagentError(
          "AGENT_TARGET_LOST",
          `ChatGPT subagent ${state.agentId} page closed while waiting for a response. The submitted turn will not be retried automatically.`
        )
      }
      captureOrValidateConversationLocation(state)

      const networkFinal = state.tracker.findFinalResponse({
        baselineIds: input.baselineNetworkIds,
        prompt: input.prompt,
        sentAtSeconds: input.sentAtSeconds,
      })
      if (networkFinal?.message.text) {
        return {
          messageId: networkFinal.message.id,
          text: networkFinal.message.text,
        }
      }

      const domFinal = await findNewDomAssistantMessage(state.page, input.baselineDom)
      if (domFinal?.text) {
        const generating = await isGenerating(state.page)
        const now = Date.now()
        if (stableCandidate?.key === domFinal.key && stableCandidate.text === domFinal.text) {
          if (!generating && now - stableCandidate.since >= this.responseStableMs) {
            return {
              messageId: domFinal.messageId,
              text: domFinal.text,
            }
          }
        } else {
          this.markTurnActivityForAgent(state.agentId, "Generating response")
          stableCandidate = {
            key: domFinal.key,
            text: domFinal.text,
            since: now,
          }
        }
      }

      await delay(this.pollIntervalMs, signal)
    }
  }

  private async trackTurn(
    turn: BrowserTurnState,
    state: BrowserAgentState,
    input: {
      baselineNetworkIds: ReadonlySet<string>
      baselineDom: readonly DomAssistantMessage[]
      prompt: string
      sentAtSeconds: number
    }
  ): Promise<void> {
    try {
      const answer = await this.waitForResponse(state, input)
      captureOrValidateConversationLocation(state)
      state.lastReturnedMessageId = answer.messageId
      state.lastCompletedAt = Date.now()
      turn.status = "completed"
      turn.messageId = answer.messageId
      turn.response = answer.text
      turn.conversationId = state.conversationId
      turn.conversationUrl = state.conversationUrl ?? state.page.url()
    } catch (error) {
      if (error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST" && !state.conversationUrl) {
        this.discardUnrecoverableAgent(state)
      }
      turn.status = "failed"
      turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
      turn.errorMessage = error instanceof Error ? error.message : String(error)
      turn.conversationId = state.conversationId
      turn.conversationUrl = state.conversationUrl
    } finally {
      state.tracker.setActivityListener(undefined)
      if (this.activeTurnsByAgent.get(state.agentId) === turn.turnId) {
        this.activeTurnsByAgent.delete(state.agentId)
      }
      this.endAgentOperation(state.agentId, true)
    }
  }

  private turnResult(turn: BrowserTurnState): ChatGptSubagentPollResult {
    return {
      agentId: turn.agentId,
      turnId: turn.turnId,
      status: turn.status,
      activity: turn.status === "running" ? turn.activity : undefined,
      activityAgeMs: turn.status === "running" ? Math.max(0, Date.now() - turn.lastActivityAt) : undefined,
      conversationId: turn.conversationId,
      conversationUrl: turn.conversationUrl,
      messageId: turn.messageId,
      response: turn.response,
      errorCode: turn.errorCode,
      errorMessage: turn.errorMessage,
    }
  }

  private markTurnActivityForAgent(agentId: string, activity: ChatGptSubagentActivity): void {
    const turnId = this.activeTurnsByAgent.get(agentId)
    if (!turnId) return
    const turn = this.turns.get(turnId)
    if (!turn || turn.status !== "running") return
    turn.activity = activity
    turn.lastActivityAt = Date.now()
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error("ChatGPT subagent module is not connected to Chrome.")
    return this.context
  }

  private async waitForInterTurn(state: BrowserAgentState, signal?: AbortSignal): Promise<void> {
    if (state.lastCompletedAt === undefined) return
    const remaining = state.lastCompletedAt + this.minInterTurnDelayMs - Date.now()
    if (remaining > 0) await delay(remaining, signal)
  }

  private beginAgentOperation(agentId: string, generation: boolean): void {
    if (this.activeAgentIds.has(agentId)) {
      const activeTurnId = this.activeTurnsByAgent.get(agentId)
      throw new ChatGptSubagentError(
        "AGENT_BUSY",
        activeTurnId
          ? `ChatGPT subagent ${agentId} is still running turn ${activeTurnId}. Poll that turn instead of submitting another prompt.`
          : `ChatGPT subagent ${agentId} already has an operation in progress. Do not queue or automatically retry another turn.`
      )
    }
    if (generation && this.activeGenerationCount >= this.maxConcurrentAgents) {
      throw new ChatGptSubagentError(
        "SUBAGENT_CAPACITY_REACHED",
        `ChatGPT subagent capacity is ${this.maxConcurrentAgents} concurrent generations. Do not queue or automatically retry this request.`
      )
    }

    this.activeAgentIds.add(agentId)
    if (generation) this.activeGenerationCount += 1
  }

  private endAgentOperation(agentId: string, generation: boolean): void {
    this.activeAgentIds.delete(agentId)
    if (generation) this.activeGenerationCount = Math.max(0, this.activeGenerationCount - 1)
  }

  private discardUnrecoverableAgent(state: BrowserAgentState): void {
    state.tracker.dispose()
    if (this.agents.get(state.agentId) === state) {
      this.agents.delete(state.agentId)
    }
  }
}

function normalizeOververbosity(value: number | undefined): number {
  if (value === undefined) return 2
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("oververbosity must be an integer from 1 to 5.")
  }
  return value
}

function appendFirstTurnMode(prompt: string, oververbosity: number): string {
  if (oververbosity === 5) return prompt

  const level = oververbosity === 1 ? "ultra" : oververbosity === 2 ? "full" : "lite"
  const qualifier = oververbosity === 4 ? " Favor completeness over terseness when useful." : ""
  return `${prompt}\n\n---\nSwitch to caveman ${level} mode. ${CAVEMAN_PROMPT}${qualifier}`
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
      messages.push({ id: message.id, role: "user", text: message.text })
      continue
    }
    if (isFinalAssistantNode(node)) {
      messages.push({
        id: message.id,
        role: "assistant",
        text: message.text,
      })
    }
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
  if (message.role !== "assistant") return false
  if (message.status !== "finished_successfully") return false
  if (!message.text) return false
  if (message.recipient && message.recipient !== "all") return false
  if (message.endTurn === false) return false
  return message.endTurn === true || message.isComplete === true
}

function classifyActivity(node: TrackedConversationNode): ChatGptSubagentActivity {
  const recipient = node.message.recipient?.toLowerCase()
  if (recipient && recipient !== "all") {
    if (recipient.includes("web") || recipient.includes("search")) {
      return "Searching the web"
    }
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
  const exact = normalizedPrompt ? users.filter((node) => node.message.text.trim() === normalizedPrompt) : []
  const candidates = exact.length > 0 ? exact : users
  return [...candidates].sort((left, right) => (right.message.createTime ?? 0) - (left.message.createTime ?? 0))[0]
}

function scoreFinalCandidate(
  candidate: TrackedConversationNode,
  userNode: TrackedConversationNode | undefined,
  messages: ReadonlyMap<string, TrackedConversationNode>,
  sentAtSeconds?: number
): number {
  if (userNode) {
    if (userNode.message.turnExchangeId && candidate.message.turnExchangeId === userNode.message.turnExchangeId) {
      return 300
    }
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

  if (sentAtSeconds !== undefined && candidate.message.createTime !== undefined && candidate.message.createTime + 1 < sentAtSeconds) {
    return -1
  }
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

interface DomAssistantMessage {
  key: string
  messageId?: string
  text: string
}

async function findComposer(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<Locator> {
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
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        return locator
      }
    }
    await delay(200, signal)
  }
  throw new ChatGptSubagentError("CHATGPT_UI_CHANGED", `Could not find the ChatGPT composer within ${timeoutMs} ms.`)
}

async function assertAuthenticated(page: Page): Promise<void> {
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

async function enterPrompt(page: Page, composer: Locator, prompt: string): Promise<void> {
  await composer.click()
  await composer.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
  await composer.press("Backspace")
  await page.keyboard.insertText(prompt)
}

async function submitComposer(page: Page, composer: Locator, signal?: AbortSignal): Promise<void> {
  const sendSelectors = ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send" i]']

  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of sendSelectors) {
      const button = page.locator(selector).first()
      if ((await button.count()) > 0 && (await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))) {
        await button.click()
        return
      }
    }
    await delay(50, signal)
  }

  throwIfAborted(signal)
  await composer.press("Enter")
}

async function readAssistantDomMessages(page: Page): Promise<DomAssistantMessage[]> {
  return page.locator('[data-message-author-role="assistant"]').evaluateAll((elements) =>
    elements.map((element, index) => {
      const owner = element.closest("[data-message-id]")
      const messageId = owner?.getAttribute("data-message-id") ?? element.getAttribute("data-message-id") ?? undefined
      return {
        key: messageId ?? `assistant:${index}`,
        messageId,
        text: (element.textContent ?? "").trim(),
      }
    })
  )
}

async function findNewDomAssistantMessage(page: Page, baseline: readonly DomAssistantMessage[]): Promise<DomAssistantMessage | undefined> {
  const current = await readAssistantDomMessages(page)
  if (current.length === 0) return undefined
  const baselineKeys = new Set(baseline.map((message) => message.key))
  const newMessages = current.filter((message) => !baselineKeys.has(message.key))
  if (newMessages.length > 0) return newMessages.at(-1)
  if (current.length > baseline.length) return current.at(-1)
  return undefined
}

async function readVisibleConversation(page: Page): Promise<ChatGptConversationMessage[]> {
  return page.locator("[data-message-author-role]").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const role = element.getAttribute("data-message-author-role")
      if (role !== "user" && role !== "assistant") return []
      const owner = element.closest("[data-message-id]")
      const id = owner?.getAttribute("data-message-id") ?? element.getAttribute("data-message-id") ?? undefined
      const text = (element.textContent ?? "").trim()
      if (!text) return []
      return [{ id, role, text }]
    })
  )
}

async function loadConversationPayload(page: Page, conversationId: string, timeoutMs: number): Promise<unknown> {
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

  await page.reload({ waitUntil: "domcontentloaded" })
  const response = await responsePromise
  return response.json()
}

async function isGenerating(page: Page): Promise<boolean> {
  const selectors = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating" i]', 'button[aria-label="Stop"]']
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return true
    }
  }
  return false
}

async function getPageTargetId(context: BrowserContext, page: Page): Promise<string | undefined> {
  try {
    const session = await context.newCDPSession(page)
    const result = (await session.send("Target.getTargetInfo")) as {
      targetInfo?: { targetId?: string }
    }
    await session.detach()
    return result.targetInfo?.targetId
  } catch {
    return undefined
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

function isExpectedAgentPage(state: BrowserAgentState): boolean {
  const currentUrl = state.page.url()
  if (!isChatGptUrl(currentUrl)) return false

  const currentConversationId = extractConversationId(currentUrl)
  if (state.conversationId) {
    return currentConversationId === state.conversationId
  }
  if (state.conversationUrl) {
    const expectedConversationId = extractConversationId(state.conversationUrl)
    return expectedConversationId ? currentConversationId === expectedConversationId : currentUrl === state.conversationUrl
  }
  return currentConversationId === undefined
}

function assertPreSubmitLocation(state: BrowserAgentState): void {
  if (isExpectedAgentPage(state)) return
  throw new ChatGptSubagentError(
    "AGENT_TARGET_LOST",
    `ChatGPT subagent ${state.agentId} was navigated away from its managed page before submission. No prompt was sent and the changed tab will not be hijacked.`
  )
}

function captureOrValidateConversationLocation(state: BrowserAgentState): void {
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

function isChatGptUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "chatgpt.com"
  } catch {
    return false
  }
}

function validateAgentId(agentId: string): void {
  if (agentId.length < 1 || agentId.length > 64 || agentId.trim().length === 0) {
    throw new Error("agentId must be a non-empty string of at most 64 characters.")
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : stringValue(value)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function booleanOrNull(value: unknown): boolean | null | undefined {
  if (value === null) return null
  return booleanValue(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received ${value}.`)
  }
  return value
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected a non-negative integer, received ${value}.`)
  }
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new ChatGptSubagentError(
    "REQUEST_ABORTED",
    "The ChatGPT subagent request was cancelled. A turn that was already submitted will not be retried automatically."
  )
}

async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort)
    })
  })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
