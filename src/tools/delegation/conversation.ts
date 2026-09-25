import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import {
  assertAuthenticated,
  createBackgroundPage,
  extractConversationId,
  findComposer,
  forkLatestConversationTurn,
  isChatGptUrl,
  navigateChatGptPage,
  throwIfAborted,
} from "./chatgpt-browser.js"
import { ChatGptDelegationError } from "./contracts.js"
import type { DelegationDiagnostics } from "./diagnostics.js"

const CONVERSATION_ID_PATTERN = /^[\w-]+$/u

type ConversationStart = { kind: "new"; startSource?: string } | { kind: "resume"; url: string }

/**
 * Open a ready conversation without submitting a prompt. A new conversation may
 * inherit a source given as a conversation ID or ChatGPT conversation URL; a resume
 * always opens the saved conversation itself. Invalid sources fail before a tab opens.
 * The caller owns the returned page. Failed startup closes pages it created and
 * records diagnostics before cleanup. All conversations are saved; fresh chats
 * start at the configured ChatGPT URL. A fork may still have a client-side draft
 * URL; its first normal turn establishes durable identity, just like a fresh chat.
 */
export async function startConversation(
  browser: Browser | undefined,
  context: BrowserContext | undefined,
  start: ConversationStart,
  diagnostics: DelegationDiagnostics,
  signal?: AbortSignal
): Promise<Page> {
  throwIfAborted(signal)
  if (!browser || !context)
    throw new ChatGptDelegationError("BROWSER_UNAVAILABLE", "ChatGPT browser is not connected.")
  const { url, forkSourceId } = resolveConversationStart(start)

  const ownedPages = new Set<Page>()
  try {
    diagnostics.stage("create-page")
    let page = await createBackgroundPage(browser, context)
    ownedPages.add(page)
    diagnostics.watch(page)
    diagnostics.stage(forkSourceId ? "navigate-source" : "navigate")
    await navigateChatGptPage(page, url, signal)
    diagnostics.stage("authenticate")
    await assertAuthenticated(page)

    if (forkSourceId) {
      if (extractConversationId(page.url()) !== forkSourceId) {
        throw new ChatGptDelegationError(
          "AGENT_TARGET_LOST",
          "The source conversation did not open."
        )
      }
      const sourcePage = page
      diagnostics.stage("branch-conversation")
      page = await forkLatestConversationTurn(sourcePage, signal)
      ownedPages.add(page)
      diagnostics.watch(page)
      if (page !== sourcePage) {
        await sourcePage.close()
        ownedPages.delete(sourcePage)
      }
    }

    const conversationId = extractConversationId(page.url())
    const expectedId = start.kind === "resume" ? extractConversationId(start.url) : undefined
    const matches = forkSourceId ? conversationId !== forkSourceId : conversationId === expectedId
    if (!isChatGptUrl(page.url()) || !matches) {
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        "The requested conversation did not open."
      )
    }
    diagnostics.stage("find-composer")
    await findComposer(page, signal)
    return page
  } catch (error) {
    await diagnostics.failure(error)
    await Promise.allSettled([...ownedPages].map((page) => page.close()))
    throw error
  }
}

/** Resolve creation options before browser work; saved identity always refers to the target itself. */
function resolveConversationStart(start: ConversationStart): {
  url: string
  forkSourceId?: string
} {
  if (start.kind === "resume") {
    if (!isChatGptUrl(start.url) || !extractConversationId(start.url)) {
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        "The saved conversation URL is invalid."
      )
    }
    return { url: start.url }
  }
  if (start.startSource === undefined) return { url: MCP_CONFIG.chatGpt.projectUrl }
  const startSource = start.startSource.trim()
  let forkSourceId: string | undefined = startSource
  if (!CONVERSATION_ID_PATTERN.test(startSource)) {
    try {
      const sourceUrl = new URL(startSource)
      forkSourceId =
        sourceUrl.origin === "https://chatgpt.com"
          ? extractConversationId(sourceUrl.href)
          : undefined
    } catch {
      forkSourceId = undefined
    }
  }
  if (!forkSourceId || !CONVERSATION_ID_PATTERN.test(forkSourceId) || forkSourceId.length > 128) {
    throw new ChatGptDelegationError(
      "INVALID_ARGUMENT",
      "start_from must be a saved ChatGPT conversation URL or conversation ID."
    )
  }
  return { url: `https://chatgpt.com/c/${forkSourceId}`, forkSourceId }
}
