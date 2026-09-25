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
import { delay } from "./delay.js"
import type { DelegationDiagnostics } from "./diagnostics.js"

const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true"
const FORK_INITIAL_SETTLE_MS = 5_000
const CONVERSATION_ID_PATTERN = /^[\w-]+$/u

type ConversationStart =
  | { kind: "new"; memory: boolean; conversationId?: string }
  | { kind: "resume"; url: string }

/**
 * Open a ready conversation without submitting a prompt. A new conversation may
 * inherit a supplied source; a resume always opens the saved conversation itself.
 * The caller owns the returned page. Failed startup closes pages it created and
 * records diagnostics before cleanup. Memory selects the mode only for fresh chats;
 * forks always create saved conversations.
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
  const sourceId = start.kind === "new" ? start.conversationId : undefined
  const url = conversationStartUrl(start)

  const ownedPages = new Set<Page>()
  try {
    diagnostics.stage("create-page")
    let page = await createBackgroundPage(browser, context)
    ownedPages.add(page)
    diagnostics.watch(page)
    diagnostics.stage(sourceId ? "navigate-source" : "navigate")
    await navigateChatGptPage(page, url, signal)
    diagnostics.stage("authenticate")
    await assertAuthenticated(page)

    if (sourceId) {
      if (extractConversationId(page.url()) !== sourceId) {
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
      await delay(FORK_INITIAL_SETTLE_MS, signal)
    }

    const conversationId = extractConversationId(page.url())
    const expectedId = start.kind === "resume" ? extractConversationId(start.url) : undefined
    const matches = sourceId ? conversationId !== sourceId : conversationId === expectedId
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
function conversationStartUrl(start: ConversationStart): string {
  if (start.kind === "resume") {
    if (!isChatGptUrl(start.url) || !extractConversationId(start.url)) {
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        "The saved conversation URL is invalid."
      )
    }
    return start.url
  }
  const sourceId = start.conversationId
  if (sourceId === undefined)
    return start.memory ? MCP_CONFIG.chatGpt.projectUrl : TEMPORARY_CHAT_URL
  if (!CONVERSATION_ID_PATTERN.test(sourceId) || sourceId.length > 128) {
    throw new ChatGptDelegationError(
      "INVALID_ARGUMENT",
      "conversation_id must be a conversation ID."
    )
  }
  return `https://chatgpt.com/c/${sourceId}`
}
