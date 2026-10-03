import { StringDecoder } from "node:string_decoder"
import type { CDPSession, Page } from "playwright-core"

import {
  type ChatGptTurnCompletion,
  type ChatGptTurnEvents,
  ChatGptTurnTracker,
  submittedUserMessageId,
} from "./turn-protocol.js"

export interface AssistantResponseObservation {
  response: Promise<ChatGptTurnCompletion>
  /**
   * Invoke Send once. On action failure, finish reading metadata for requests
   * already observed and preserve a known submission; otherwise rethrow.
   */
  submit(action: () => Promise<void>): Promise<void>
  dispose(): Promise<void>
}

const SSE_EVENT_BOUNDARY_RE = /\r?\n\r?\n/u

interface HttpStream {
  decoder: StringDecoder
  buffer: string
  ready?: Promise<void>
}

/**
 * Install on an idle managed page before Send. The first new user-message POST
 * supplies the identity for HTTP, WebSocket, and history recovery. Never resends.
 */
export async function observeAssistantResponse(
  page: Page,
  input: ChatGptTurnEvents & {
    onSubmitted?: (messageId: string) => void
  }
): Promise<AssistantResponseObservation> {
  let messageId: string | undefined
  let webSocketTracker: ChatGptTurnTracker | undefined
  let httpTracker: ChatGptTurnTracker | undefined
  const requests = new Map<string, Promise<boolean>>()
  const streams = new Map<string, HttpStream>()
  let cdp: CDPSession | undefined
  let settled = false
  let resolveResponse!: (response: ChatGptTurnCompletion) => void
  let rejectResponse!: (error: unknown) => void
  const response = new Promise<ChatGptTurnCompletion>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  // Submission can fail before the service starts awaiting this promise. Keep
  // disposal/page-close rejection handled while preserving it for response consumers.
  void response.catch(() => undefined)

  const cleanup = async (): Promise<void> => {
    page.off("close", pageCloseHandler)
    await cdp?.detach().catch(() => undefined)
    cdp = undefined
  }

  const finish = (result?: ChatGptTurnCompletion): void => {
    if (!result || settled) return
    settled = true
    resolveResponse(result)
    void cleanup()
  }

  const feedHttp = (requestId: string, data: string): void => {
    const stream = streams.get(requestId)
    if (settled || !stream || !data) return
    // CDP chunks are bytes and can split a UTF-8 code point, including between
    // streamResourceContent's buffered prefix and subsequent dataReceived events.
    let buffer = stream.buffer + stream.decoder.write(Buffer.from(data, "base64"))
    let match = SSE_EVENT_BOUNDARY_RE.exec(buffer)
    while (match) {
      const end = match.index + match[0].length
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end)
      finish(httpTracker?.ingestSse(block))
      if (settled) return
      match = SSE_EVENT_BOUNDARY_RE.exec(buffer)
    }
    stream.buffer = buffer
  }

  const frameHandler = (event: { response?: { opcode: number; payloadData?: string } }): void => {
    const frame = event.response
    if (!frame || (frame.opcode !== 1 && frame.opcode !== 2)) return
    const payload =
      frame.opcode === 2
        ? Buffer.from(frame.payloadData ?? "", "base64").toString("utf8")
        : frame.payloadData
    if (!payload || settled) return
    // CDP may omit inline POST data. Wait for its retrieval before consuming frames.
    void Promise.all(requests.values())
      .then(() => {
        if (!settled) finish(webSocketTracker?.ingestFrame(payload))
      })
      .catch(() => undefined)
  }

  const bindRequest = (postData: string): boolean => {
    if (settled) return false
    const submittedId = submittedUserMessageId(postData)
    if (!submittedId || (messageId && submittedId !== messageId)) return false
    if (!messageId) {
      messageId = submittedId
      httpTracker = new ChatGptTurnTracker(messageId, input)
      webSocketTracker = new ChatGptTurnTracker(messageId, input)
      input.onSubmitted?.(messageId)
    }
    return true
  }

  const requestHandler = (event: {
    requestId: string
    request?: { url?: string; method?: string; postData?: string }
  }): void => {
    if (
      settled ||
      !cdp ||
      event.request?.method !== "POST" ||
      !isConversationEndpoint(event.request.url)
    )
      return
    streams.set(event.requestId, { decoder: new StringDecoder("utf8"), buffer: "" })
    requests.set(
      event.requestId,
      event.request.postData
        ? Promise.resolve(bindRequest(event.request.postData))
        : cdp
            .send("Network.getRequestPostData", { requestId: event.requestId })
            .then((result) => bindRequest(result.postData))
            .catch(() => false)
    )
  }

  const responseHandler = (event: { requestId: string }): void => {
    const stream = streams.get(event.requestId)
    if (!stream) return
    // Preserve wire order even if data events arrive before the command promise
    // resolves. Its buffered prefix always precedes the live chunks.
    stream.ready = requests
      .get(event.requestId)
      ?.then(async (matches) => {
        if (!matches || settled || !cdp) return
        const result = await cdp.send("Network.streamResourceContent", {
          requestId: event.requestId,
        })
        const bufferedData = typeof result.bufferedData === "string" ? result.bufferedData : ""
        feedHttp(event.requestId, bufferedData)
      })
      .catch(() => undefined)
  }

  const dataHandler = (event: { requestId: string; data?: string }): void => {
    const data = event.data
    if (!data) return
    void requests
      .get(event.requestId)
      ?.then(async (matches) => {
        await streams.get(event.requestId)?.ready
        if (matches) feedHttp(event.requestId, data)
      })
      .catch(() => undefined)
  }

  const loadingFinishedHandler = (event: { requestId: string }): void => {
    void requests
      .get(event.requestId)
      ?.then(async (matches) => {
        if (!matches || settled || !cdp || !messageId) return
        const result = await cdp.send("Network.getResponseBody", { requestId: event.requestId })
        if (settled || typeof result.body !== "string") return
        const body = result.base64Encoded
          ? Buffer.from(result.body, "base64").toString("utf8")
          : result.body
        const fallback = new ChatGptTurnTracker(messageId, input)
        finish(fallback.ingestSse(body))
      })
      .catch(() => undefined)
  }

  const pageCloseHandler = (): void => {
    if (settled) return
    settled = true
    rejectResponse(new Error("ChatGPT managed page closed while a subagent turn was running."))
    void cleanup()
  }

  try {
    cdp = await page.context().newCDPSession(page)
    await cdp.send("Network.enable")
    cdp.on("Network.webSocketFrameReceived", frameHandler)
    cdp.on("Network.requestWillBeSent", requestHandler)
    cdp.on("Network.responseReceived", responseHandler)
    cdp.on("Network.dataReceived", dataHandler)
    cdp.on("Network.loadingFinished", loadingFinishedHandler)
    page.on("close", pageCloseHandler)
  } catch (error) {
    await cleanup()
    throw error
  }

  return {
    response,
    async submit(action) {
      try {
        await action()
      } catch (error) {
        await Promise.all(requests.values())
        if (!messageId) throw error
      }
    },
    async dispose() {
      if (!settled) {
        settled = true
        rejectResponse(new Error("ChatGPT subagent response observation was disposed."))
      }
      await cleanup()
    },
  }
}

function isConversationEndpoint(value?: string): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.hostname === "chatgpt.com" && url.pathname === "/backend-api/f/conversation"
  } catch {
    return false
  }
}
