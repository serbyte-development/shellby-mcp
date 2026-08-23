import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import { nonNegativeInteger, positiveInteger } from "../../utils.js"
import {
  assertAuthenticated,
  assertManagedChatGptPage,
  createBackgroundPage,
  delay,
  dismissBlockingChatGptOverlay,
  enterPrompt,
  extractConversationId,
  findComposer,
  isExpectedConversationPage,
  navigateAndCaptureConversationPayload,
  submitComposer,
  throwIfAborted,
  waitForPromise,
} from "./chatgpt-subagent-browser.js"
import { observeAssistantResponse, type AssistantResponseObservation } from "./chatgpt-subagent-observer.js"
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

const AGENT_IDLE_TTL_MS = 30 * 60_000
const CLEANUP_INTERVAL_MS = 60_000
const MAX_CONCURRENT_AGENTS = 3
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const RATE_LIMIT_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"]'
const RATE_LIMIT_DISMISS_SETTLE_MS = 250
const SUBMISSION_GRACE_MS = 500
const MANAGED_VIEWPORT = { width: 412, height: 915 } as const

const INJECTED_PROMPT =
  "Respond terse like smart caveman — drop articles, filler, pleasantries. Fragments OK. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].\n\nNot use `subagent` or `computer_*` tools."

export interface BrowserAgentState {
  agentId: string
  page?: Page
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

export interface ChatGptSubagentRuntimeState {
  cdpEndpoint: string
  connectTimeoutMs: number
  chatGptUrl: string
  maxConcurrentAgents: number
  minInterTurnDelayMs: number
  interactionDelayMs: number
  timeoutMs: number
  agents: Map<string, BrowserAgentState>
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
    turns: new Map(),
    activeOperations: new Map(),
    pendingEvents: [],
    rateLimitedUntil: 0,
    disposed: false,
  }
}

export function createChatGptSubagentService(options: ChatGptSubagentOptions = {}): ChatGptSubagentRuntimeService {
  const state = createChatGptSubagentRuntimeState(options)
  state.cleanupTimer = setInterval(() => void cleanupIdleAgents(state), CLEANUP_INTERVAL_MS)
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
  let observation: AssistantResponseObservation | undefined
  let operationTransferred = false

  try {
    await connectSubagents(state, signal)
    if (state.rateLimitedUntil > 0) await clearExpiredRateLimit(state, signal)
    else await detectRateLimit(state)

    const agent = state.agents.get(request.agentId) ?? (await createAgent(state, request.agentId, signal))
    await waitForInterTurn(state, agent, signal)
    const page = await ensureAgentPage(state, agent, signal)

    const submittedPrompt = agent.turnCount > 0 ? request.prompt : appendFirstTurnMode(request.prompt, request.oververbosity)
    const turnId = `${agent.agentId}_turn_${agent.turnCount + 1}`
    const settlement = createTurnSettlement()
    const turn: BrowserTurnState = {
      turnId,
      agentId: agent.agentId,
      status: "running",
      recoveryAttempted: false,
      activity: "Generating response",
      lastActivityAt: Date.now(),
      prompt: submittedPrompt,
      settled: settlement.promise,
      settle: settlement.resolve,
    }

    observation = await observeAssistantResponse(page, {
      prompt: submittedPrompt,
      onActivity: (activity) => {
        turn.activity = activity
        turn.lastActivityAt = Date.now()
      },
    })

    await dismissBlockingChatGptOverlay(page, signal)
    const composer = await findComposer(page, state.timeoutMs, signal)
    await delay(state.interactionDelayMs, signal)
    assertManagedChatGptPage(page, agent.agentId, agent.conversationUrl)
    await enterPrompt(page, composer, submittedPrompt, signal)
    await delay(state.interactionDelayMs, signal)
    assertManagedChatGptPage(page, agent.agentId, agent.conversationUrl)
    await delay(SUBMISSION_GRACE_MS, signal)
    await detectRateLimit(state)
    await submitComposer(page, composer, signal)

    agent.lastUsedAt = Date.now()
    agent.turnCount += 1
    turn.observation = observation
    state.turns.set(turnId, turn)
    state.activeOperations.set(agent.agentId, turnId)
    observation = undefined
    operationTransferred = true

    void waitForTurnResponse(state, turn, agent)
    return { agentId: agent.agentId, turnId, status: "running" }
  } catch (error) {
    await observation?.dispose().catch(() => undefined)
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

export async function createAgent(state: ChatGptSubagentRuntimeState, agentId: string, signal?: AbortSignal): Promise<BrowserAgentState> {
  const agent: BrowserAgentState = { agentId, lastUsedAt: Date.now(), turnCount: 0 }
  await ensureAgentPage(state, agent, signal)
  state.agents.set(agentId, agent)
  return agent
}

export async function ensureAgentPage(
  state: ChatGptSubagentRuntimeState,
  agent: BrowserAgentState,
  signal?: AbortSignal
): Promise<Page> {
  throwIfAborted(signal)
  const page = agent.page && !agent.page.isClosed() ? agent.page : undefined
  if (page && !page.isClosed() && !agent.conversationUrl && agent.turnCount > 0 && extractConversationId(page.url())) {
    agent.conversationUrl = page.url()
  }
  if (page && isExpectedConversationPage(page, agent.conversationUrl)) return page
  const targetUrl = agent.conversationUrl ?? (agent.turnCount === 0 ? state.chatGptUrl : undefined)
  if (!targetUrl) {
    throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${agent.agentId} lost its page before its conversation URL was saved.`)
  }

  const created = !page
  const restoredPage = page ?? (await createManagedPage(state))
  try {
    await waitForPromise(restoredPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: state.timeoutMs }), signal)
    await assertAuthenticated(restoredPage)
    assertManagedChatGptPage(restoredPage, agent.agentId, agent.conversationUrl)
    await findComposer(restoredPage, state.timeoutMs, signal)
    agent.page = restoredPage
    agent.lastUsedAt = Date.now()
    return restoredPage
  } catch (error) {
    if (created && !restoredPage.isClosed()) await restoredPage.close().catch(() => undefined)
    throw error
  }
}

export async function waitForTurnResponse(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState): Promise<void> {
  const observation = turn.observation
  if (!observation) return
  try {
    const result = await observation.response
    if (state.disposed || turn.status !== "running" || turn.observation !== observation) return
    if (result.conversationId) bindConversation(agent, result.conversationId)
    completeTurn(state, turn, agent, result.text)
  } catch (error) {
    if (state.disposed || turn.status !== "running" || turn.observation !== observation) return
    await failOrRecoverSubmittedTurn(state, turn, agent, error)
  }
}

export async function failOrRecoverSubmittedTurn(
  state: ChatGptSubagentRuntimeState,
  turn: BrowserTurnState,
  agent: BrowserAgentState,
  originalError: unknown,
  signal?: AbortSignal
): Promise<void> {
  if (turn.status !== "running") return

  const oldObservation = turn.observation
  turn.observation = undefined
  await oldObservation?.dispose().catch(() => undefined)

  const page = agent.page
  if (!agent.conversationUrl && page && !page.isClosed() && extractConversationId(page.url())) agent.conversationUrl = page.url()

  if (!turn.recoveryAttempted && agent.conversationUrl) {
    turn.recoveryAttempted = true
    turn.lastActivityAt = Date.now()
    try {
      await recoverSubmittedTurn(state, turn, agent, signal)
      return
    } catch (recoveryError) {
      originalError = recoveryError
    }
  }

  failTurn(state, turn, agent, originalError)
}

export async function recoverSubmittedTurn(
  state: ChatGptSubagentRuntimeState,
  turn: BrowserTurnState,
  agent: BrowserAgentState,
  signal?: AbortSignal
): Promise<void> {
  const conversationUrl = agent.conversationUrl
  const conversationId = conversationUrl ? extractConversationId(conversationUrl) : undefined
  if (!conversationUrl || !conversationId) {
    throw new ChatGptSubagentError("AGENT_TARGET_LOST", `ChatGPT subagent ${agent.agentId} has no saved conversation to recover.`)
  }

  const oldPage = agent.page
  const page = await createManagedPage(state)
  let observation: AssistantResponseObservation | undefined
  try {
    observation = await observeAssistantResponse(page, {
      prompt: turn.prompt,
      onActivity: (activity) => {
        turn.activity = activity
        turn.lastActivityAt = Date.now()
      },
    })
    void observation.response.catch(() => undefined)
    turn.observation = observation

    const payload = await navigateAndCaptureConversationPayload(page, conversationUrl, conversationId, state.timeoutMs, signal)
    await assertAuthenticated(page)
    assertManagedChatGptPage(page, agent.agentId, conversationUrl)
    await findComposer(page, state.timeoutMs, signal)

    agent.page = page
    agent.lastUsedAt = Date.now()
    if (oldPage && !oldPage.isClosed()) await oldPage.close().catch(() => undefined)

    const answer = findLatestAssistantAfterPrompt(extractConversationMessages(payload), turn.prompt)
    if (answer) {
      completeTurn(state, turn, agent, answer.text)
      return
    }

    void waitForTurnResponse(state, turn, agent)
  } catch (error) {
    if (turn.observation === observation) turn.observation = undefined
    await observation?.dispose().catch(() => undefined)
    if (agent.page !== page && !page.isClosed()) await page.close().catch(() => undefined)
    throw error
  }
}

export async function disposeSubagents(state: ChatGptSubagentRuntimeState): Promise<void> {
  state.disposed = true
  if (state.cleanupTimer) clearInterval(state.cleanupTimer)
  const browser = state.browser
  const observations = [...state.turns.values()].map((turn) => turn.observation).filter((value): value is AssistantResponseObservation => value !== undefined)
  const pages = [...state.agents.values()]
    .map((agent) => agent.page)
    .filter((page): page is Page => page !== undefined && !page.isClosed())
  for (const turn of state.turns.values()) turn.settle()
  state.agents.clear()
  state.turns.clear()
  state.activeOperations.clear()
  state.pendingEvents.length = 0
  state.context = undefined
  state.browser = undefined
  state.connectPromise = undefined
  state.cleanupTimer = undefined
  await Promise.allSettled([...observations.map((observation) => observation.dispose()), ...pages.map((page) => page.close())])
  await browser?.close().catch(() => undefined)
}

export function beginAgentOperation(state: ChatGptSubagentRuntimeState, agentId: string): void {
  if (state.activeOperations.has(agentId)) throw new ChatGptSubagentError("AGENT_BUSY", `ChatGPT subagent ${agentId} already has an active turn.`)
  if (state.activeOperations.size >= state.maxConcurrentAgents) {
    throw new ChatGptSubagentError("SUBAGENT_CAPACITY_REACHED", `ChatGPT subagent generation capacity is ${state.maxConcurrentAgents}.`)
  }
  state.activeOperations.set(agentId, null)
}

export function endAgentOperation(state: ChatGptSubagentRuntimeState, agentId: string): void {
  state.activeOperations.delete(agentId)
}

export async function clearExpiredRateLimit(state: ChatGptSubagentRuntimeState, signal?: AbortSignal): Promise<void> {
  if (state.rateLimitedUntil === 0 || Date.now() < state.rateLimitedUntil) return
  for (const page of state.context?.pages() ?? []) {
    if (!isChatGptPage(page)) continue
    const modal = page.locator(RATE_LIMIT_SELECTOR).first()
    if (!(await modal.isVisible().catch(() => false))) continue
    const button = modal.getByRole("button", { name: /got it|okay|ok|close/i }).first()
    await button.click().catch(() => page.keyboard.press("Escape"))
    await delay(RATE_LIMIT_DISMISS_SETTLE_MS, signal)
  }
  state.rateLimitedUntil = 0
}

function completeTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState, response: string): void {
  if (turn.status !== "running") return
  const now = Date.now()
  const page = agent.page
  if (!agent.conversationUrl && page && !page.isClosed() && extractConversationId(page.url())) agent.conversationUrl = page.url()
  agent.lastCompletedAt = now
  agent.lastUsedAt = now
  turn.status = "completed"
  turn.response = response
  settleTurn(state, turn, agent)
  state.pendingEvents.push(`agent_finished:${turn.agentId}:${turn.turnId}`)
}

function failTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState, error: unknown): void {
  if (turn.status !== "running") return
  turn.status = "failed"
  turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
  turn.errorMessage = error instanceof Error ? error.message : String(error)
  settleTurn(state, turn, agent)
}

function settleTurn(state: ChatGptSubagentRuntimeState, turn: BrowserTurnState, agent: BrowserAgentState): void {
  void turn.observation?.dispose().catch(() => undefined)
  turn.observation = undefined
  if (state.activeOperations.get(agent.agentId) === turn.turnId) state.activeOperations.delete(agent.agentId)
  turn.settle()
}

async function connectOnce(state: ChatGptSubagentRuntimeState): Promise<void> {
  try {
    const { chromium } = await import("playwright-core")
    state.browser = await chromium.connectOverCDP(state.cdpEndpoint, { timeout: state.connectTimeoutMs })
  } catch (error) {
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
  if (!context) throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "Connected Chrome instance did not expose a browser context.")
  state.context = context
}

async function createManagedPage(state: ChatGptSubagentRuntimeState): Promise<Page> {
  if (!state.browser || !state.context) throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "ChatGPT browser is not connected.")
  const page = await createBackgroundPage(state.browser, state.context)
  try {
    await page.setViewportSize(MANAGED_VIEWPORT)
    return page
  } catch (error) {
    if (!page.isClosed()) await page.close().catch(() => undefined)
    throw error
  }
}

function bindConversation(agent: BrowserAgentState, conversationId: string): void {
  const pageUrl = agent.page && !agent.page.isClosed() ? agent.page.url() : undefined
  if (pageUrl && extractConversationId(pageUrl) === conversationId) agent.conversationUrl = pageUrl
  else if (extractConversationId(agent.conversationUrl ?? "") !== conversationId) {
    agent.conversationUrl = `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
  }
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
  for (const page of state.context?.pages() ?? []) {
    if (!isChatGptPage(page)) continue
    const visible = await page
      .locator(RATE_LIMIT_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false)
    if (!visible) continue
    state.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
    throw new ChatGptSubagentError(
      "SUBAGENT_RATE_LIMITED",
      "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."
    )
  }
}

function isChatGptPage(page: Page): boolean {
  try {
    return new URL(page.url()).hostname === "chatgpt.com"
  } catch {
    return false
  }
}

export async function cleanupIdleAgents(state: ChatGptSubagentRuntimeState, now = Date.now()): Promise<void> {
  if (state.disposed) return
  for (const agent of state.agents.values()) {
    const activeOperation = state.activeOperations.get(agent.agentId)
    const activeTurn = typeof activeOperation === "string" ? state.turns.get(activeOperation) : undefined

    if (activeTurn?.status === "running") {
      if (now - activeTurn.lastActivityAt >= AGENT_IDLE_TTL_MS) {
        await failOrRecoverSubmittedTurn(
          state,
          activeTurn,
          agent,
          new ChatGptSubagentError("AGENT_IDLE_EXPIRED", "ChatGPT subagent turn expired after 30 minutes without observable progress.")
        )
      }
      continue
    }

    if (activeOperation === null || now - agent.lastUsedAt < AGENT_IDLE_TTL_MS) continue
    const page = agent.page
    if (page && !page.isClosed()) await page.close().catch(() => undefined)
    if (agent.page === page) agent.page = undefined
  }
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
  await waitForPromise(Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]), signal).finally(() => {
    if (timer) clearTimeout(timer)
  })
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

export function appendFirstTurnMode(prompt: string, oververbosity: number): string {
  if (oververbosity === 5) return prompt
  const level = oververbosity === 1 ? "ultra" : oververbosity === 2 ? "full" : "lite"
  const qualifier = oververbosity === 4 ? " Favor completeness over terseness when useful." : ""
  return `${prompt}\n\n---\n\nSwitch to caveman ${level} mode. ${INJECTED_PROMPT}${qualifier}`
}
