import type { Browser, BrowserContext, Locator, Page } from "playwright-core"

import { ChatGptSubagentError } from "./chatgpt-subagent-contracts.js"

const BACKGROUND_PAGE_BIND_TIMEOUT_MS = 5_000

export interface ManagedAgentPageState {
  agentId: string
  page: Page
  conversationId?: string
  conversationUrl?: string
}

export async function createBackgroundPage(browser: Browser, context: BrowserContext): Promise<Page> {
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
    if (extractConversationId(page.url()) !== conversationId || (await unavailable.isVisible().catch(() => false))) {
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

export async function navigateAndCaptureConversationPayload(
  page: Page,
  conversationUrl: string,
  conversationId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown | undefined> {
  const responsePromise = page
    .waitForResponse((response) => isConversationPayloadUrl(response.url(), conversationId) && response.status() === 200, {
      timeout: Math.min(timeoutMs, 10_000),
    })
    .then((response) => response.json())
    .catch(() => undefined)

  await waitForPromise(page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }), signal)
  throwIfAborted(signal)
  return waitForPromise(responsePromise, signal)
}

export function isConversationPayloadUrl(value: string, conversationId: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname === `/backend-api/conversations/${conversationId}`
  } catch {
    return false
  }
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
  return conversationId.toLowerCase().startsWith("web:") ? undefined : conversationId
}

function isChatGptUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "chatgpt.com"
  } catch {
    return false
  }
}
