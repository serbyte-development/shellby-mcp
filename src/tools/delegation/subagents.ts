/** biome-ignore-all lint/style/noExcessiveLinesPerFile: This is the full subagent module.  */
import { join } from "node:path"
import type { Browser, BrowserContext, Page } from "playwright-core"

import { type AgentIdentity, bindAgentParent, getAgentIdentity } from "../../agent/context.js"
import { MCP_CONFIG } from "../../config.js"
import { readStartHereIdentity } from "../start-here/start-here.js"
import {
  assertAuthenticated,
  createBackgroundPage,
  delay,
  dismissBlockingChatGptOverlay,
  enterPrompt,
  extractConversationId,
  findComposer,
  isChatGptUrl,
  navigateAndCaptureConversationPayload,
  readConversationPayload,
  submitComposer,
  throwIfAborted,
  waitForPromise,
} from "./chatgpt-browser.js"
import { prepareConversationTab } from "./conversation-tab.js"
import { DelegationDiagnostics } from "./diagnostics.js"
import { type AssistantResponseObservation, observeAssistantResponse } from "./response-observer.js"
import { createDelegationStore, DelegationStoreError } from "./store.js"
import { ChatGptDelegationError } from "./subagent-error.js"
import { extractConversationMessages, findLatestAssistantAfterMessage } from "./turn-protocol.js"

const CLEANUP_INTERVAL_MS = 60_000
const CONNECT_TIMEOUT_MS = 3_000
const SUBAGENT_RUN_DELAYS_MS = [1_000, 5_000, 7_000] as const
const MIN_INTER_TURN_DELAY_MS = 1_500
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const RATE_LIMIT_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"]'
const RATE_LIMIT_DISMISS_SETTLE_MS = 250
const RATE_LIMIT_DISMISS_BUTTON_PATTERN = /got it|okay|ok|close/iu
const RATE_LIMIT_ERROR_MESSAGE =
  "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."

const AGENT_IDLE_TTL_MS = 30 * 60_000
const IDLE_HISTORY_CHECK_MS = 3 * 60_000
const TURN_RESULT_TTL_MS = 24 * 60 * 60_000
const MAX_RETAINED_TURNS = 100
const PROJECT_PATH_PATTERN = /\/g\/g-p-[^/]+\/project\/?$/u
const PROJECT_SUFFIX_PATTERN = /\/project\/?$/u

const INJECTED_PROMPT = `If missing information or ambiguity would materially change the result, return concise clarifying questions before starting work. Otherwise, proceed and state any relevant assumptions.\n\n---\n\nOververbosity: 1.\n\nDo not use \`subagent\`${MCP_CONFIG.tools.computer ? " or `computer_*`" : ""} tools.`

/** Coarse activity inferred from traffic belonging to the submitted user message. */
export const agentActivities = [
  "Working",
  "Searching the web",
  "Using tools",
  "Generating response",
] as const
export type AgentActivity = (typeof agentActivities)[number]
export const agentResponseStatuses = ["running", "completed", "failed"] as const

export interface AgentRequest {
  agentId: string
  prompt: string
  /** Conversation ID or ChatGPT URL to fork for a new agent; saved identity takes precedence. */
  startSource?: string
}

export interface AgentCallContext {
  /** Cancels preparation/submission or polling; an already submitted turn keeps running. */
  signal?: AbortSignal
}

export interface AgentResponse {
  status: (typeof agentResponseStatuses)[number]
  activity?: AgentActivity
  activityAgeMs?: number
  response?: string
  errorCode?: string
  errorMessage?: string
}

export type AgentRunResult =
  | { agentId: string; status: "running"; turnId: string }
  | { agentId: string; status: "failed"; error: unknown }

export interface AgentResponseResult extends AgentResponse {
  turnId: string
  /** A lookup or polling failure, as opposed to a submitted turn's retained failure. */
  error?: unknown
}

export interface Subagents {
  /**
   * Submit in input order with the existing inter-agent pacing. Returns only after
   * each attempted submission finishes; generation continues in the background.
   * Failures are per entry. Cancellation during pacing stops the remaining batch.
   */
  runAgents(
    requests: readonly AgentRequest[],
    context?: AgentCallContext
  ): Promise<AgentRunResult[]>
  /** Poll concurrently, preserving input order and individual failures; waitMs is per turn. */
  getAgentResponses(
    turnIds: readonly string[],
    waitMs: number,
    signal?: AbortSignal
  ): Promise<AgentResponseResult[]>
  /** Drain completion and restored-agent notices for the current caller once. */
  drainEvents(): string[]
  /** Close owned tabs/store and detach from Chrome without shutting down the browser. */
  dispose(): Promise<void>
}

type BrowserAgentStatus = "idle" | "uncertain" | AgentActivity

interface AgentState {
  agentId: string
  identity?: AgentIdentity
  status: BrowserAgentStatus
  page?: Page
  conversationUrl?: string
  lastCompletedAt?: number
  lastUsedAt: number
  /** Local submission numbering only; neither conversation restoration nor recovery relies on it. */
  turnCount: number
}

interface TurnState {
  turnId: string
  agentId: string
  parentAgent?: AgentIdentity
  status: (typeof agentResponseStatuses)[number]
  /** Quiet checks are paced independently of upstream activity and failure recovery. */
  lastHistoryCheckAt?: number
  recoveryAttempted: boolean
  /** Last observed turn progress in epoch milliseconds; connection keepalives do not count. */
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  /** ChatGPT's outgoing user-message ID, shared by streaming and history recovery. */
  submittedMessageId?: string
  settledAt?: number
  observation?: AssistantResponseObservation
  settled: Promise<void>
  settle: () => void
}

interface ActiveAgentOperation extends AgentCallContext {
  turnId?: string
}

interface DelegationScope {
  agents: Map<string, AgentState>
  turns: Map<string, TurnState>
  activeOperations: Map<string, ActiveAgentOperation>
  pendingEvents: string[]
}

type IdleCleanupAction =
  | {
      kind: "check-history"
      turn: TurnState
    }
  | {
      kind: "recover"
      turn: TurnState
      error: ChatGptDelegationError
    }
  | {
      kind: "close-page"
      agent: AgentState
      page: Page
    }

/**
 * Process-level owner of caller-scoped agents and turns. Browser preparation,
 * observation, persistence, recovery and settlement are private to this instance.
 * Saved conversation mappings survive restart; active turns/results are process-local.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Related state and workflows share one private owner; callers use only the batch operations.
export function createSubagents(): Subagents {
  const store = createDelegationStore(join(MCP_CONFIG.stateDir, "subagents.sqlite"))
  const scopes = new Map<AgentIdentity | undefined, DelegationScope>()
  const eventHydrationAttempted = new Set<AgentIdentity | undefined>()
  let disposed = false
  let rateLimitedUntil = 0
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let connectPromise: Promise<void> | undefined

  const cleanupTimer = setInterval(() => void cleanupIdleAgents(), CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  async function runAgents(
    requests: readonly AgentRequest[],
    callContext: AgentCallContext = {}
  ): Promise<AgentRunResult[]> {
    const turns: AgentRunResult[] = []
    for (const [index, request] of requests.entries()) {
      if (index > 0) {
        try {
          const delayMs = SUBAGENT_RUN_DELAYS_MS[index]
          if (delayMs !== undefined) await delay(delayMs, callContext.signal)
        } catch (error) {
          turns.push({ agentId: request.agentId, status: "failed", error })
          break
        }
      }
      try {
        const turnId = await sendAgentMessage(request, callContext)
        turns.push({ agentId: request.agentId, status: "running", turnId })
      } catch (error) {
        turns.push({ agentId: request.agentId, status: "failed", error })
      }
    }
    return turns
  }

  function getAgentResponses(
    turnIds: readonly string[],
    waitMs: number,
    signal?: AbortSignal
  ): Promise<AgentResponseResult[]> {
    return Promise.all(
      turnIds.map(async (turnId) => {
        try {
          return { turnId, ...(await getAgentResponse(turnId, waitMs, signal)) }
        } catch (error) {
          return { turnId, status: "failed" as const, error }
        }
      })
    )
  }

  /** Reserve before browser work; only an unsent attempt may roll back here. */
  async function sendAgentMessage(
    request: AgentRequest,
    callContext: AgentCallContext
  ): Promise<string> {
    const parentAgent = getAgentIdentity()
    const diagnostics = new DelegationDiagnostics(request.agentId, parentAgent)
    let operation: ActiveAgentOperation | undefined
    let agent: AgentState | undefined
    let operationTransferred = false
    let newConversation = false

    try {
      const prepared = await prepareAgentForSubmission(
        parentAgent,
        request.agentId,
        callContext,
        diagnostics
      )
      operation = prepared.operation
      agent = prepared.agent
      newConversation = !agent.conversationUrl && agent.turnCount === 0
      const turnId = newConversation
        ? await startNewConversation(parentAgent, agent, request, diagnostics)
        : await submitFollowUpTurn(parentAgent, agent, request.prompt, diagnostics)
      operationTransferred = true
      return turnId
    } catch (error) {
      await diagnostics.failure(error)
      if (!operationTransferred && agent)
        await closePageIfOpen(resetUnsubmittedAgent(parentAgent, agent, newConversation))
      throw error
    } finally {
      diagnostics.dispose()
      if (!operationTransferred && operation)
        releaseOperation(parentAgent, request.agentId, operation)
    }
  }

  async function startNewConversation(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    request: AgentRequest,
    diagnostics: DelegationDiagnostics
  ): Promise<string> {
    const page = await prepareAgentConversation(
      parentAgent,
      agent,
      diagnostics,
      request.startSource
    )
    const prompt = `${request.prompt}\n${INJECTED_PROMPT}`
    return submitTurn(parentAgent, agent, page, prompt, diagnostics)
  }

  async function submitFollowUpTurn(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    prompt: string,
    diagnostics: DelegationDiagnostics
  ): Promise<string> {
    // A saved mapping may be restored after idle closure or process restart.
    const page = await prepareAgentConversation(parentAgent, agent, diagnostics)
    return submitTurn(parentAgent, agent, page, prompt, diagnostics)
  }

  /** Install observation before Send, retain the submitted turn, then collect independently of polling. */
  async function submitTurn(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    page: Page,
    submittedPrompt: string,
    diagnostics: DelegationDiagnostics
  ): Promise<string> {
    const signal = requireOperationSignal(parentAgent, agent.agentId)
    let observation: AssistantResponseObservation | undefined
    try {
      const turn = createTurn(parentAgent, agent, Date.now())

      diagnostics.stage("install-response-observer")
      observation = await observeAssistantResponse(page, {
        onSubmitted: (messageId) => {
          if (turn.status === "running") turn.submittedMessageId = messageId
          diagnostics.submitted(turn.turnId, messageId)
        },
        onConversationId: (conversationId) =>
          recordConversation(parentAgent, agent, conversationId),
        onActivity: (activity) => recordActivity(agent, turn, activity, Date.now()),
        onToolResponse: (text) => {
          if (!parentAgent || agent.identity || disposed || turn.status !== "running") return
          const child = readStartHereIdentity(text)
          if (!child) return
          agent.identity = bindAgentParent(child.sessionId, parentAgent.sessionId)
          if (agent.identity) persistAgent(parentAgent, agent)
        },
      })

      await submitMessageToBrowser(page, submittedPrompt, {
        agent,
        observation,
        signal,
        diagnostics,
      })

      recordSubmittedTurn(parentAgent, agent, turn, observation, Date.now())
      observation = undefined

      void collectTurnResponse(turn)
      return turn.turnId
    } catch (error) {
      await observation?.dispose().catch(() => undefined)
      throw error
    }
  }

  /**
   * Submit on a prepared tab with observation already installed. Recheck the agent's
   * target around prompt entry and account limits just before Send. Keep this sequence
   * beside its checks so callers cannot replace or reorder them through callbacks.
   * The observer preserves a confirmed submission after a click error; never retry Send.
   * Turn registration, persistence and response collection belong to submitTurn.
   */
  async function submitMessageToBrowser(
    page: Page,
    message: string,
    submission: {
      agent: AgentState
      observation: AssistantResponseObservation
      signal?: AbortSignal
      diagnostics: DelegationDiagnostics
    }
  ): Promise<void> {
    const { agent, observation, signal, diagnostics } = submission
    await dismissBlockingChatGptOverlay(page, signal)
    diagnostics.stage("find-composer")
    const composer = await findComposer(page, signal)
    // Visibility alone does not establish that ChatGPT's client is ready for interaction.
    await delay(2_000, signal)
    assertAgentPage(page, agent)
    diagnostics.stage("enter-prompt")
    await enterPrompt(page, composer, message, signal)
    diagnostics.stage("pre-submit-check")
    await delay(2_000, signal)
    assertAgentPage(page, agent)
    await delay(500, signal)
    await detectRateLimit()
    diagnostics.stage("submit-prompt")
    await observation.submit(() => submitComposer(page, composer, signal))
  }

  async function getAgentResponse(
    turnId: string,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<AgentResponse> {
    const parentAgent = getAgentIdentity()
    const scope = scopes.get(parentAgent)
    if (scope) pruneTurns(scope, Date.now())
    const turn = scope?.turns.get(turnId)
    if (!turn) throw new ChatGptDelegationError("UNKNOWN_TURN", `Unknown agent turn: ${turnId}`)
    if (turn.status === "running" && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined
      await waitForPromise(
        Promise.race([
          turn.settled,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs)
          }),
        ]),
        signal
      ).finally(() => {
        if (timer) clearTimeout(timer)
      })
    }
    throwIfAborted(signal)
    const agentStatus = scopes.get(parentAgent)?.agents.get(turn.agentId)?.status
    const activity = agentStatus === "idle" || agentStatus === "uncertain" ? undefined : agentStatus
    return {
      status: turn.status,
      activity: turn.status === "running" ? activity : undefined,
      activityAgeMs:
        turn.status === "running" ? Math.max(0, Date.now() - turn.lastActivityAt) : undefined,
      response: turn.response,
      errorCode: turn.errorCode,
      errorMessage: turn.errorMessage,
    }
  }

  async function prepareAgentConversation(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    diagnostics: DelegationDiagnostics,
    startSource?: string
  ): Promise<Page> {
    const signal = scopes.get(parentAgent)?.activeOperations.get(agent.agentId)?.signal
    throwIfAborted(signal)
    diagnostics.stage("inter-turn-delay")
    if (agent.lastCompletedAt !== undefined) {
      const remaining = agent.lastCompletedAt + MIN_INTER_TURN_DELAY_MS - Date.now()
      if (remaining > 0) await delay(remaining, signal)
    }
    const page = agent.page && !agent.page.isClosed() ? agent.page : undefined
    if (page) diagnostics.watch(page)
    if (agent.turnCount > 0) recordConversation(parentAgent, agent)
    if (page && isExpectedAgentPage(page, agent)) return page
    if (!agent.conversationUrl && agent.turnCount > 0) {
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        `Agent ${agent.agentId} lost its page before its conversation URL was saved.`
      )
    }

    const restoredPage = await prepareConversationTab(
      browser,
      context,
      agent.conversationUrl
        ? { kind: "resume", url: agent.conversationUrl }
        : { kind: "new", startSource },
      diagnostics,
      signal
    )
    adoptConversationTab(agent, restoredPage, Date.now())
    await closePageIfOpen(page)
    return restoredPage
  }

  // Collection owns normal completion and bounded recovery, independently of result polling.
  async function collectTurnResponse(turn: TurnState): Promise<void> {
    const observation = turn.observation
    if (!observation) return
    try {
      const result = await observation.response
      if (disposed || turn.status !== "running" || turn.observation !== observation) return
      const agent = agentForTurn(turn)
      if (!agent) return
      if (result.conversationId) recordConversation(turn.parentAgent, agent, result.conversationId)
      completeTurn(turn, result.text)
    } catch (error) {
      if (disposed || turn.status !== "running" || turn.observation !== observation) return
      await failOrRecoverSubmittedTurn(turn, error)
    }
  }

  async function failOrRecoverSubmittedTurn(
    turn: TurnState,
    originalError: unknown
  ): Promise<void> {
    if (turn.status !== "running") return

    const oldObservation = detachObservation(turn)
    await oldObservation?.dispose().catch(() => undefined)

    const agent = agentForTurn(turn)
    if (!agent) {
      failTurn(turn, originalError)
      return
    }

    recordConversation(turn.parentAgent, agent)

    let failure = originalError
    if (startRecovery(turn, agent, Date.now())) {
      try {
        if (await recoverTurn(turn)) return
      } catch (recoveryError) {
        failure = recoveryError
      }
    }

    failTurn(turn, failure)
  }

  async function recoverTurn(turn: TurnState): Promise<boolean> {
    const agent = agentForTurn(turn)
    if (!agent)
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        `Agent ${turn.agentId} no longer exists.`
      )
    const conversationUrl = agent.conversationUrl
    const conversationId = conversationUrl ? extractConversationId(conversationUrl) : undefined
    if (!conversationUrl || !conversationId) {
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        `Agent ${agent.agentId} has no saved conversation to recover.`
      )
    }

    const oldPage = agent.page
    const savedAnswer = await readSavedTurnAnswer(turn)
    if (savedAnswer) {
      completeTurn(turn, savedAnswer.text)
      return true
    }

    const page = await createManagedPage()
    try {
      const payload = await navigateAndCaptureConversationPayload(page, conversationUrl)
      await assertAuthenticated(page)
      assertAgentPage(page, agent)
      await findComposer(page)

      adoptConversationTab(agent, page, Date.now())
      await closePageIfOpen(oldPage)

      const answer = findLatestAssistantAfterMessage(
        extractConversationMessages(payload),
        turn.submittedMessageId
      )
      if (!answer) return false
      completeTurn(turn, answer.text)
      return true
    } catch (error) {
      if (agent.page !== page) await closePageIfOpen(page)
      throw error
    }
  }

  /**
   * Check this submitted message through its existing page, without disturbing
   * the live observation. Missing, pending, or unavailable history is not a failure.
   */
  async function readSavedTurnAnswer(turn: TurnState) {
    if (disposed || turn.status !== "running") return
    const agent = agentForTurn(turn)
    const page = agent?.page
    const conversationId = extractConversationId(agent?.conversationUrl ?? "")
    // Capture identity before awaiting: the live stream may settle the turn and
    // allow a follow-up while this read is still in flight.
    const submittedMessageId = turn.submittedMessageId
    if (
      !page ||
      page.isClosed() ||
      !conversationId ||
      !submittedMessageId ||
      extractConversationId(page.url()) !== conversationId
    ) {
      return
    }
    const payload = await readConversationPayload(page, conversationId)
    return findLatestAssistantAfterMessage(extractConversationMessages(payload), submittedMessageId)
  }

  async function disposeSubagents(): Promise<void> {
    clearInterval(cleanupTimer)
    const connectedBrowser = browser
    disposed = true
    const turns = [...scopes.values()].flatMap((scope) => [...scope.turns.values()])
    const agents = [...scopes.values()].flatMap((scope) => [...scope.agents.values()])
    const observations = turns.flatMap((turn) => {
      const observation = detachObservation(turn)
      turn.settle()
      return observation ? [observation] : []
    })
    scopes.clear()
    eventHydrationAttempted.clear()
    store.close()
    const pages = agents
      .map((agent) => agent.page)
      .filter((page): page is Page => page !== undefined && !page.isClosed())
    context = undefined
    browser = undefined
    connectPromise = undefined
    await Promise.allSettled([
      ...observations.map((observation) => observation.dispose()),
      ...pages.map((page) => page.close()),
    ])
    await connectedBrowser?.close().catch(() => undefined)
  }

  async function prepareAgentForSubmission(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    callContext: AgentCallContext,
    diagnostics: DelegationDiagnostics
  ): Promise<{ operation: ActiveAgentOperation; agent: AgentState }> {
    assertNotRateLimited()
    const scope = getScope(parentAgent)
    const existing = scope.agents.get(agentId)
    assertAgentOperationAvailable(scope, agentId, existing)
    assertDelegatedAgentSlotAvailable(parentAgent, scope, agentId)
    const operation: ActiveAgentOperation = { ...callContext }
    scope.activeOperations.set(agentId, operation)

    try {
      const { signal } = callContext
      throwIfAborted(signal)
      diagnostics.stage("connect-browser")
      await ensureBrowserConnection(signal)
      diagnostics.stage("rate-limit-check")
      if (!(await clearExpiredRateLimit(signal))) await detectRateLimit()
      const agent = existing ?? restoreOrCreateAgent(parentAgent, agentId, Date.now())
      scope.agents.set(agent.agentId, agent)
      return { operation, agent }
    } catch (error) {
      releaseOperation(parentAgent, agentId, operation)
      throw error
    }
  }

  // This instance only attaches to Chrome; it never owns the browser process/profile.
  async function ensureBrowserConnection(signal?: AbortSignal): Promise<void> {
    if (browser?.isConnected() && context) return
    connectPromise ??= connectBrowser().finally(() => {
      connectPromise = undefined
    })
    await waitForPromise(connectPromise, signal)
  }

  async function connectBrowser(): Promise<void> {
    try {
      const { chromium } = await import("playwright-core")
      browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, {
        timeout: CONNECT_TIMEOUT_MS,
      })
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: ChatGptDelegationError accepts ErrorOptions as its third argument and forwards the cause to Error.
      throw new ChatGptDelegationError(
        "BROWSER_UNAVAILABLE",
        [
          "ChatGPT agent browser is unavailable.",
          `Expected an already-running debuggable Chrome instance at ${MCP_CONFIG.chatGpt.cdpEndpoint}.`,
          "This module is attach-only and will not launch Chrome or choose a Chrome profile.",
        ].join(" "),
        { cause: error }
      )
    }
    const [browserContext] = browser.contexts()
    if (!browserContext) {
      throw new ChatGptDelegationError(
        "BROWSER_UNAVAILABLE",
        "Connected Chrome instance did not expose a browser context."
      )
    }
    context = browserContext
  }

  async function clearExpiredRateLimit(signal?: AbortSignal): Promise<boolean> {
    if (rateLimitedUntil <= 0) return false
    if (Date.now() < rateLimitedUntil) return true
    const pages = (context?.pages() ?? []).filter((page) => isChatGptUrl(page.url()))
    await Promise.all(pages.map((page) => dismissRateLimitModal(page, signal)))
    rateLimitedUntil = 0
    return true
  }

  async function dismissRateLimitModal(page: Page, signal?: AbortSignal): Promise<void> {
    const modal = page.locator(RATE_LIMIT_SELECTOR).first()
    if (!(await modal.isVisible().catch(() => false))) return
    const button = modal.getByRole("button", { name: RATE_LIMIT_DISMISS_BUTTON_PATTERN }).first()
    await button.click().catch(() => page.keyboard.press("Escape"))
    await delay(RATE_LIMIT_DISMISS_SETTLE_MS, signal)
  }

  async function createManagedPage(): Promise<Page> {
    if (!browser || !context)
      throw new ChatGptDelegationError("BROWSER_UNAVAILABLE", "ChatGPT browser is not connected.")
    return createBackgroundPage(browser, context)
  }

  function assertAgentPage(page: Page, agent: AgentState): void {
    if (isExpectedAgentPage(page, agent)) return
    throw new ChatGptDelegationError(
      "AGENT_TARGET_LOST",
      `Agent ${agent.agentId} no longer owns a usable ChatGPT page.`
    )
  }

  function isExpectedAgentPage(page: Page, agent: AgentState): boolean {
    if (page.isClosed() || !isChatGptUrl(page.url())) return false
    const currentConversationId = extractConversationId(page.url())
    const expectedConversationId = agent.conversationUrl
      ? extractConversationId(agent.conversationUrl)
      : undefined
    return expectedConversationId
      ? currentConversationId === expectedConversationId
      : currentConversationId === undefined
  }

  function assertNotRateLimited(): void {
    if (Date.now() >= rateLimitedUntil) return
    throw new ChatGptDelegationError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
  }

  async function detectRateLimit(): Promise<void> {
    assertNotRateLimited()
    for (const page of context?.pages() ?? []) {
      if (!isChatGptUrl(page.url())) continue
      const visible = await page
        .locator(RATE_LIMIT_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false)
      if (!visible) continue
      rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
      throw new ChatGptDelegationError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
    }
  }

  async function cleanupIdleAgents(): Promise<void> {
    if (disposed) return
    for (const action of idleCleanupActions(Date.now())) {
      if (action.kind === "check-history") {
        const answer = await readSavedTurnAnswer(action.turn)
        if (!disposed && answer) completeTurn(action.turn, answer.text)
        continue
      }
      if (action.kind === "recover") {
        await failOrRecoverSubmittedTurn(action.turn, action.error)
        continue
      }
      await closePageIfOpen(action.page)
      if (action.page.isClosed() && action.agent.page === action.page) action.agent.page = undefined
    }
  }

  function releaseOperation(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    operation: ActiveAgentOperation
  ): void {
    const scope = scopes.get(parentAgent)
    if (scope?.activeOperations.get(agentId) === operation) scope.activeOperations.delete(agentId)
  }

  function requireOperationSignal(
    parentAgent: AgentIdentity | undefined,
    agentId: string
  ): AbortSignal | undefined {
    const operation = scopes.get(parentAgent)?.activeOperations.get(agentId)
    if (!operation) {
      throw new ChatGptDelegationError("AGENT_BUSY", `Agent ${agentId} has no active operation.`)
    }
    return operation.signal
  }

  // Agent/turn transitions stay private: all paths share the same identity and settlement rules.
  function restoreOrCreateAgent(
    parentAgent: AgentIdentity | undefined,
    agentId: string,
    now: number
  ): AgentState {
    const persisted = readPersistedAgent(parentAgent, agentId)
    return {
      agentId,
      status: "idle",
      lastUsedAt: now,
      turnCount: persisted?.turnCount ?? 0,
      conversationUrl: persisted?.conversationUrl,
      identity:
        parentAgent && persisted?.childSessionId
          ? bindAgentParent(persisted.childSessionId, parentAgent.sessionId)
          : undefined,
    }
  }

  /** Adopt a usable page after navigation; browser orchestration owns closing the old page. */
  function adoptConversationTab(agent: AgentState, page: Page, now: number): void {
    agent.page = page
    agent.lastUsedAt = now
    if (extractConversationId(page.url())) agent.conversationUrl = page.url()
  }

  /** Bind the observed conversation and persist its identity without invalidating submitted work. */
  function recordConversation(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    conversationId?: string
  ): void {
    const pageUrl = agent.page && !agent.page.isClosed() ? agent.page.url() : undefined
    if (conversationId) {
      if (pageUrl && extractConversationId(pageUrl) === conversationId) {
        agent.conversationUrl = pageUrl
      } else if (extractConversationId(agent.conversationUrl ?? "") !== conversationId) {
        const url = new URL(MCP_CONFIG.chatGpt.projectUrl)
        const encodedId = encodeURIComponent(conversationId)
        if (PROJECT_PATH_PATTERN.test(url.pathname)) {
          url.pathname = `${url.pathname.replace(PROJECT_SUFFIX_PATTERN, "")}/c/${encodedId}`
          url.search = ""
          url.hash = ""
          agent.conversationUrl = url.toString()
        } else {
          agent.conversationUrl = `https://chatgpt.com/c/${encodedId}`
        }
      }
    } else if (!agent.conversationUrl && pageUrl && extractConversationId(pageUrl)) {
      agent.conversationUrl = pageUrl
    }
    persistAgent(parentAgent, agent)
  }

  /** Roll back an unsent attempt; return an unused new page for the service to close. */
  function resetUnsubmittedAgent(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    newConversation = false
  ): Page | undefined {
    agent.status = "idle"
    if (!newConversation) return undefined
    // An unsent new conversation must not consume agent capacity.
    const scope = scopes.get(parentAgent)
    if (scope?.agents.get(agent.agentId) === agent) scope.agents.delete(agent.agentId)
    const page = agent.page
    agent.page = undefined
    return page
  }

  function createTurn(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    now: number
  ): TurnState {
    const settlement = createTurnSettlement()
    return {
      // Saved counters continue across restarts; losing the counter restarts numbering at 1.
      turnId: `${agent.agentId}_turn_${agent.turnCount + 1}`,
      agentId: agent.agentId,
      parentAgent,
      status: "running",
      recoveryAttempted: false,
      lastActivityAt: now,
      settled: settlement.promise,
      settle: settlement.resolve,
    }
  }

  function recordActivity(
    agent: AgentState,
    turn: TurnState,
    activity: AgentActivity,
    now: number
  ): void {
    if (turn.status !== "running") return
    agent.status = activity
    turn.lastActivityAt = now
  }

  function recordSubmittedTurn(
    parentAgent: AgentIdentity | undefined,
    agent: AgentState,
    turn: TurnState,
    observation: AssistantResponseObservation,
    now: number
  ): void {
    const scope = getScope(parentAgent)
    const operation = scope.activeOperations.get(agent.agentId)
    if (!operation) {
      throw new ChatGptDelegationError(
        "AGENT_BUSY",
        `Agent ${agent.agentId} has no active operation.`
      )
    }

    if (agent.status === "idle") agent.status = "Working"
    agent.lastUsedAt = now
    agent.turnCount += 1
    turn.observation = observation
    scope.turns.set(turn.turnId, turn)
    operation.turnId = turn.turnId
    operation.signal = undefined
    recordConversation(parentAgent, agent)
  }

  function agentForTurn(turn: TurnState): AgentState | undefined {
    return scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
  }

  function persistAgent(parentAgent: AgentIdentity | undefined, agent: AgentState): void {
    if (!agent.conversationUrl) return
    try {
      store.set(parentAgent, agent.agentId, {
        conversationUrl: agent.conversationUrl,
        turnCount: agent.turnCount,
        childSessionId: agent.identity?.sessionId,
      })
    } catch (error) {
      if (!(error instanceof DelegationStoreError)) {
        console.warn(`Unexpected subagent persistence write failure: ${unknownErrorMessage(error)}`)
      }
    }
  }

  function startRecovery(turn: TurnState, agent: AgentState, now: number): boolean {
    if (turn.recoveryAttempted || !agent.conversationUrl) return false
    turn.recoveryAttempted = true
    turn.lastActivityAt = now
    agent.status = "Working"
    return true
  }

  function detachObservation(turn: TurnState): AssistantResponseObservation | undefined {
    const observation = turn.observation
    turn.observation = undefined
    return observation
  }

  function completeTurn(turn: TurnState, response: string): void {
    const now = Date.now()
    if (turn.status !== "running") return
    const scope = scopes.get(turn.parentAgent)
    const agent = scope?.agents.get(turn.agentId)
    if (!scope || !agent) {
      failTurn(
        turn,
        new ChatGptDelegationError("AGENT_TARGET_LOST", `Agent ${turn.agentId} no longer exists.`)
      )
      return
    }

    recordConversation(turn.parentAgent, agent)
    agent.lastCompletedAt = now
    agent.lastUsedAt = now
    agent.status = "idle"
    turn.status = "completed"
    turn.response = response
    const observation = settleTurn(turn, now)
    scope.pendingEvents.push(`agent_finished agent_id=${turn.agentId} turn_id=${turn.turnId}`)
    void observation?.dispose().catch(() => undefined)
  }

  function failTurn(turn: TurnState, error: unknown): void {
    if (turn.status !== "running") return
    const agent = scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
    if (agent) agent.status = "uncertain"
    turn.status = "failed"
    turn.errorCode = error instanceof ChatGptDelegationError ? error.code : "subagent_failed"
    turn.errorMessage = error instanceof Error ? error.message : String(error)
    const observation = settleTurn(turn, Date.now())
    void observation?.dispose().catch(() => undefined)
  }

  function collectPendingEvents(): string[] {
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    if (!eventHydrationAttempted.has(parentAgent)) {
      eventHydrationAttempted.add(parentAgent)
      try {
        scope.pendingEvents.push(
          ...listPersistedAgents(parentAgent).map(
            (agent) => `existing_agent agent_id=${agent.agentId}`
          )
        )
      } catch (error) {
        if (!(error instanceof ChatGptDelegationError)) throw error
      }
    }
    if (scope.pendingEvents.length === 0) return []
    return scope.pendingEvents.splice(0)
  }

  /** Claim due history checks before awaiting them so cleanup passes cannot duplicate a check. */
  function idleCleanupActions(now: number): IdleCleanupAction[] {
    const actions: IdleCleanupAction[] = []
    for (const scope of scopes.values()) {
      pruneTurns(scope, now)
      for (const agent of scope.agents.values()) {
        const action = idleCleanupAction(scope, agent, now)
        if (action) actions.push(action)
      }
    }
    return actions
  }

  function getScope(parentAgent: AgentIdentity | undefined): DelegationScope {
    const existing = scopes.get(parentAgent)
    if (existing) return existing
    const scope: DelegationScope = {
      agents: new Map(),
      turns: new Map(),
      activeOperations: new Map(),
      pendingEvents: [],
    }
    scopes.set(parentAgent, scope)
    return scope
  }

  function assertAgentOperationAvailable(
    scope: DelegationScope,
    agentId: string,
    agent: AgentState | undefined
  ): void {
    if (scope.activeOperations.has(agentId)) {
      throw new ChatGptDelegationError("AGENT_BUSY", `Agent ${agentId} already has an active turn.`)
    }
    if (agent?.status === "uncertain") {
      throw new ChatGptDelegationError(
        "AGENT_BUSY",
        `Agent ${agentId} has uncertain upstream state after recovery could not confirm completion. Use another existing agent ID, or a new ID if a delegated-agent slot is available.`
      )
    }
    if (agent && agent.status !== "idle") {
      throw new ChatGptDelegationError("AGENT_BUSY", `Agent ${agentId} is still ${agent.status}.`)
    }
  }

  function idleCleanupAction(
    scope: DelegationScope,
    agent: AgentState,
    now: number
  ): IdleCleanupAction | undefined {
    const activeOperation = scope.activeOperations.get(agent.agentId)
    const activeTurn = activeOperation?.turnId ? scope.turns.get(activeOperation.turnId) : undefined
    if (activeTurn?.status === "running") {
      const idleMs = now - activeTurn.lastActivityAt
      if (idleMs >= AGENT_IDLE_TTL_MS) {
        return {
          kind: "recover",
          turn: activeTurn,
          error: new ChatGptDelegationError(
            "AGENT_IDLE_EXPIRED",
            "Agent turn expired after 30 minutes without observable progress."
          ),
        }
      }
      if (
        !activeTurn.recoveryAttempted &&
        idleMs >= IDLE_HISTORY_CHECK_MS &&
        now - (activeTurn.lastHistoryCheckAt ?? 0) >= IDLE_HISTORY_CHECK_MS
      ) {
        // A turn can finish after a pending/failed read without another live event.
        // Repeat quiet checks without resetting the upstream inactivity deadline.
        activeTurn.lastHistoryCheckAt = now
        return { kind: "check-history", turn: activeTurn }
      }
      return
    }
    if (
      (activeOperation && !activeOperation.turnId) ||
      now - agent.lastUsedAt < AGENT_IDLE_TTL_MS
    ) {
      return
    }
    const page = agent.page
    if (!page || page.isClosed()) return
    return { kind: "close-page", agent, page }
  }

  function assertDelegatedAgentSlotAvailable(
    parentAgent: AgentIdentity | undefined,
    scope: DelegationScope,
    requestedAgentId: string
  ): void {
    const agents = new Map<string, string | undefined>()

    for (const persisted of listPersistedAgents(parentAgent)) {
      agents.set(persisted.agentId, undefined)
    }
    for (const agent of scope.agents.values()) {
      agents.set(agent.agentId, undefined)
    }
    for (const turn of scope.turns.values()) agents.set(turn.agentId, turn.turnId)
    for (const [agentId, operation] of scope.activeOperations) {
      if (!agents.has(agentId)) agents.set(agentId, operation.turnId)
    }

    if (agents.has(requestedAgentId) || agents.size < MCP_CONFIG.chatGpt.maxDelegatedAgents) return

    const existing = [...agents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([existingAgentId, turnId]) =>
        turnId ? `${existingAgentId} (latest_turn_id=${turnId})` : existingAgentId
      )
      .join(", ")
    throw new ChatGptDelegationError(
      "AGENT_LIMIT_REACHED",
      `This main agent already has the maximum ${MCP_CONFIG.chatGpt.maxDelegatedAgents} delegated agents. Reuse one of these agent IDs: ${existing}.`
    )
  }

  function settleTurn(turn: TurnState, now: number): AssistantResponseObservation | undefined {
    const observation = detachObservation(turn)
    const scope = scopes.get(turn.parentAgent)
    if (scope?.activeOperations.get(turn.agentId)?.turnId === turn.turnId) {
      scope.activeOperations.delete(turn.agentId)
    }
    turn.submittedMessageId = undefined
    turn.settledAt = now
    turn.settle()
    if (scope) {
      scope.turns.delete(turn.turnId)
      scope.turns.set(turn.turnId, turn)
      pruneTurns(scope, now)
    }
    return observation
  }

  /** Retain the newest 100 settled results per caller for 24 hours; running turns never expire here. */
  function pruneTurns(scope: DelegationScope, now: number): void {
    let retained = 0
    for (const turn of [...scope.turns.values()].reverse()) {
      if (turn.settledAt === undefined) continue
      if (now - turn.settledAt >= TURN_RESULT_TTL_MS || retained >= MAX_RETAINED_TURNS) {
        scope.turns.delete(turn.turnId)
      } else {
        retained += 1
      }
    }
  }

  function readPersistedAgent(parentAgent: AgentIdentity | undefined, agentId: string) {
    try {
      return store.get(parentAgent, agentId)
    } catch (error) {
      throw persistenceUnavailable(error)
    }
  }

  function listPersistedAgents(parentAgent: AgentIdentity | undefined) {
    try {
      return store.list(parentAgent)
    } catch (error) {
      throw persistenceUnavailable(error)
    }
  }

  return {
    runAgents,
    getAgentResponses,
    drainEvents: collectPendingEvents,
    dispose: disposeSubagents,
  }
}

async function closePageIfOpen(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return
  await page.close().catch(() => undefined)
}

function createTurnSettlement(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function persistenceUnavailable(error: unknown): ChatGptDelegationError {
  const operation = error instanceof DelegationStoreError ? error.operation : "read"
  return new ChatGptDelegationError(
    "SUBAGENT_PERSISTENCE_UNAVAILABLE",
    `Subagent persistence is unavailable after a ${operation} failure. No new prompt was submitted.`,
    { cause: error }
  )
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error)
  }
  return "Unknown error"
}
