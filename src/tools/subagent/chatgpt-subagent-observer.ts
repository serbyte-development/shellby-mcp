import { randomUUID } from "node:crypto"

import type { CDPSession, Page, Response } from "playwright-core"

import type { ChatGptSubagentActivity } from "./chatgpt-subagent-contracts.js"
import { ChatGptStructuredTurnTracker } from "./chatgpt-subagent-protocol.js"

export interface DomAssistantMessage {
  key: string
  text: string
}

export interface AssistantResponseObservation {
  response: Promise<string>
  dispose(): Promise<void>
}

export async function observeAssistantResponse(
  page: Page,
  input: {
    baselineDom: readonly DomAssistantMessage[]
    prompt: string
    settleMs: number
    onActivity?: (activity: ChatGptSubagentActivity) => void
  }
): Promise<AssistantResponseObservation> {
  const tracker = new ChatGptStructuredTurnTracker(input.prompt, input.onActivity)
  const observerToken = randomUUID()
  let cdp: CDPSession | undefined
  let domObserverToken: string | undefined
  let domObserverAttempt = 0
  let domCancelled = false
  let settled = false
  let settleTimer: NodeJS.Timeout | undefined
  let cleanupPromise: Promise<void> | undefined
  let resolveResponse!: (response: string) => void
  let rejectResponse!: (error: unknown) => void
  const response = new Promise<string>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (settleTimer) clearTimeout(settleTimer)
      domCancelled = true
      if (domObserverToken) await cancelDomObserver(page, domObserverToken)
      page.off("response", responseHandler)
      page.off("close", pageCloseHandler)
      await cdp?.detach().catch(() => undefined)
    })()
    return cleanupPromise
  }

  const finish = (text: string): void => {
    if (settled) return
    settled = true
    resolveResponse(text)
    void cleanup()
  }

  const failObservation = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResponse(error)
    void cleanup()
  }

  const scheduleStructuredResponse = (text: string): void => {
    if (settled) return
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => finish(text), input.settleMs)
  }

  const frameHandler = (event: { response?: { payloadData?: string } }): void => {
    const payloadData = event.response?.payloadData
    if (!payloadData) return
    try {
      const text = tracker.ingestFrame(payloadData)
      if (text) scheduleStructuredResponse(text)
    } catch {
      // HTTP SSE and DOM observation remain available if the private WebSocket schema changes.
    }
  }

  const responseHandler = (candidate: Response): void => {
    if (!isAssistantEventStreamResponse(candidate)) return
    void candidate.text().then(
      (text) => {
        if (settled) return
        try {
          const response = tracker.ingestSse(text)
          if (response) scheduleStructuredResponse(response)
        } catch {
          // WebSocket and DOM remain available if the private SSE schema changes.
        }
      },
      () => undefined
    )
  }

  page.on("response", responseHandler)
  const pageCloseHandler = () => failObservation(new Error("ChatGPT managed page closed while waiting for the assistant response."))
  page.on("close", pageCloseHandler)

  try {
    cdp = await page.context().newCDPSession(page)
    await cdp.send("Network.enable")
    cdp.on("Network.webSocketFrameReceived", frameHandler)
  } catch {
    await cdp?.detach().catch(() => undefined)
    cdp = undefined
  }

  const domTask = (async () => {
    let allowWithoutGenerating = false
    while (!settled && !domCancelled) {
      const token = `${observerToken}:${domObserverAttempt++}`
      domObserverToken = token
      let navigated = false
      const onFrameNavigated = (frame: { url(): string }) => {
        if (frame === page.mainFrame()) navigated = true
      }
      page.on("framenavigated", onFrameNavigated)

      try {
        const text = await runDomAssistantObserver(page, {
          baseline: input.baselineDom,
          prompt: input.prompt,
          settleMs: input.settleMs,
          token,
          allowWithoutGenerating,
        })
        page.off("framenavigated", onFrameNavigated)
        if (text) finish(text)
        return
      } catch (error) {
        page.off("framenavigated", onFrameNavigated)
        if (settled || domCancelled) return
        if (!page.isClosed() && (navigated || isNavigationInterrupted(error))) {
          allowWithoutGenerating = true
          await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined)
          continue
        }
        return
      }
    }
  })()
  domTask.catch(() => undefined)

  return {
    response,
    async dispose() {
      if (!settled) {
        settled = true
        rejectResponse(new Error("ChatGPT assistant response observation was disposed."))
      }
      await cleanup()
    },
  }
}

export async function readAssistantDomMessages(page: Page): Promise<DomAssistantMessage[]> {
  return page.locator('[data-message-author-role="assistant"]').evaluateAll((elements) =>
    elements.map((element, index) => {
      const owner = element.closest("[data-message-id]")
      const messageId = owner?.getAttribute("data-message-id") ?? element.getAttribute("data-message-id") ?? undefined
      return {
        key: messageId ?? `assistant:${index}`,
        text: (element.textContent ?? "").trim(),
      }
    })
  )
}

async function runDomAssistantObserver(
  page: Page,
  input: {
    baseline: readonly DomAssistantMessage[]
    prompt: string
    settleMs: number
    token: string
    allowWithoutGenerating: boolean
  }
): Promise<string | null> {
  return page.evaluate(
    ({ baseline, prompt, settleMs, token, registryKey, allowWithoutGenerating }) =>
      new Promise<string | null>((resolve) => {
        const stopSelector = 'button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label="Stop"]'
        const baselineByKey = new Map(baseline.map((message) => [message.key, message.text]))
        const normalizedPrompt = prompt.trim()
        const registryHost = window as unknown as Record<string, Map<string, () => void>>
        const registry = (registryHost[registryKey] ??= new Map<string, () => void>())
        let timer: ReturnType<typeof setTimeout> | undefined
        let sawGenerating = false
        let lastText = ""
        let lastGenerating = false

        const isVisible = (element: Element | null): boolean => {
          if (!(element instanceof HTMLElement)) return false
          const style = window.getComputedStyle(element)
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0
        }

        const readCandidate = (): string => {
          const messages = [...document.querySelectorAll("[data-message-author-role]")].map((element, index) => {
            const owner = element.closest("[data-message-id]")
            return {
              role: element.getAttribute("data-message-author-role") ?? "",
              key: owner?.getAttribute("data-message-id") ?? element.getAttribute("data-message-id") ?? `message:${index}`,
              text: (element.textContent ?? "").trim(),
            }
          })
          let promptIndex = -1
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index]
            if (message?.role === "user" && message.text === normalizedPrompt) {
              promptIndex = index
              break
            }
          }
          if (promptIndex < 0) return ""

          const candidates = messages
            .slice(promptIndex + 1)
            .filter((message) => message.role === "assistant")
            .filter((message) => allowWithoutGenerating || !baselineByKey.has(message.key) || baselineByKey.get(message.key) !== message.text)
          return candidates.at(-1)?.text ?? ""
        }

        const finishDom = (value: string | null): void => {
          if (timer) clearTimeout(timer)
          observer.disconnect()
          registry.delete(token)
          resolve(value)
        }

        const inspect = (): void => {
          const generating = isVisible(document.querySelector(stopSelector))
          if (generating) sawGenerating = true
          const text = readCandidate()
          if (generating !== lastGenerating || text !== lastText) {
            lastGenerating = generating
            lastText = text
            if (timer) clearTimeout(timer)
            timer = undefined
          }
          if (generating || !text || /^thinking\b/i.test(text) || timer) return
          if (!sawGenerating && !allowWithoutGenerating) return

          const expectedText = text
          timer = setTimeout(() => {
            timer = undefined
            if (isVisible(document.querySelector(stopSelector))) return
            const current = readCandidate()
            if (!current || current !== expectedText) {
              inspect()
              return
            }
            finishDom(current)
          }, settleMs)
        }

        const observer = new MutationObserver(inspect)
        registry.set(token, () => finishDom(null))
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-label", "class", "data-testid"],
        })
        inspect()
      }),
    { ...input, registryKey: "__unhingedAssistantResponseObservers" }
  )
}

async function cancelDomObserver(page: Page, token: string): Promise<void> {
  await page
    .evaluate(
      ({ token, registryKey }) => {
        const registry = (window as unknown as Record<string, Map<string, () => void>>)[registryKey]
        registry?.get(token)?.()
      },
      { token, registryKey: "__unhingedAssistantResponseObservers" }
    )
    .catch(() => undefined)
}

function isAssistantEventStreamResponse(response: Response): boolean {
  try {
    const url = new URL(response.url())
    return (
      url.hostname === "chatgpt.com" &&
      url.pathname === "/backend-api/f/conversation" &&
      response.request().method() === "POST" &&
      response.headers()["content-type"]?.toLowerCase().includes("text/event-stream") === true
    )
  } catch {
    return false
  }
}

function isNavigationInterrupted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /execution context was destroyed|cannot find context with specified id|frame was detached|navigation/i.test(message)
}
