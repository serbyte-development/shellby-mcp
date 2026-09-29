import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import type { Browser, BrowserContext, Locator, Page } from "playwright-core"
import { ChatGptDelegationError } from "./subagent-error.js"

const BACKGROUND_PAGE_BIND_TIMEOUT_MS = 5_000
const CHATGPT_OPERATION_TIMEOUT_MS = 120_000
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  '[contenteditable="true"][data-composer-markdown]',
  '[contenteditable="true"][aria-label*="Chat with ChatGPT" i]',
  '[contenteditable="true"][aria-label*="Ask ChatGPT" i]',
  'textarea[placeholder*="Ask ChatGPT" i]:not(.wcDTda_fallbackTextarea)',
] as const

const LATEST_FORKABLE_TURN_SELECTOR =
  'section[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])'
const BRANCH_IN_NEW_CHAT_RE = /^Branch in new chat$/iu

export async function createBackgroundPage(
  browser: Browser,
  context: BrowserContext
): Promise<Page> {
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
      await delay(100)
    }
    throw new ChatGptDelegationError(
      "BROWSER_UNAVAILABLE",
      `Chrome created background target ${targetId}, but Playwright did not expose it.`
    )
  } catch (error) {
    if (targetId) await session.send("Target.closeTarget", { targetId }).catch(() => undefined)
    throw error
  } finally {
    await session.detach().catch(() => undefined)
  }
}

export async function findComposer(page: Page, signal?: AbortSignal): Promise<Locator> {
  const deadline = Date.now() + CHATGPT_OPERATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector).first()
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false)))
        return locator
    }
    await delay(200, signal)
  }
  throw new ChatGptDelegationError(
    "CHATGPT_UI_CHANGED",
    `Could not find the ChatGPT composer within ${CHATGPT_OPERATION_TIMEOUT_MS} ms.`
  )
}

export async function forkLatestConversationTurn(page: Page, signal?: AbortSignal): Promise<Page> {
  throwIfAborted(signal)
  const sourceId = extractConversationId(page.url())
  const latestForkableTurn = page.locator(LATEST_FORKABLE_TURN_SELECTOR).last()
  await waitForVisibleLocator(
    latestForkableTurn,
    CHATGPT_OPERATION_TIMEOUT_MS,
    signal,
    "latest forkable assistant turn"
  )
  await latestForkableTurn.scrollIntoViewIfNeeded()
  await latestForkableTurn.hover()

  const moreActions = latestForkableTurn.locator('button[aria-label="More actions"]').last()
  await waitForVisibleLocator(
    moreActions,
    CHATGPT_OPERATION_TIMEOUT_MS,
    signal,
    'latest forkable assistant turn "More actions" button'
  )
  await retryAfterDismissingBlockingOverlay(page, () => moreActions.click(), signal)

  const openNewBranch = page.getByRole("menuitem", { name: "Open new branch", exact: true }).last()
  const branchInNewChat = page.getByRole("menuitem", { name: BRANCH_IN_NEW_CHAT_RE }).last()
  const menuDeadline = Date.now() + CHATGPT_OPERATION_TIMEOUT_MS
  // ChatGPT can expose the action directly or under "Open new branch". In the
  // nested menu, lazy items move the trigger: re-hover until its submenu is ready.
  while (!(await branchInNewChat.isVisible())) {
    throwIfAborted(signal)
    if (Date.now() >= menuDeadline)
      throw new ChatGptDelegationError("CHATGPT_UI_CHANGED", 'Could not open "Branch in new chat".')
    if (await openNewBranch.isVisible()) await openNewBranch.hover()
    await delay(200, signal)
  }
  let popup: Page | undefined
  const onPopup = (created: Page) => {
    popup = created
  }
  // Other callers can create pages concurrently. Only this source's popup is our branch.
  page.on("popup", onPopup)
  try {
    // Keep the pointer on the parent trigger: crossing the submenu gap can close
    // it before a mouse click lands. Enter activates the focused branch action.
    await branchInNewChat.press("Enter", { noWaitAfter: true })
    const deadline = Date.now() + CHATGPT_OPERATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const branchPage = popup ?? page
      if (
        isChatGptUrl(branchPage.url()) &&
        CHATGPT_CONVERSATION_ID_RE.test(new URL(branchPage.url()).pathname) &&
        // ChatGPT can redirect the source into its project URL while opening the
        // branch. Only a different conversation (including a client-side draft) is new.
        extractConversationId(branchPage.url()) !== sourceId
      ) {
        await findComposerBefore(branchPage, deadline, signal)
        return branchPage
      }
      await delay(200, signal)
    }
    throw new ChatGptDelegationError(
      "CHATGPT_UI_CHANGED",
      `ChatGPT did not open a new branch within ${CHATGPT_OPERATION_TIMEOUT_MS} ms.`
    )
  } catch (error) {
    await popup?.close().catch(() => undefined)
    throw error
  } finally {
    page.off("popup", onPopup)
  }
}

export async function assertAuthenticated(page: Page): Promise<void> {
  const url = new URL(page.url())
  const loginRoute = CHATGPT_LOGIN_ROUTE_RE.test(url.pathname)
  const visibleLogin = await page
    .locator('a[href*="/auth/login"], a[href*="/auth/signin"], button:has-text("Log in")')
    .first()
    .isVisible()
    .catch(() => false)
  if (loginRoute || visibleLogin) {
    throw new ChatGptDelegationError(
      "CHATGPT_NOT_AUTHENTICATED",
      "The attached Chrome instance is not authenticated to ChatGPT. Sign in in that Chrome profile before using subagents."
    )
  }
}

const CHATGPT_LOGIN_ROUTE_RE = /\/auth\/(login|signin)/iu
const CHATGPT_CONVERSATION_ID_RE = /(?:^|\/)c\/([^/?#]+)/u
const CHATGPT_DRAFT_ID_RE = /^(?:web|local-chatgpt):/iu

export async function navigateAndCaptureConversationPayload(
  page: Page,
  conversationUrl: string
): Promise<unknown | undefined> {
  const conversationId = extractConversationId(conversationUrl)
  if (!conversationId) return undefined
  const responsePromise = page
    .waitForResponse(
      (response) =>
        isConversationPayloadUrl(response.url(), conversationId) && response.status() === 200,
      {
        timeout: 10_000,
      }
    )
    .then((response) => response.json())
    .catch(() => undefined)

  await navigateChatGptPage(page, conversationUrl)
  return responsePromise
}

export async function navigateChatGptPage(
  page: Page,
  url: string,
  signal?: AbortSignal
): Promise<void> {
  await waitForPromise(
    page.goto(url, { waitUntil: "domcontentloaded", timeout: CHATGPT_OPERATION_TIMEOUT_MS }),
    signal
  )
}

export async function enterPrompt(
  page: Page,
  composer: Locator,
  prompt: string,
  signal?: AbortSignal
): Promise<void> {
  await retryAfterDismissingBlockingOverlay(page, () => composer.click(), signal)
  await composer.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
  await composer.press("Backspace")
  await page.keyboard.insertText(prompt)
}

export async function submitComposer(
  page: Page,
  composer: Locator,
  signal?: AbortSignal
): Promise<void> {
  await dismissBlockingChatGptOverlay(page, signal)
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send" i]',
  ]
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of selectors) {
      const button = page.locator(selector).first()
      if (
        (await button.count()) > 0 &&
        (await button.isVisible().catch(() => false)) &&
        (await button.isEnabled().catch(() => false))
      ) {
        // Send can start generation before navigation settles. Completion belongs to the
        // response observer; a navigation timeout must not discard an already-sent turn.
        // Do not retry Send after an error: the request may already be in flight.
        await button.click({ noWaitAfter: true })
        return
      }
    }
    await delay(200, signal)
  }
  await composer.press("Enter", { noWaitAfter: true })
}

export async function dismissBlockingChatGptOverlay(
  page: Page,
  signal?: AbortSignal
): Promise<boolean> {
  throwIfAborted(signal)
  const overlay = page.locator('#modal-beacon, [data-testid="modal-beacon"]').first()
  if ((await overlay.count()) === 0 || !(await overlay.isVisible().catch(() => false))) return false
  await page.keyboard.press("Escape")
  await delay(250, signal)
  return true
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new ChatGptDelegationError(
    "REQUEST_ABORTED",
    "The ChatGPT subagent request was cancelled. A turn that was already submitted will not be retried automatically."
  )
}

export async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        new ChatGptDelegationError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled.")
      )
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
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

async function retryAfterDismissingBlockingOverlay<T>(
  page: Page,
  action: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!(await dismissBlockingChatGptOverlay(page, signal))) throw error
    return action()
  }
}

async function waitForVisibleLocator(
  locator: Locator,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  description: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return
    await delay(100, signal)
  }
  throw new ChatGptDelegationError(
    "CHATGPT_UI_CHANGED",
    `Could not find ${description} within ${timeoutMs} ms.`
  )
}

async function findComposerBefore(
  page: Page,
  deadline: number,
  signal?: AbortSignal
): Promise<Locator> {
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector).first()
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false)))
        return locator
    }
    await delay(200, signal)
  }
  throw new ChatGptDelegationError(
    "CHATGPT_UI_CHANGED",
    "Could not find the ChatGPT composer before the branch operation timed out."
  )
}

export function isChatGptUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "chatgpt.com"
  } catch {
    return false
  }
}

function isConversationPayloadUrl(value: string, conversationId: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.hostname === "chatgpt.com" &&
      url.pathname === `/backend-api/conversations/${conversationId}`
    )
  } catch {
    return false
  }
}

/** Extract durable identity; local-chatgpt: and WEB: routes are client-side drafts. */
export function extractConversationId(value: string): string | undefined {
  try {
    const match = new URL(value).pathname.match(CHATGPT_CONVERSATION_ID_RE)
    const rawConversationId = match?.[1]
    if (!rawConversationId) return undefined
    const conversationId = decodeURIComponent(rawConversationId)
    return CHATGPT_DRAFT_ID_RE.test(conversationId) ? undefined : conversationId
  } catch {
    return undefined
  }
}

/** Wait in milliseconds; cancellation rejects with REQUEST_ABORTED. */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal })
  } catch (error) {
    if (signal?.aborted) {
      // biome-ignore lint/style/useErrorCause: ChatGptDelegationError takes ErrorOptions as its third argument.
      throw new ChatGptDelegationError(
        "REQUEST_ABORTED",
        "The ChatGPT subagent request was cancelled.",
        { cause: error }
      )
    }
    throw error
  }
}
