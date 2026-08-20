import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import { nonNegativeInteger, positiveInteger } from "../../utils.js"
import {
  assertAuthenticated,
  assertConversationAvailable,
  assertPreSubmitLocation,
  captureOrValidateConversationLocation,
  delay,
  dismissBlockingChatGptOverlay,
  enterPrompt,
  extractConversationMessages,
  findComposer,
  findLatestAssistantAfterPrompt,
  isExpectedAgentPage,
  navigateAndCaptureConversationPayload,
  observeAssistantResponse,
  readAssistantDomMessages,
  submitComposer,
  throwIfAborted,
  waitForStableConversationLocation,
  waitForPromise,
  type AssistantResponseObservation,
  type DomAssistantMessage,
} from "./chatgpt-subagent-browser.js"
import {
  ChatGptSubagentError,
  type ChatGptSubagentActivity,
  type ChatGptSubagentOptions,
  type ChatGptSubagentPollResult,
  type ChatGptSubagentRequest,
  type ChatGptSubagentService,
  type ChatGptSubagentStartResult,
} from "./chatgpt-subagent-contracts.js"

const DEFAULT_AGENT_IDLE_TTL_MS = 30 * 60_000
const MAX_CONCURRENT_AGENTS = 3
const CONVERSATION_BIND_TIMEOUT_MS = 30_000
const ASSISTANT_RESPONSE_SETTLE_MS = 500
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const RATE_LIMIT_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"]'
const RATE_LIMIT_DISMISS_SETTLE_MS = 250
const SUBMISSION_GRACE_MS = 500

const INJECTED_PROMPT =
  "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` or `computer_*` tools."

interface BrowserAgentState {
  agentId: string
  page: Page
  hasSubmittedTurn: boolean
  conversationId?: string
  conversationUrl?: string
  lastCompletedAt?: number
  lastUsedAt: number
  turnCount: number
}

interface BrowserTurnState {
  turnId: string
  agentId: string
  status: "running" | "completed" | "failed"
  recoveryAttempted?: boolean
  activity: ChatGptSubagentActivity
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  tracking?: TurnTrackingInput
  observation?: AssistantResponseObservation
  settled?: Promise<void>
  settle?: () => void
}

interface TurnTrackingInput {
  baselineDom: readonly DomAssistantMessage[]
  prompt: string
}

interface StoredConversationRef {
  conversationId: string
  conversationUrl: string
  turnCount: number
}

export class ChatGptSubagentModule implements ChatGptSubagentService {
  private readonly cdpEndpoint: string
  private readonly connectTimeoutMs: number
  private readonly chatGptUrl: string
  private readonly maxConcurrentAgents: number
  private readonly minInterTurnDelayMs: number
  private readonly interactionDelayMs: number
  private readonly timeoutMs: number
  private readonly agents = new Map<string, BrowserAgentState>()
  private readonly conversationRefs = new Map<string, StoredConversationRef>()
  private readonly turns = new Map<string, BrowserTurnState>()
  private readonly activeTurnsByAgent = new Map<string, string>()
  private readonly activeAgentIds = new Set<string>()
  private readonly pendingEvents: string[] = []
  private activeGenerationCount = 0
  private rateLimitedUntil = 0
  private browser?: Browser
  private context?: BrowserContext
  private connectPromise?: Promise<void>
  private readonly cleanupTimer: NodeJS.Timeout
  private disposed = false

  constructor(private readonly options: ChatGptSubagentOptions = {}) {
    this.cdpEndpoint = options.cdpEndpoint ?? MCP_CONFIG.chatGpt.cdpEndpoint
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000
    this.chatGptUrl = options.chatGptUrl ?? MCP_CONFIG.chatGpt.projectUrl
    this.maxConcurrentAgents = Math.min(positiveInteger(options.maxConcurrentAgents, MAX_CONCURRENT_AGENTS), MAX_CONCURRENT_AGENTS)
    this.minInterTurnDelayMs = nonNegativeInteger(options.minInterTurnDelayMs, 1_500)
    this.interactionDelayMs = nonNegativeInteger(options.interactionDelayMs, 300)
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.cleanupTimer = setInterval(() => void this.cleanupIdleAgents(), 60_000)
    this.cleanupTimer.unref()
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
    this.assertNotRateLimited()
    this.beginAgentOperation(request.agentId, true)
    let state: BrowserAgentState | undefined
    let observation: AssistantResponseObservation | undefined
    let operationTransferred = false

    try {
      await this.connect(signal)
      if (this.rateLimitedUntil > 0) await this.clearExpiredRateLimit(signal)
      else await this.detectRateLimit()
      state = this.agents.get(request.agentId)
      if (!state) state = await this.createAgent(request.agentId, signal)

      await this.waitForInterTurn(state, signal)
      const active = await this.ensureActivePage(state, signal)
      throwIfAborted(signal)

      const baselineDom = await readAssistantDomMessages(active.page)
      const submittedPrompt = active.hasSubmittedTurn ? request.prompt : appendFirstTurnMode(request.prompt, request.oververbosity)
      const turnId = `${active.agentId}_turn_${active.turnCount + 1}`
      const settlement = createTurnSettlement()
      const turn: BrowserTurnState = {
        turnId,
        agentId: active.agentId,
        status: "running",
        activity: "Generating response",
        lastActivityAt: Date.now(),
        tracking: {
          baselineDom,
          prompt: submittedPrompt,
        },
        settled: settlement.promise,
        settle: settlement.resolve,
      }

      observation = await observeAssistantResponse(active.page, {
        baselineDom,
        prompt: submittedPrompt,
        settleMs: ASSISTANT_RESPONSE_SETTLE_MS,
        onActivity: (activity) => {
          turn.activity = activity
          turn.lastActivityAt = Date.now()
        },
      })

      await dismissBlockingChatGptOverlay(active.page, signal)
      const composer = await findComposer(active.page, this.timeoutMs, signal)
      await delay(this.interactionDelayMs, signal)
      throwIfAborted(signal)
      assertPreSubmitLocation(active)
      await enterPrompt(active.page, composer, submittedPrompt, signal)
      await delay(this.interactionDelayMs, signal)
      throwIfAborted(signal)
      assertPreSubmitLocation(active)
      await delay(SUBMISSION_GRACE_MS, signal)
      await this.detectRateLimit()
      await submitComposer(active.page, composer, signal)
      active.hasSubmittedTurn = true
      active.lastUsedAt = Date.now()
      active.turnCount += 1
      turn.observation = observation
      this.turns.set(turnId, turn)
      this.activeTurnsByAgent.set(active.agentId, turnId)
      if (!active.conversationId) {
        void waitForStableConversationLocation(active, Math.min(this.timeoutMs, CONVERSATION_BIND_TIMEOUT_MS)).then((bound) => {
          if (bound) this.rememberConversation(active)
        })
      }
      void this.waitForTurnResponse(turn, active)
      observation = undefined
      operationTransferred = true

      return {
        agentId: active.agentId,
        turnId,
        status: "running",
      }
    } catch (error) {
      await observation?.dispose().catch(() => undefined)
      if (state && error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST" && !state.conversationUrl) {
        this.discardUnrecoverableAgent(state)
      }
      throw error
    } finally {
      if (!operationTransferred) this.endAgentOperation(request.agentId, true)
    }
  }

  async poll(turnId: string, waitMs: number, signal?: AbortSignal): Promise<ChatGptSubagentPollResult> {
    const turn = this.turns.get(turnId)
    if (!turn) {
      throw new ChatGptSubagentError("UNKNOWN_TURN", `Unknown ChatGPT subagent turn: ${turnId}`)
    }

    if (turn.status === "running" && waitMs > 0 && turn.settled) await waitForTurnSettlement(turn.settled, waitMs, signal)
    throwIfAborted(signal)
    return this.turnResult(turn)
  }

  drainEvents(): string[] {
    return this.pendingEvents.splice(0)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.cleanupTimer)
    const browser = this.browser
    const states = [...this.agents.values()]
    const ownedPages: Page[] = []
    for (const state of states) {
      if (!state.page.isClosed() && isExpectedAgentPage(state)) ownedPages.push(state.page)
    }
    const observations = [...this.turns.values()].map((turn) => turn.observation).filter((value): value is AssistantResponseObservation => value !== undefined)

    this.agents.clear()
    this.conversationRefs.clear()
    this.turns.clear()
    this.activeTurnsByAgent.clear()
    this.activeAgentIds.clear()
    this.pendingEvents.length = 0
    this.activeGenerationCount = 0
    this.context = undefined
    this.browser = undefined
    this.connectPromise = undefined

    await Promise.allSettled([...observations.map((observation) => observation.dispose()), ...ownedPages.map((page) => page.close())])
    await browser?.close().catch(() => undefined)
  }

  private async connectOnce(): Promise<void> {
    try {
      const { chromium } = await import("playwright-core")
      this.browser = await chromium.connectOverCDP(this.cdpEndpoint, { timeout: this.connectTimeoutMs })
    } catch (error) {
      this.browser = undefined
      this.context = undefined
      throw new ChatGptSubagentError(
        "BROWSER_UNAVAILABLE",
        [
          "ChatGPT agent browser is unavailable.",
          `Expected an already-running debuggable Chrome instance at ${this.cdpEndpoint}.`,
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
    await this.afterPageCreated()
    const stored = this.conversationRefs.get(agentId)
    const state: BrowserAgentState = {
      agentId,
      page,
      hasSubmittedTurn: stored !== undefined,
      conversationId: stored?.conversationId,
      conversationUrl: stored?.conversationUrl,
      lastUsedAt: Date.now(),
      turnCount: stored?.turnCount ?? 0,
    }

    try {
      throwIfAborted(signal)
      await waitForPromise(page.goto(stored?.conversationUrl ?? this.chatGptUrl, { waitUntil: "domcontentloaded" }), signal)
      throwIfAborted(signal)
      await assertAuthenticated(page)
      if (stored) await assertConversationAvailable(page, stored.conversationId, this.timeoutMs, signal)
      await findComposer(page, this.timeoutMs, signal)
      this.agents.set(state.agentId, state)
      return state
    } catch (error) {
      if (!page.isClosed()) await page.close()
      throw error
    }
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
    await this.afterPageCreated()
    try {
      await waitForPromise(page.goto(state.conversationUrl, { waitUntil: "domcontentloaded" }), signal)
      throwIfAborted(signal)
      await assertAuthenticated(page)
      if (state.conversationId) await assertConversationAvailable(page, state.conversationId, this.timeoutMs, signal)
      await findComposer(page, this.timeoutMs, signal)

      state.page = page
      state.lastUsedAt = Date.now()
      this.rememberConversation(state)
      return state
    } catch (error) {
      if (!page.isClosed()) await page.close().catch(() => undefined)
      if (error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CONVERSATION_NOT_FOUND") this.discardUnrecoverableAgent(state)
      throw error
    }
  }

  private async waitForTurnResponse(turn: BrowserTurnState, state: BrowserAgentState): Promise<void> {
    const observation = turn.observation
    if (!observation) return

    try {
      const response = await observation.response
      if (this.disposed || turn.status !== "running") return
      try {
        captureOrValidateConversationLocation(state)
        this.rememberConversation(state)
      } catch {
        // The structured response is enough to complete even if the managed tab moved afterward.
      }
      this.completeTurn(turn, state, response)
    } catch (error) {
      if (this.disposed || turn.status !== "running") return
      await this.failOrRecoverSubmittedTurn(turn, state, error)
    }
  }

  private async failOrRecoverSubmittedTurn(turn: BrowserTurnState, state: BrowserAgentState, originalError: unknown, signal?: AbortSignal): Promise<void> {
    if (turn.status !== "running") return
    if (!state.conversationId && !state.page.isClosed()) {
      try {
        captureOrValidateConversationLocation(state)
        this.rememberConversation(state)
      } catch {
        // Recovery below will fail cleanly when no stable conversation identity exists.
      }
    }

    if (!turn.recoveryAttempted && state.conversationId && state.conversationUrl && turn.tracking) {
      turn.recoveryAttempted = true
      try {
        await this.recoverSubmittedTurn(turn, state, signal)
        if (turn.status !== "running") return
      } catch (recoveryError) {
        if (recoveryError instanceof ChatGptSubagentError && recoveryError.code === "REQUEST_ABORTED") throw recoveryError
        originalError = recoveryError
      }
    }

    if (originalError instanceof ChatGptSubagentError && originalError.code === "AGENT_TARGET_LOST" && !state.conversationUrl) {
      this.discardUnrecoverableAgent(state)
    }
    this.failTurn(turn, state, originalError)
  }

  private async recoverSubmittedTurn(turn: BrowserTurnState, state: BrowserAgentState, signal?: AbortSignal): Promise<void> {
    if (!state.conversationId || !state.conversationUrl || !turn.tracking) {
      throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${state.agentId} has no saved conversation to recover.`)
    }

    const context = this.requireContext()
    const oldPage = state.page
    const closeOldPage = !oldPage.isClosed() && isExpectedAgentPage(state)
    const page = await context.newPage()
    await this.afterPageCreated()

    try {
      const payload = await navigateAndCaptureConversationPayload(page, state.conversationUrl, state.conversationId, this.timeoutMs, signal)
      throwIfAborted(signal)
      await assertAuthenticated(page)
      await assertConversationAvailable(page, state.conversationId, this.timeoutMs, signal)

      state.page = page
      state.lastUsedAt = Date.now()
      this.rememberConversation(state)
      if (closeOldPage) await oldPage.close().catch(() => undefined)

      const messages = payload ? extractConversationMessages(payload) : []
      const answer = findLatestAssistantAfterPrompt(messages, turn.tracking.prompt)
      if (answer?.text) {
        this.completeTurn(turn, state, answer.text)
        return
      }

      const recoveryBaseline = await readAssistantDomMessages(page)
      const recoveryObservation = await observeAssistantResponse(page, {
        baselineDom: recoveryBaseline,
        prompt: turn.tracking.prompt,
        settleMs: ASSISTANT_RESPONSE_SETTLE_MS,
        onActivity: (activity) => {
          turn.activity = activity
          turn.lastActivityAt = Date.now()
        },
      })
      turn.observation = recoveryObservation
      const response = await recoveryObservation.response
      if (turn.status === "running") this.completeTurn(turn, state, response)
    } catch (error) {
      if (state.page !== page && !page.isClosed()) await page.close().catch(() => undefined)
      throw error
    }
  }

  private completeTurn(turn: BrowserTurnState, state: BrowserAgentState, response: string): void {
    if (turn.status !== "running") return
    state.lastCompletedAt = Date.now()
    state.lastUsedAt = state.lastCompletedAt
    turn.status = "completed"
    turn.response = response
    void turn.observation?.dispose().catch(() => undefined)
    turn.observation = undefined
    this.rememberConversation(state)
    this.finishTurnOperation(turn, state)
    turn.settle?.()
    turn.settle = undefined
    this.pendingEvents.push(`agent_finished:${turn.agentId}:${turn.turnId}`)
  }

  private failTurn(turn: BrowserTurnState, state: BrowserAgentState, error: unknown): void {
    if (turn.status !== "running") return
    turn.status = "failed"
    turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
    turn.errorMessage = error instanceof Error ? error.message : String(error)
    void turn.observation?.dispose().catch(() => undefined)
    turn.observation = undefined
    this.finishTurnOperation(turn, state)
    turn.settle?.()
    turn.settle = undefined
  }

  private finishTurnOperation(turn: BrowserTurnState, state: BrowserAgentState): void {
    if (this.activeTurnsByAgent.get(state.agentId) !== turn.turnId) return
    this.activeTurnsByAgent.delete(state.agentId)
    this.endAgentOperation(state.agentId, true)
  }

  private turnResult(turn: BrowserTurnState): ChatGptSubagentPollResult {
    return {
      turnId: turn.turnId,
      status: turn.status,
      activity: turn.status === "running" ? turn.activity : undefined,
      activityAgeMs: turn.status === "running" ? Math.max(0, Date.now() - turn.lastActivityAt) : undefined,
      response: turn.response,
      errorCode: turn.errorCode,
      errorMessage: turn.errorMessage,
    }
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

  private assertNotRateLimited(): void {
    if (Date.now() >= this.rateLimitedUntil) return
    throw new ChatGptSubagentError(
      "SUBAGENT_RATE_LIMITED",
      "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."
    )
  }

  private async detectRateLimit(): Promise<void> {
    this.assertNotRateLimited()
    for (const page of this.requireContext().pages()) {
      if (!page.url().startsWith("https://chatgpt.com/")) continue
      const modal = page.locator(RATE_LIMIT_SELECTOR).first()
      if (!(await modal.isVisible().catch(() => false))) continue
      this.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
      this.assertNotRateLimited()
    }
  }

  private async clearExpiredRateLimit(signal?: AbortSignal): Promise<void> {
    this.assertNotRateLimited()
    this.rateLimitedUntil = 0
    let dismissed = false

    for (const page of this.requireContext().pages()) {
      if (!page.url().startsWith("https://chatgpt.com/")) continue
      const modal = page.locator(RATE_LIMIT_SELECTOR).first()
      if (!(await modal.isVisible().catch(() => false))) continue
      const clicked = await modal
        .getByRole("button", { name: "Got it", exact: true })
        .first()
        .click()
        .then(
          () => true,
          () => false
        )
      dismissed ||= clicked
    }

    if (dismissed) await delay(RATE_LIMIT_DISMISS_SETTLE_MS, signal)
    await this.detectRateLimit()
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
    const wasActive = this.activeAgentIds.delete(agentId)
    if (generation && wasActive) this.activeGenerationCount = Math.max(0, this.activeGenerationCount - 1)
  }

  private discardUnrecoverableAgent(state: BrowserAgentState): void {
    if (this.agents.get(state.agentId) === state) this.agents.delete(state.agentId)
  }

  private rememberConversation(state: BrowserAgentState): void {
    if (!state.conversationId || !state.conversationUrl) return
    this.conversationRefs.set(state.agentId, {
      conversationId: state.conversationId,
      conversationUrl: state.conversationUrl,
      turnCount: state.turnCount,
    })
  }

  private async afterPageCreated(): Promise<void> {
    try {
      await this.options.onPageCreated?.()
    } catch {
      // Browser visibility is best effort and must never break subagent work.
    }
  }

  private async cleanupIdleAgents(now = Date.now()): Promise<void> {
    const staleStates = [...this.agents.values()].filter((state) => {
      const activeTurnId = this.activeTurnsByAgent.get(state.agentId)
      const activeTurn = activeTurnId ? this.turns.get(activeTurnId) : undefined

      if (activeTurn?.status === "running") return now - activeTurn.lastActivityAt >= DEFAULT_AGENT_IDLE_TTL_MS
      if (this.activeAgentIds.has(state.agentId)) return false
      return now - state.lastUsedAt >= DEFAULT_AGENT_IDLE_TTL_MS
    })

    for (const state of staleStates) {
      this.rememberConversation(state)
      const activeTurnId = this.activeTurnsByAgent.get(state.agentId)
      const activeTurn = activeTurnId ? this.turns.get(activeTurnId) : undefined
      if (activeTurn?.status === "running") {
        this.failTurn(
          activeTurn,
          state,
          new ChatGptSubagentError("AGENT_IDLE_EXPIRED", "ChatGPT subagent turn expired after 30 minutes without observable progress.")
        )
      }

      this.agents.delete(state.agentId)
      this.removeTurnsForAgent(state.agentId)

      if (!state.page.isClosed() && isExpectedAgentPage(state)) await state.page.close().catch(() => undefined)
    }
  }

  private removeTurnsForAgent(agentId: string): void {
    this.activeTurnsByAgent.delete(agentId)
    for (const [turnId, turn] of this.turns) {
      if (turn.agentId !== agentId) continue
      void turn.observation?.dispose().catch(() => undefined)
      turn.settle?.()
      this.turns.delete(turnId)
      const event = `agent_finished:${turn.agentId}:${turn.turnId}`
      for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1) {
        if (this.pendingEvents[index] === event) this.pendingEvents.splice(index, 1)
      }
    }
  }
}

function appendFirstTurnMode(prompt: string, oververbosity: number): string {
  if (oververbosity === 5) return prompt

  const level = oververbosity === 1 ? "ultra" : oververbosity === 2 ? "full" : "lite"
  const qualifier = oververbosity === 4 ? " Favor completeness over terseness when useful." : ""
  return `${prompt}\n\n---\n\nSwitch to caveman ${level} mode. ${INJECTED_PROMPT}${qualifier}`
}

function createTurnSettlement(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForTurnSettlement(settled: Promise<void>, waitMs: number, signal?: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs)
  })
  try {
    await waitForPromise(Promise.race([settled, timeout]), signal)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
