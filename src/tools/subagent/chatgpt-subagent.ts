import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import { nonNegativeInteger, positiveInteger } from "../../utils.js"
import {
  assertAuthenticated,
  assertConversationAvailable,
  assertPreSubmitLocation,
  captureOrValidateConversationLocation,
  ChatGptConversationTracker,
  delay,
  dismissBlockingChatGptOverlay,
  enterPrompt,
  extractConversationMessages,
  findComposer,
  findLatestAssistantAfterPrompt,
  findNewDomAssistantMessage,
  getConversationStreamStatus,
  isExpectedAgentPage,
  isGenerating,
  loadConversationPayload,
  readAssistantDomMessages,
  submitComposer,
  throwIfAborted,
  waitForStableConversationLocation,
  waitForPromise,
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
const COMPLETION_WATCH_INTERVAL_MS = 1_000
const COMPLETION_DOM_GRACE_MS = 5_000
const CONVERSATION_BIND_TIMEOUT_MS = 30_000

const CAVEMAN_PROMPT =
  "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` tools."

interface BrowserAgentState {
  agentId: string
  page: Page
  tracker: ChatGptConversationTracker
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
  recoveryPromise?: Promise<boolean>
  activity: ChatGptSubagentActivity
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  tracking?: TurnTrackingInput
}

interface TurnTrackingInput {
  baselineNetworkIds: ReadonlySet<string>
  baselineDom: readonly DomAssistantMessage[]
  prompt: string
  sentAtSeconds: number
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
  private browser?: Browser
  private context?: BrowserContext
  private connectPromise?: Promise<void>
  private readonly cleanupTimer: NodeJS.Timeout
  private disposed = false

  constructor(private readonly options: ChatGptSubagentOptions = {}) {
    this.cdpEndpoint = options.cdpEndpoint ?? MCP_CONFIG.chatGpt.cdpEndpoint
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000
    this.chatGptUrl = options.chatGptUrl ?? "https://chatgpt.com/"
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
        const streamStatus = active.conversationId
          ? await getConversationStreamStatus(active.page, active.conversationId)
          : undefined
        if (streamStatus !== "COMPLETE") {
          throw new ChatGptSubagentError(
            "AGENT_BUSY",
            `ChatGPT subagent ${active.agentId} is still generating. Do not retry automatically; wait before sending another turn.`
          )
        }

        await waitForPromise(active.page.reload({ waitUntil: "domcontentloaded" }), signal)
        throwIfAborted(signal)
        await assertConversationAvailable(active.page, active.conversationId!, this.timeoutMs, signal)
      }

      const baselineNetworkIds = active.tracker.snapshotIds()
      const baselineDom = await readAssistantDomMessages(active.page)
      const sentAtSeconds = Date.now() / 1000

      await dismissBlockingChatGptOverlay(active.page, signal)
      const composer = await findComposer(active.page, this.timeoutMs, signal)
      await delay(this.interactionDelayMs, signal)
      throwIfAborted(signal)
      assertPreSubmitLocation(active)
      const submittedPrompt = active.hasSubmittedTurn ? prompt : appendFirstTurnMode(prompt, oververbosity)
      await enterPrompt(active.page, composer, submittedPrompt, signal)
      await delay(this.interactionDelayMs, signal)
      throwIfAborted(signal)
      assertPreSubmitLocation(active)
      await submitComposer(active.page, composer, signal)
      active.hasSubmittedTurn = true
      active.lastUsedAt = Date.now()
      active.turnCount += 1
      const turnId = `${active.agentId}_turn_${active.turnCount}`
      const tracking: TurnTrackingInput = {
        baselineNetworkIds,
        baselineDom,
        prompt: submittedPrompt,
        sentAtSeconds,
      }
      const turn: BrowserTurnState = {
        turnId,
        agentId: active.agentId,
        status: "running",
        activity: "Generating response",
        lastActivityAt: Date.now(),
        tracking,
      }
      this.turns.set(turnId, turn)
      this.activeTurnsByAgent.set(active.agentId, turnId)
      this.attachTurnListeners(active, turn)
      if (!active.conversationId) {
        void waitForStableConversationLocation(active, Math.min(this.timeoutMs, CONVERSATION_BIND_TIMEOUT_MS)).then((bound) => {
          if (bound) this.rememberConversation(active)
        })
      }
      void this.watchTurnCompletion(turn, active)
      operationTransferred = true

      return {
        agentId: active.agentId,
        turnId,
        status: "running",
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

    const boundedWaitMs = Math.min(Math.max(0, waitMs), 60_000)
    const deadline = Date.now() + boundedWaitMs
    while (turn.status === "running") {
      await this.reconcileRunningTurn(turn, signal)
      if (turn.status !== "running" || Date.now() >= deadline) break
      const remaining = deadline - Date.now()
      await delay(Math.min(1_000, remaining), signal)
    }
    throwIfAborted(signal)
    return this.turnResult(turn)
  }

  drainEvents(): string[] {
    return this.pendingEvents.splice(0)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.cleanupTimer)
    const states = [...this.agents.values()]
    const ownedPages: Page[] = []
    for (const state of states) {
      state.tracker.dispose()
      if (!state.page.isClosed() && isExpectedAgentPage(state)) ownedPages.push(state.page)
    }

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

    await Promise.allSettled(ownedPages.map((page) => page.close()))
  }

  private async connectOnce(): Promise<void> {
    try {
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
    const tracker = new ChatGptConversationTracker(page)
    const stored = this.conversationRefs.get(agentId)
    const state: BrowserAgentState = {
      agentId,
      page,
      tracker,
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
      tracker.dispose()
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
    const tracker = new ChatGptConversationTracker(page)
    try {
      await waitForPromise(page.goto(state.conversationUrl, { waitUntil: "domcontentloaded" }), signal)
      throwIfAborted(signal)
      await assertAuthenticated(page)
      if (state.conversationId) await assertConversationAvailable(page, state.conversationId, this.timeoutMs, signal)
      await findComposer(page, this.timeoutMs, signal)

      state.tracker.dispose()
      state.page = page
      state.tracker = tracker
      state.lastUsedAt = Date.now()
      this.rememberConversation(state)
      return state
    } catch (error) {
      tracker.dispose()
      if (!page.isClosed()) await page.close().catch(() => undefined)
      if (error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CONVERSATION_NOT_FOUND") this.discardUnrecoverableAgent(state)
      throw error
    }
  }

  private async reconcileRunningTurn(turn: BrowserTurnState, signal?: AbortSignal): Promise<void> {
    if (turn.status !== "running" || !turn.tracking) return
    const state = this.agents.get(turn.agentId)
    if (!state) return

    try {
      // A submitted first turn naturally moves from / to /c/<id>; bind that URL before strict page recovery validation.
      if (!state.conversationId && !state.conversationUrl && !state.page.isClosed()) {
        captureOrValidateConversationLocation(state)
      }
      const active = await this.ensureActivePage(state, signal)
      this.attachTurnListeners(active, turn)
      if (turn.status !== "running") return
      captureOrValidateConversationLocation(active)
      this.rememberConversation(active)

      const domFinal = await findNewDomAssistantMessage(active.page, turn.tracking.baselineDom)
      if (!domFinal?.text) return
      const [streamStatus, uiGenerating] = await Promise.all([
        active.conversationId ? getConversationStreamStatus(active.page, active.conversationId) : Promise.resolve(undefined),
        isGenerating(active.page),
      ])
      if (streamStatus === "IS_STREAMING") return
      if (streamStatus !== "COMPLETE" && uiGenerating) return

      this.completeTurn(turn, active, domFinal.text)
    } catch (error) {
      if (turn.status !== "running") return
      if (error instanceof ChatGptSubagentError && error.code === "REQUEST_ABORTED") throw error
      await this.failOrRecoverSubmittedTurn(turn, state, error, signal)
    }
  }

  private async failOrRecoverSubmittedTurn(
    turn: BrowserTurnState,
    state: BrowserAgentState,
    originalError: unknown,
    signal?: AbortSignal
  ): Promise<"retry" | "terminal"> {
    if (turn.status !== "running") return "terminal"
    if (originalError instanceof ChatGptSubagentError && originalError.code === "REQUEST_ABORTED") throw originalError

    if (turn.recoveryPromise) {
      try {
        const recovered = await turn.recoveryPromise
        if (turn.status !== "running") return "terminal"
        if (recovered) return "retry"
      } catch (recoveryError) {
        if (recoveryError instanceof ChatGptSubagentError && recoveryError.code === "REQUEST_ABORTED") throw recoveryError
      }
    }

    if (!turn.recoveryAttempted && (state.conversationId || state.conversationUrl)) {
      turn.recoveryAttempted = true
      const recoveryPromise = this.recoverSubmittedTurn(turn, state, signal)
      turn.recoveryPromise = recoveryPromise
      try {
        const recovered = await recoveryPromise
        if (turn.status !== "running") return "terminal"
        if (recovered) return "retry"
      } catch (recoveryError) {
        if (recoveryError instanceof ChatGptSubagentError && recoveryError.code === "REQUEST_ABORTED") throw recoveryError
      } finally {
        if (turn.recoveryPromise === recoveryPromise) turn.recoveryPromise = undefined
      }
    }

    if (originalError instanceof ChatGptSubagentError && originalError.code === "AGENT_TARGET_LOST" && !state.conversationUrl) {
      this.discardUnrecoverableAgent(state)
    }
    turn.status = "failed"
    turn.errorCode = originalError instanceof ChatGptSubagentError ? originalError.code : "subagent_failed"
    turn.errorMessage = originalError instanceof Error ? originalError.message : String(originalError)
    this.finishTurnOperation(turn, state)
    return "terminal"
  }

  private async recoverSubmittedTurn(turn: BrowserTurnState, state: BrowserAgentState, signal?: AbortSignal): Promise<boolean> {
    const active = await this.ensureActivePage(state, signal)
    captureOrValidateConversationLocation(active)
    this.rememberConversation(active)

    if (active.conversationId) {
      const payload = await loadConversationPayload(active.page, active.conversationId, this.timeoutMs)
      const messages = extractConversationMessages(payload)
      const answer = findLatestAssistantAfterPrompt(messages, turn.tracking?.prompt)
      if (answer?.text) {
        this.completeTurn(turn, active, answer.text)
        return true
      }
    }

    const domFinal = turn.tracking ? await findNewDomAssistantMessage(active.page, turn.tracking.baselineDom) : undefined
    if (!domFinal?.text || (await isGenerating(active.page))) return true

    this.completeTurn(turn, active, domFinal.text)
    return true
  }

  private completeTurn(turn: BrowserTurnState, state: BrowserAgentState, response: string): void {
    if (turn.status !== "running") return
    state.lastCompletedAt = Date.now()
    state.lastUsedAt = state.lastCompletedAt
    turn.status = "completed"
    turn.response = response
    this.rememberConversation(state)
    this.finishTurnOperation(turn, state)
    this.pendingEvents.push(`agent_finished:${turn.agentId}:${turn.turnId}`)
  }

  private attachTurnListeners(state: BrowserAgentState, turn: BrowserTurnState): void {
    state.tracker.setActivityListener((activity) => {
      if (turn.status !== "running") return
      turn.activity = activity
      turn.lastActivityAt = Date.now()
    })
    const completeTrackedTurn = () => {
      if (turn.status !== "running" || !turn.tracking) return
      const final = state.tracker.findFinalResponse({
        baselineIds: turn.tracking.baselineNetworkIds,
        prompt: turn.tracking.prompt,
        sentAtSeconds: turn.tracking.sentAtSeconds,
      })
      if (!final?.message.text) return
      try {
        captureOrValidateConversationLocation(state)
        this.rememberConversation(state)
      } catch {
        // Final network response is enough to complete the turn even if the
        // managed page moved. The saved conversation reference may be stale.
      }
      this.completeTurn(turn, state, final.message.text)
    }
    state.tracker.setUpdateListener(completeTrackedTurn)
    completeTrackedTurn()
  }

  private async watchTurnCompletion(turn: BrowserTurnState, state: BrowserAgentState): Promise<void> {
    if (!turn.tracking) return
    let stableFallback: { key: string; text: string; since: number } | undefined
    let serverCompletionConfirmed = false

    while (!this.disposed && turn.status === "running") {
      try {
        const [streamStatus, uiGenerating, domFinal] = await Promise.all([
          state.conversationId ? getConversationStreamStatus(state.page, state.conversationId) : Promise.resolve(undefined),
          isGenerating(state.page),
          findNewDomAssistantMessage(state.page, turn.tracking.baselineDom),
        ])
        if (turn.status !== "running") return

        if (streamStatus === "COMPLETE") {
          if (domFinal?.text) {
            this.completeTurn(turn, state, domFinal.text)
            return
          }

          if (!serverCompletionConfirmed) {
            serverCompletionConfirmed = true
            const deadline = Date.now() + COMPLETION_DOM_GRACE_MS
            while (!this.disposed && turn.status === "running" && Date.now() < deadline) {
              await delay(Math.min(COMPLETION_WATCH_INTERVAL_MS, deadline - Date.now()))
              if (turn.status !== "running") return
              const delayedDomFinal = await findNewDomAssistantMessage(state.page, turn.tracking.baselineDom)
              if (!delayedDomFinal?.text) continue
              this.completeTurn(turn, state, delayedDomFinal.text)
              return
            }

            if (turn.status !== "running") return
            if (!turn.recoveryAttempted) {
              turn.recoveryAttempted = true
              const recoveryPromise = this.recoverSubmittedTurn(turn, state)
              turn.recoveryPromise = recoveryPromise
              try {
                await recoveryPromise
              } catch {
                // Explicit result reconciliation remains the terminal recovery boundary.
              } finally {
                if (turn.recoveryPromise === recoveryPromise) turn.recoveryPromise = undefined
              }
              if (turn.status !== "running") return
            }
          }
        } else if (streamStatus === "IS_STREAMING") {
          stableFallback = undefined
        } else if (!uiGenerating && domFinal?.text) {
          const now = Date.now()
          if (stableFallback?.key === domFinal.key && stableFallback.text === domFinal.text) {
            if (now - stableFallback.since >= COMPLETION_WATCH_INTERVAL_MS) {
              this.completeTurn(turn, state, domFinal.text)
              return
            }
          } else {
            stableFallback = { key: domFinal.key, text: domFinal.text, since: now }
          }
        } else {
          stableFallback = undefined
        }
      } catch {
        // This watcher is redundant by design. page.on(...) and explicit result
        // reconciliation remain available if one observation tick fails.
      }

      if (!this.disposed && turn.status === "running") await delay(COMPLETION_WATCH_INTERVAL_MS)
    }
  }

  private finishTurnOperation(turn: BrowserTurnState, state: BrowserAgentState): void {
    state.tracker.setActivityListener(undefined)
    state.tracker.setUpdateListener(undefined)
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
    state.tracker.dispose()
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
        activeTurn.status = "failed"
        activeTurn.errorCode = "AGENT_IDLE_EXPIRED"
        activeTurn.errorMessage = "ChatGPT subagent turn expired after 30 minutes without observable progress."
        this.endAgentOperation(state.agentId, true)
      }

      state.tracker.dispose()
      this.agents.delete(state.agentId)
      this.removeTurnsForAgent(state.agentId)

      if (!state.page.isClosed() && isExpectedAgentPage(state)) await state.page.close().catch(() => undefined)
    }
  }

  private removeTurnsForAgent(agentId: string): void {
    this.activeTurnsByAgent.delete(agentId)
    for (const [turnId, turn] of this.turns) {
      if (turn.agentId !== agentId) continue
      this.turns.delete(turnId)
      const event = `agent_finished:${turn.agentId}:${turn.turnId}`
      for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1) {
        if (this.pendingEvents[index] === event) this.pendingEvents.splice(index, 1)
      }
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
  return `${prompt}\n\n---\n\nSwitch to caveman ${level} mode. ${CAVEMAN_PROMPT}${qualifier}`
}

function validateAgentId(agentId: string): void {
  if (agentId.length < 1 || agentId.length > 64 || agentId.trim().length === 0) {
    throw new Error("agentId must be a non-empty string of at most 64 characters.")
  }
}
