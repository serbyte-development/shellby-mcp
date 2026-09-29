import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { setImmediate } from "node:timers/promises"
import type { Browser, BrowserContext, Page } from "playwright-core"
import { extractConversationId } from "../../src/tools/delegation/chatgpt-browser.js"
import { mcpToolResponse } from "./chatgpt-tool-response.js"

export function browserFixture(
  options: {
    stableUrlOnSubmit?: boolean
    completeOnSubmit?: boolean
    pageCloseFailures?: number
    navigationStalls?: boolean
    afterSendError?: boolean
    submissionError?: Error
    serializePrompt?: boolean
    inlinePostData?: boolean
    branchInSamePage?: boolean
    branchError?: Error
    branchConversationId?: string
  } = {}
): {
  browser: Browser
  pages: Page[]
  readonly submissions: number
  readonly branches: number
  readonly historyReads: number
  prompts: string[]
  navigations: string[]
  completeTurn: (submission: number, text: string) => void
  toolResponse: (submission: number, text: string) => void
} {
  const pages: Page[] = []
  const sessions = new Map<
    Page,
    EventEmitter & { send(method: string): Promise<unknown>; detach(): Promise<void> }
  >()
  const completions = new Map<number, (text: string) => void>()
  const toolResponses = new Map<number, (text: string) => void>()
  let connected = true
  let submissions = 0
  let branches = 0
  let historyReads = 0
  const prompts: string[] = []
  const navigations: string[] = []
  let remainingPageCloseFailures = options.pageCloseFailures ?? 0
  const context = {
    pages: () => pages.filter((page) => !page.isClosed()),
    newCDPSession: async (page: Page) => sessions.get(page),
  }
  const browser = {
    isConnected: () => connected,
    contexts: () => [context],
    close: async () => {
      connected = false
    },
    newBrowserCDPSession: async () => ({
      detach: async () => {},
      send: async (method: string) => {
        assert.equal(method, "Target.createTarget")
        const targetId = `target-${pages.length}`
        let closed = false
        let url = "about:blank"
        let prompt = ""
        let requestPostData = ""
        const cdp = Object.assign(new EventEmitter(), {
          send: async (method: string) => {
            if (method === "Network.getRequestPostData") {
              await setImmediate()
              return { postData: requestPostData }
            }
            return { targetInfo: { targetId } }
          },
          detach: async (): Promise<void> => {
            cdp.removeAllListeners()
          },
        })
        const page = Object.assign(new EventEmitter(), {
          isClosed: () => closed,
          close: async () => {
            if (remainingPageCloseFailures > 0) {
              remainingPageCloseFailures -= 1
              throw new Error("forced page close failure")
            }
            closed = true
            ;(page as unknown as EventEmitter).emit("close")
          },
          url: () => url,
          goto: async (value: string) => {
            navigations.push(value)
            url = value
          },
          evaluate: async () => {
            historyReads += 1
          },
          waitForResponse: async () => ({ json: async () => undefined }),
          context: () => context as unknown as BrowserContext,
          keyboard: {
            insertText: async (value: string) => {
              prompt = value
            },
          },
          getByRole: (_role: string, input: { name: string }) => {
            const item = {
              last: () => item,
              count: async () => 1,
              isVisible: async () => true,
              hover: async () => {},
              press: async (key: string) => {
                if (key === "Enter") await item.click()
              },
              click: async () => {
                if (input.name !== "Branch in new Chat") return
                branches += 1
                const branchUrl = `https://chatgpt.com/c/${options.branchConversationId ?? `branch-${branches}`}`
                if (options.branchInSamePage) url = branchUrl
                else {
                  const browserSession = await browser.newBrowserCDPSession()
                  await browserSession.send("Target.createTarget", { url: "about:blank" })
                  const branch = pages.at(-1)!
                  await branch.goto(branchUrl)
                  ;(page as unknown as EventEmitter).emit("popup", branch)
                }
                if (options.branchError) throw options.branchError
              },
            }
            return item
          },
          locator: (selector: string) => {
            const visible =
              selector === "#prompt-textarea" ||
              selector === 'button[data-testid="send-button"]' ||
              selector.startsWith("section[") ||
              selector === 'button[aria-label="More actions"]'
            const locator = {
              first: () => locator,
              last: () => locator,
              locator: (nested: string) => page.locator(nested),
              scrollIntoViewIfNeeded: async () => {},
              hover: async () => {},
              count: async () => Number(visible),
              isVisible: async () => visible,
              isEnabled: async () => true,
              press: async () => {},
              click: async (clickOptions?: { noWaitAfter?: boolean }) => {
                if (selector !== 'button[data-testid="send-button"]') return
                if (options.submissionError) throw options.submissionError
                submissions += 1
                prompts.push(prompt)
                const userMessage = {
                  id: `submitted-user-${submissions}`,
                  author: { role: "user" },
                  content: {
                    parts: [
                      options.serializePrompt
                        ? prompt
                            .replaceAll(
                              "https://example.com/",
                              "[https://example.com/](https://example.com/)"
                            )
                            .replaceAll("`", "\\`")
                            .replaceAll("---", "\\---")
                        : prompt,
                    ],
                  },
                }
                const conversationId =
                  extractConversationId(url) ??
                  (options.stableUrlOnSubmit
                    ? `lifecycle-conversation-${targetId}`
                    : "lifecycle-conversation")
                // Real ChatGPT establishes its URL during submission. Keep fake targets
                // distinct so simultaneous agents cannot accidentally share identity.
                if (options.stableUrlOnSubmit) url = `https://chatgpt.com/c/${conversationId}`
                const encode = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
                const initial = encode({
                  v: { message: userMessage },
                  conversation_id: conversationId,
                })
                toolResponses.set(submissions, (text) => {
                  cdp.emit("Network.dataReceived", {
                    requestId: "turn",
                    data: Buffer.from(
                      encode({ v: { message: mcpToolResponse("tool-result", text) } })
                    ).toString("base64"),
                  })
                })
                completions.set(submissions, (text) => {
                  const body =
                    encode({
                      v: {
                        message: {
                          author: { role: "assistant" },
                          content: { parts: [text] },
                          status: "finished_successfully",
                          end_turn: true,
                        },
                      },
                    }) +
                    encode({ type: "message_stream_complete", conversation_id: conversationId })
                  cdp.emit("Network.dataReceived", {
                    requestId: "turn",
                    data: Buffer.from(body).toString("base64"),
                  })
                })
                requestPostData = JSON.stringify({ action: "next", messages: [userMessage] })
                cdp.emit("Network.requestWillBeSent", {
                  requestId: "turn",
                  request: {
                    method: "POST",
                    url: "https://chatgpt.com/backend-api/f/conversation",
                    ...(options.inlinePostData === false ? {} : { postData: requestPostData }),
                  },
                })
                cdp.emit("Network.dataReceived", {
                  requestId: "turn",
                  data: Buffer.from(initial).toString("base64"),
                })
                if (options.completeOnSubmit !== false) completions.get(submissions)!("Reviewed")
                if (
                  options.afterSendError ||
                  (options.navigationStalls && !clickOptions?.noWaitAfter)
                )
                  throw new Error("Navigation timed out after Send")
              },
            }
            return locator
          },
        }) as unknown as Page
        pages.push(page)
        sessions.set(page, cdp)
        return { targetId }
      },
    }),
  } as unknown as Browser
  return {
    browser,
    pages,
    get submissions() {
      return submissions
    },
    get historyReads() {
      return historyReads
    },
    get branches() {
      return branches
    },
    prompts,
    navigations,
    toolResponse: (submission, text) => {
      const respond = toolResponses.get(submission)
      assert.ok(respond, `Submission ${submission} must exist before its tool response`)
      respond(text)
    },
    completeTurn: (submission, text) => {
      const complete = completions.get(submission)
      assert.ok(complete, `Unknown submission ${submission}`)
      complete(text)
    },
  }
}
