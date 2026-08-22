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
  findComposer,
  isExpectedAgentPage,
  navigateAndCaptureConversationPayload,
  submitComposer,
  throwIfAborted,
  waitForStableConversationLocation,
  waitForPromise,
} from "./chatgpt-subagent-browser.js"
import { observeAssistantResponse, readAssistantDomMessages, type AssistantResponseObservation } from "./chatgpt-subagent-observer.js"
import { extractConversationMessages, findLatestAssistantAfterPrompt } from "./chatgpt-subagent-protocol.js"
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
const MANAGED_VIEWPORT = { width: 412, height: 915 } as const
const BACKGROUND_PAGE_BIND_TIMEOUT_MS = 5_000

const INJECTED_PROMPT =
  "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` or `computer_*` tools."

export interface BrowserAgentState {
  agentId: string
  page: Page
  conversationId?: string
  conversationUrl?: string
  lastCompletedAt?: number
  lastUsedAt: number
  turnCount: number
}

export interface BrowserTurnState {
  turnId: string
  agentId: string
  status: "running" | "completed" | "failed"
  recoveryAttempted: boolean
  activity: ChatGptSubagentActivity
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  prompt: string
  observation?: AssistantResponseObservation
  settled: Promise<void>
  settle: () => void
}

interface StoredConversationRef {
  conversationId: string
  conversationUrl: string
  turnCount: number
}

export interface ChatGptSubagentRuntimeState {
  cdpEndpoint: string
  connectTimeoutMs: number
  chatGptUrl: string
  maxConcurrentAgents: number
  minInterTurnDelayMs: number
  interactionDelayMs: number
  timeoutMs: number
  agents: Map<string, BrowserAgentState>
  conversationRefs: Map<string, StoredConversationRef>
  turns: Map<string, BrowserTurnState>
  activeOperations: Map<string, string | null>
  pendingEvents: string[]
  rateLimitedUntil: number
  browser?: Browser
  context?: BrowserContext
  connectPromise?: Promise<void>
  cleanupTimer?: NodeJS.Timeout
  disposed: boolean
}

export interface ChatGptSubagentRuntimeService extends ChatGptSubagentService {
  connect(signal?: AbortSignal): Promise<void>
  drainEvents(): string[]
}

export function createChatGptSubagentRuntimeState(options: ChatGptSubagentOptions = {}): ChatGptSubagentRuntimeState {
  return {
    cdpEndpoint: options.cdpEndpoint ?? MCP_CONFIG.chatGpt.cdpEndpoint,
    connectTimeoutMs: options.connectTimeoutMs ?? 3_000,
    chatGptUrl: options.chatGptUrl ?? MCP_CONFIG.chatGpt.projectUrl ?? "https://chatgpt.com/",
    maxConcurrentAgents: Math.min(positiveInteger(options.maxConcurrentAgents, MAX_CONCURRENT_AGENTS), MAX_CONCURRENT_AGENTS),
    minInterTurnDelayMs: nonNegativeInteger(options.minInterTurnDelayMs, 1_500),
    interactionDelayMs: nonNegativeInteger(options.interactionDelayMs, 300),
    timeoutMs: options.timeoutMs ?? 120_000,
    agents: new Map(),
    conversationRefs: new Map(),
    turns: new Map(),
    activeOperations: new Map(),
    pendingEvents: [],
    rateLimitedUntil: 0,
    disposed: false,
  }
}

export function createChatGptSubagentService(options: ChatGptSubagentOptions = {}): ChatGptSubagentRuntimeService {
  const state = createChatGptSubagentRuntimeState(options)
  state.cleanupTimer = setInterval(() => void cleanupIdleAgents(state), 60_000)
  state.cleanupTimer.unref()

  return {
    connect: (signal) => connectSubagents(state, signal),
    ask: (request, signal) => askSubagent(state, request, signal),
    poll: (turnId, waitMs, signal) => pollSubagent(state, turnId, waitMs, signal),
    drainEvents: () => state.pendingEvents.splice(0),
    dispose: () => disposeSubagents(state),
  }
}

async function connectSubagents(state: ChatGptSubagentRuntimeState, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (state.browser?.isConnected() && state.context) return

  state.connectPromise ??= connectOnce(state).finally(() => {
    state.connectPromise = undefined
  })
  await waitForPromise(state.connectPromise, signal)
}

export async function askSubagent(
  state: ChatGptSubagentRuntimeState,
  request: ChatGptSubagentRequest,
  signal?: AbortSignal
): Promise<ChatGptSubagentStartResult> {
  assertNotRateLimited(state)
  beginAgentOperation(state, request.agentId)
  let agent: BrowserAgentState | undefined
  let observation: AssistantResponseObservation | undefined
  let operationTransferred = false

  try {
    await connectSubagents(state, signal)
    if (state.rateLimitedUntil > 0) await clearExpiredRateLimit(state, signal)
    else await detectRateLimit(state)

    agent = state.agents.get(request.agentId) ?? (await createAgent(state, request.agentId, signal))
    await waitForInterTurn(state, agent, signal)
    const active = await ensureActivePage(state, agent, signal)
    throwIfAborted(signal)

    const baselineDom = await readAssistantDomMessages(active.page)
    const submittedPrompt = active.turnCount > 0 ? request.prompt : appendFirstTurnMode(request.prompt, request.oververbosity)
    const turnId = `${active.agentId}_turn_${active.turnCount + 1}`
    const settlement = createTurnSettlement()
    const turn: BrowserTurnState = {
      turnId,
      agentId: active.agentId,
      status: "running",
      recoveryAttempted: false,
      activity: "Generating response",
      lastActivityAt: Date.now(),
      prompt: submittedPrompt,
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
    const composer = await findComposer(active.page, state.timeoutMs, signal)
    await delay(state.interactionDelayMs, signal)
    throwIfAborted(signal)
    assertPreSubmitLocation(active)
    await enterPrompt(active.page, composer, submittedPrompt, signal)
    await delay(state.interactionDelayMs, signal)
    throwIfAborted(signal)
    assertPreSubmitLocation(active)
    await delay(SUBMISSION_GRACE_MS, signal)
    await detectRateLimit(state)
    await submitComposer(active.page, composer, signal)

    active.lastUsedAt = Date.now()
    active.turnCount += 1
    turn.observation = observation
    state.turns.set(turnId, turn)
    state.activeOperations.set(active.agentId, turnId)

    if (!active.conversationId) {
      void waitForStableConversationLocation(active, Math.min(state.timeoutMs, CONVERSATION_BIND_TIMEOUT_MS)).then((bound) => {
        if (bound) rememberConversation(state, active)
      })
    }

    void waitForTurnResponse(state, turn, active)
    observation = undefined
    operationTransferred = true

    return { agentId: active.agentId, turnId, status: "running" }
  } catch (error) {
    await observation?.dispose().catch(() => undefined)
    if (agent && error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST" && !agent.conversationUrl) {
      discardUnrecoverableAgent(state, agent)
    }
    throw error
  } finally {
    if (!operationTransferred) endAgentOperation(state, request.agentId)
  }
}

export async function pollSubagent(
  state: ChatGptSubagentRuntimeState,
  turnId: string,
  waitMs: number,
  signal?: AbortSignal
): Promise<ChatGptSubagentPollResult> {
  const turn = state.turns.get(turnId)
  if (!turn) throw new ChatGptSubagentError("UNKNOWN_TURN", `Unknown ChatGPT subagent turn: ${turnId}`)

  if (turn.status === "running" && waitMs > 0) await waitForTurnSettlement(turn.settled, waitMs, signal)
  throwIfAborted(signal)
  return turnResult(turn)
}

export async function disposeSubagents(state: ChatGptSubagentRuntimeState): Promise<void> {
  state.disposed = true
  if (state.cleanupTimer) clearInterval(state.cleanupTimer)
  const browser = state.browser
  const ownedPages = [...state.agents.values()].filter((agent) => !agent.page.isClosed() && isExpectedAgentPage(agent)).map((agent) => agent.page)
  const observations = [...state.turns.values()].map((turn) => turn.observation).filter((value): value is AssistantResponseObservation => value !== undefined)

  state.agents.clear()
  state.conversationRefs.clear()
  state.turns.clear()
  state.activeOperations.clear()
  state.pendingEvents.length = 0
  state.context = undefined
  state.browser = undefined
  state.connectPromise = undefined

  await Promise.allSettled([...observations.map((observation) => observation.dispose()), ...ownedPages.map((page) => page.close())])
  await browser?.close().catch(() => undefined)
}

async function connectOnce(state: ChatGptSubagentRuntimeState): Promise<void> {
  try {
    const { chromium } = await import("playwright-core")
    state.browser = await chromium.connectOverCDP(state.cdpEndpoint, { timeout: state.connectTimeoutMs })
  } catch (error) {
    state.browser = undefined
    state.context = undefined
    throw new ChatGptSubagentError(
      "BROWSER_UNAVAILABLE",
      [
        "ChatGPT agent browser is unavailable.",
        `Expected an already-running debuggable Chrome instance at ${state.cdpEndpoint}.`,
        "This module is attach-only and will not launch Chrome or choose a Chrome profile.",
      ].join(" "),
      { cause: error }
    )
  }

  const [context] = state.browser.contexts()
  if (!context) {
    state.browser = undefined
    state.context = undefined
    throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "Connected Chrome instance did not expose a browser context.")
  }
  state.context = context
}

export async function createAgent(state: ChatGptSubagentRuntimeState, agentId: string, signal?: AbortSignal): Promise<BrowserAgentState> {
  const page = await createManagedPage(state)
  const stored = state.conversationRefs.get(agentId)
  const agent: BrowserAgentState = {
    agentId,
    page,
    conversationId: stored?.conversationId,
    conversationUrl: stored?.conversationUrl,
    lastUsedAt: Date.now(),
    turnCount: stored?.turnCount ?? 0,
  }

  try {
    throwIfAborted(signal)
    await waitForPromise(page.goto(stored?.conversationUrl ?? state.chatGptUrl, { waitUntil: "domcontentloaded" }), signal)
    throwIfAborted(signal)
    await assertAuthenticated(page)
    if (stored) await assertConversationAvailable(page, stored.conversationId, state.timeoutMs, signal)
    await findComposer(page, state.timeoutMs, signal)
    state.agents.set(agent.agentId, agent)
    return agent
  } catch (error) {
    if (!page.isClosed()) await page.close()
    throw error
  }
}

export async function ensureActivePage(runtime: ChatGptSubagentRuntimeState, agent: BrowserAgentState, signal?: AbortSignal): Promise<BrowserAgentState> {
  throwIfAborted(signal)
  if (!agent.page.isClosed() && isExpectedAgentPage(agent)) return agent
  if (!agent.conversationUrl) {
    discardUnrecoverableAgent(runtime, agent)
    throw new ChatGptSubagentError(
      "AGENT_TARGET_LOST",
      `ChatGPT subagent ${agent.agentId} no longer owns its original page and has no saved conversation to recover.`
    )
  }

  const page = await createManagedPage(runtime)
  try {
    await waitForPromise(page.goto(agent.conversationUrl, { waitUntil: "domcontentloaded" }), signal)
    throwIfAborted(signal)
    await assertAuthenticated(page)
    if (agent.conversationId) await assertConversationAvailable(page, agent.conversationId, runtime.timeoutMs, signal)
    await findComposer(page, runtime.timeoutMs, signal)

    agent.page = page
    agent.lastUsedAt = Date.now()
    rememberConversation(runtime, agent)
    return agent
  } catch (error) {
    if (!page.isClosed()) await page.close().catch(() => undefined)
    if (error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CONVERSATION_NOT_FOUND") discardUnrecoverableAgent(runtime, agent)
    throw error
  }
}

export async function waitForTurnResponse(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState): Promise<void> {
  const observation = turn.observation
  if (!observation) return

  try {
    const response = await observation.response
    if (state.disposed || turn.status !== "running") return
    try {
      captureOrValidateConversationLocation(agent)
      rememberConversation(state, agent)
    } catch {
      // Exact structured response is sufficient even if the managed tab moved afterward.
    }
    completeTurn(state, turn, agent, response)
  } catch (error) {
    if (state.disposed || turn.status !== "running") return
    await failOrRecoverSubmittedTurn(state, turn, agent, error)
  }
}

export async function failOrRecoverSubmittedTurn(
  state: ChatGptSubagentRuntimeState,
  turn: BrowserTurnState,
  agent: BrowserAgentState,
  originalError: unknown,
  signal?: AbortSignal,
  recover: typeof recoverSubmittedTurn = recoverSubmittedTurn
): Promise<void> {
  if (turn.status !== "running") return
  if (!agent.conversationId && !agent.page.isClosed()) {
    try {
      captureOrValidateConversationLocation(agent)
      rememberConversation(state, agent)
    } catch {
      // Recovery below fails cleanly when no stable conversation identity exists.
    }
  }

  if (!turn.recoveryAttempted && agent.conversationId && agent.conversationUrl) {
    turn.recoveryAttempted = true
    try {
      await recover(state, turn, agent, signal)
      if (turn.status !== "running") return
    } catch (recoveryError) {
      if (recoveryError instanceof ChatGptSubagentError && recoveryError.code === "REQUEST_ABORTED") throw recoveryError
      originalError = recoveryError
    }
  }

  if (originalError instanceof ChatGptSubagentError && originalError.code === "AGENT_TARGET_LOST" && !agent.conversationUrl) {
    discardUnrecoverableAgent(state, agent)
  }
  failTurn(state, turn, agent, originalError)
}

export async function recoverSubmittedTurn(
  state: ChatGptSubagentRuntimeState,
  turn: BrowserTurnState,
  agent: BrowserAgentState,
  signal?: AbortSignal
): Promise<void> {
  if (!agent.conversationId || !agent.conversationUrl) {
    throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${agent.agentId} has no saved conversation to recover.`)
  }

  const oldPage = agent.page
  const closeOldPage = !oldPage.isClosed() && isExpectedAgentPage(agent)
  const page = await createManagedPage(state)

  try {
    const payload = await navigateAndCaptureConversationPayload(page, agent.conversationUrl, agent.conversationId, state.timeoutMs, signal)
    throwIfAborted(signal)
    await assertAuthenticated(page)
    await assertConversationAvailable(page, agent.conversationId, state.timeoutMs, signal)

    agent.page = page
    agent.lastUsedAt = Date.now()
    rememberConversation(state, agent)
    if (closeOldPage) await oldPage.close().catch(() => undefined)

    const messages = payload ? extractConversationMessages(payload) : []
    const answer = findLatestAssistantAfterPrompt(messages, turn.prompt)
    if (answer?.text) {
      completeTurn(state, turn, agent, answer.text)
      return
    }

    const recoveryBaseline = await readAssistantDomMessages(page)
    const recoveryObservation = await observeAssistantResponse(page, {
      baselineDom: recoveryBaseline,
      prompt: turn.prompt,
      settleMs: ASSISTANT_RESPONSE_SETTLE_MS,
      onActivity: (activity) => {
        turn.activity = activity
        turn.lastActivityAt = Date.now()
      },
    })
    turn.observation = recoveryObservation
    const response = await recoveryObservation.response
    if (turn.status === "running") completeTurn(state, turn, agent, response)
  } catch (error) {
    if (agent.page !== page && !page.isClosed()) await page.close().catch(() => undefined)
    throw error
  }
}

function completeTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState, response: string): void {
  if (turn.status !== "running") return
  agent.lastCompletedAt = Date.now()
  agent.lastUsedAt = agent.lastCompletedAt
  turn.status = "completed"
  turn.response = response
  void turn.observation?.dispose().catch(() => undefined)
  turn.observation = undefined
  rememberConversation(state, agent)
  finishTurnOperation(state, turn, agent)
  turn.settle()
  state.pendingEvents.push(`agent_finished:${turn.agentId}:${turn.turnId}`)
}

async function createManagedPage(state: ChatGptSubagentRuntimeState): Promise<Page> {
  const page = await createBackgroundPage(state)
  try {
    await page.setViewportSize(MANAGED_VIEWPORT)
    return page
  } catch (error) {
    if (!page.isClosed()) await page.close().catch(() => undefined)
    throw error
  }
}

async function createBackgroundPage(state: ChatGptSubagentRuntimeState): Promise<Page> {
  const context = requireContext(state)
  const browser = requireBrowser(state)
  const knownPages = new Set(context.pages())
  const session = await browser.newBrowserCDPSession()
  let targetId: string | undefined

  try {
    const created = await session.send("Target.createTarget", {
      url: "about:blank",
      background: true,
      focus: false,
    })
    targetId = created.targetId

    const deadline = Date.now() + BACKGROUND_PAGE_BIND_TIMEOUT_MS
    while (Date.now() < deadline) {
      for (const page of context.pages()) {
        if (knownPages.has(page) || page.isClosed()) continue
        if ((await pageTargetId(context, page)) === targetId) return page
      }
      await delay(25)
    }

    throw new ChatGptSubagentError(
      "BROWSER_UNAVAILABLE",
      `Chrome created background target ${targetId}, but Playwright did not expose its page within ${BACKGROUND_PAGE_BIND_TIMEOUT_MS} ms.`
    )
  } catch (error) {
    if (targetId) await session.send("Target.closeTarget", { targetId }).catch(() => undefined)
    throw error
  } finally {
    await session.detach().catch(() => undefined)
  }
}

async function pageTargetId(context: BrowserContext, page: Page): Promise<string | undefined> {
  const session = await context.newCDPSession(page).catch(() => undefined)
  if (!session) return undefined
  try {
    const info = await session.send("Target.getTargetInfo")
    return info.targetInfo.targetId
  } catch {
    return undefined
  } finally {
    await session.detach().catch(() => undefined)
  }
}

function failTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState, error: unknown): void {
  if (turn.status !== "running") return
  turn.status = "failed"
  turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
  turn.errorMessage = error instanceof Error ? error.message : String(error)
  void turn.observation?.dispose().catch(() => undefined)
  turn.observation = undefined
  finishTurnOperation(state, turn, agent)
  turn.settle()
}

function finishTurnOperation(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState): void {
  if (state.activeOperations.get(agent.agentId) === turn.turnId) state.activeOperations.delete(agent.agentId)
}

function turnResult(turn: BrowserTurnState): ChatGptSubagentPollResult {
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

function requireContext(state: ChatGptSubagentRuntimeState): BrowserContext {
  if (!state.context) throw new Error("ChatGPT subagent runtime is not connected to Chrome.")
  return state.context
}

function requireBrowser(state: ChatGptSubagentRuntimeState): Browser {
  if (!state.browser) throw new Error("ChatGPT subagent runtime is not connected to Chrome.")
  return state.browser
}

async function waitForInterTurn(state: ChatGptSubagentRuntimeState, agent: BrowserAgentState, signal?: AbortSignal): Promise<void> {
  if (agent.lastCompletedAt === undefined) return
  const remaining = agent.lastCompletedAt + state.minInterTurnDelayMs - Date.now()
  if (remaining > 0) await delay(remaining, signal)
}

function assertNotRateLimited(state: ChatGptSubagentRuntimeState): void {
  if (Date.now() >= state.rateLimitedUntil) return
  throw new ChatGptSubagentError(
    "SUBAGENT_RATE_LIMITED",
    "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."
  )
}

async function detectRateLimit(state: ChatGptSubagentRuntimeState): Promise<void> {
  assertNotRateLimited(state)
  for (const page of requireContext(state).pages()) {
    if (!page.url().startsWith("https://chatgpt.com/")) continue
    const modal = page.locator(RATE_LIMIT_SELECTOR).first()
    if (!(await modal.isVisible().catch(() => false))) continue
    state.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
    assertNotRateLimited(state)
  }
}

export async function clearExpiredRateLimit(state: ChatGptSubagentRuntimeState, signal?: AbortSignal): Promise<void> {
  assertNotRateLimited(state)
  state.rateLimitedUntil = 0
  let dismissed = false

  for (const page of requireContext(state).pages()) {
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
  await detectRateLimit(state)
}

export function beginAgentOperation(state: ChatGptSubagentRuntimeState, agentId: string): void {
  if (state.activeOperations.has(agentId)) {
    const activeTurnId = state.activeOperations.get(agentId)
    throw new ChatGptSubagentError(
      "AGENT_BUSY",
      activeTurnId
        ? `ChatGPT subagent ${agentId} is still running turn ${activeTurnId}. Poll that turn instead of submitting another prompt.`
        : `ChatGPT subagent ${agentId} already has an operation in progress. Do not queue or automatically retry another turn.`
    )
  }
  if (state.activeOperations.size >= state.maxConcurrentAgents) {
    throw new ChatGptSubagentError(
      "SUBAGENT_CAPACITY_REACHED",
      `ChatGPT subagent capacity is ${state.maxConcurrentAgents} concurrent generations. Do not queue or automatically retry this request.`
    )
  }
  state.activeOperations.set(agentId, null)
}

export function endAgentOperation(state: ChatGptSubagentRuntimeState, agentId: string): void {
  if (state.activeOperations.get(agentId) === null) state.activeOperations.delete(agentId)
}

function discardUnrecoverableAgent(state: ChatGptSubagentRuntimeState, agent: BrowserAgentState): void {
  if (state.agents.get(agent.agentId) === agent) state.agents.delete(agent.agentId)
}

function rememberConversation(state: ChatGptSubagentRuntimeState, agent: BrowserAgentState): void {
  if (!agent.conversationId || !agent.conversationUrl) return
  state.conversationRefs.set(agent.agentId, {
    conversationId: agent.conversationId,
    conversationUrl: agent.conversationUrl,
    turnCount: agent.turnCount,
  })
}

export async function cleanupIdleAgents(state: ChatGptSubagentRuntimeState, now = Date.now()): Promise<void> {
  const staleAgents = [...state.agents.values()].filter((agent) => {
    const activeOperation = state.activeOperations.get(agent.agentId)
    const activeTurn = typeof activeOperation === "string" ? state.turns.get(activeOperation) : undefined

    if (activeTurn?.status === "running") return now - activeTurn.lastActivityAt >= DEFAULT_AGENT_IDLE_TTL_MS
    if (activeOperation === null) return false
    return now - agent.lastUsedAt >= DEFAULT_AGENT_IDLE_TTL_MS
  })

  for (const agent of staleAgents) {
    rememberConversation(state, agent)
    const activeOperation = state.activeOperations.get(agent.agentId)
    const activeTurn = typeof activeOperation === "string" ? state.turns.get(activeOperation) : undefined
    if (activeTurn?.status === "running") {
      failTurn(
        state,
        activeTurn,
        agent,
        new ChatGptSubagentError("AGENT_IDLE_EXPIRED", "ChatGPT subagent turn expired after 30 minutes without observable progress.")
      )
    }

    state.agents.delete(agent.agentId)
    removeTurnsForAgent(state, agent.agentId)
    if (!agent.page.isClosed() && isExpectedAgentPage(agent)) await agent.page.close().catch(() => undefined)
  }
}

function removeTurnsForAgent(state: ChatGptSubagentRuntimeState, agentId: string): void {
  state.activeOperations.delete(agentId)
  for (const [turnId, turn] of state.turns) {
    if (turn.agentId !== agentId) continue
    void turn.observation?.dispose().catch(() => undefined)
    turn.settle()
    state.turns.delete(turnId)
    const event = `agent_finished:${turn.agentId}:${turn.turnId}`
    for (let index = state.pendingEvents.length - 1; index >= 0; index -= 1) {
      if (state.pendingEvents[index] === event) state.pendingEvents.splice(index, 1)
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
