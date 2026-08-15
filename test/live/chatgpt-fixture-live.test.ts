import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { MCP_CONFIG } from "../../src/config.js"
import { extractConversationMessages } from "../../src/tools/subagent/chatgpt-subagent-browser.js"

const LIVE_FIXTURE_ENABLED = process.env.RUN_LIVE_CHATGPT_FIXTURE_TESTS === "1" && !process.env.CI
const FIXTURE_CONVERSATION_ID = "6a80cfdd-8428-83e8-86ba-13f3d302d179"
const FIXTURE_URL = `https://chatgpt.com/c/${FIXTURE_CONVERSATION_ID}`
const FIXTURE_API_URL = `https://chatgpt.com/backend-api/conversation/${FIXTURE_CONVERSATION_ID}`
const LIVE_TIMEOUT_MS = 30_000

interface CdpTarget {
  id: string
  webSocketDebuggerUrl: string
}

interface CdpResponseReceived {
  requestId: string
  response: {
    url: string
    status: number
  }
}

interface CdpResponseBody {
  body: string
  base64Encoded?: boolean
}

interface DomSnapshot {
  url: string
  rawText: string
  heading: string
  listItems: string[]
  tableText: string
  preBlocks: string[]
}

test(
  "live saved ChatGPT fixture still matches server JSON, parser, and rendered DOM contracts",
  { skip: !LIVE_FIXTURE_ENABLED, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    const frozenPayload = JSON.parse(await readFile(new URL("../fixtures/chatgpt-live-fixture/conversation.json", import.meta.url), "utf8")) as unknown
    const frozenMessages = extractConversationMessages(frozenPayload)
    assert.equal(frozenMessages.length, 2)
    const expectedResponse = frozenMessages.at(-1)?.text
    assert.ok(expectedResponse)

    const endpoint = MCP_CONFIG.chatGpt.cdpEndpoint.replace(/\/$/, "")
    const target = await createTarget(endpoint)
    const session = await CdpSession.connect(target.webSocketDebuggerUrl)

    t.after(async () => {
      session.close()
      await closeTargetAndWait(endpoint, target.id).catch(() => undefined)
    })

    await session.call("Network.enable")
    await session.call("Page.enable")
    await session.call("Runtime.enable")

    const conversationResponse = session.waitForEvent<CdpResponseReceived>(
      "Network.responseReceived",
      (params) => params.response.url === FIXTURE_API_URL && params.response.status === 200,
      15_000
    )

    await session.call("Page.navigate", { url: FIXTURE_URL })
    const responseReceived = await conversationResponse
    const responseBody = await getResponseBodyWithRetry(session, responseReceived.requestId)
    const bodyText = responseBody.base64Encoded ? Buffer.from(responseBody.body, "base64").toString("utf8") : responseBody.body
    const livePayload = JSON.parse(bodyText) as unknown
    const liveRecord = asRecord(livePayload)
    assert.equal(liveRecord?.conversation_id, FIXTURE_CONVERSATION_ID)
    assert.equal(liveRecord?.title, "Live Fixture Response")

    const liveMessages = extractConversationMessages(livePayload)
    assert.deepEqual(liveMessages, frozenMessages, "live conversation branch must still match the frozen compatibility fixture")
    assert.equal(liveMessages.at(-1)?.text, expectedResponse)
    assert.ok(rawServerContentParts(livePayload).includes(expectedResponse), "live content.parts must contain the exact Markdown response")
    t.diagnostic("Live extracted conversation messages match the frozen parser fixture exactly")

    await waitForFixtureDom(session)
    const dom = await session.evaluate<DomSnapshot>(`(() => {
      const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      const element = messages.find((item) => (item.textContent ?? '').includes('LIVE_SUBAGENT_FIXTURE_BEGIN'));
      if (!element) return null;
      return {
        url: location.href,
        rawText: (element.textContent ?? '').trim(),
        heading: (element.querySelector('h2')?.textContent ?? '').trim(),
        listItems: Array.from(element.querySelectorAll('li')).map((item) => (item.textContent ?? '').trim()),
        tableText: (element.querySelector('table')?.textContent ?? '').trim(),
        preBlocks: Array.from(element.querySelectorAll('pre')).map((item) => (item.textContent ?? '').trim()),
      };
    })()`)

    assert.ok(dom, "saved fixture assistant message must render in the current ChatGPT DOM")
    assert.equal(dom.url, FIXTURE_URL)
    assert.ok(dom.rawText.includes("LIVE_SUBAGENT_FIXTURE_BEGIN"))
    assert.ok(dom.rawText.includes("LIVE_CTX_b9536da73e8e"))
    assert.equal(dom.heading, "Live Fixture")
    assert.deepEqual(dom.listItems, ["alpha", "beta"])
    assert.match(dom.tableText.replace(/\s+/g, ""), /keyvaluefixtureok/)
    assert.ok(dom.preBlocks.some((block) => block.includes("### Nested Markdown") && block.includes("LIVE_CTX_b9536da73e8e")))
    assert.ok(dom.preBlocks.some((block) => block.includes("const answer: number = 42;")))
    t.diagnostic("Current ChatGPT DOM still renders the saved fixture with recognizable heading/list/table/code structure")
  }
)

class CdpSession {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)))
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error(`Could not connect to Chrome CDP target ${url}`)), { once: true })
    })
    return new CdpSession(socket)
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(`Chrome Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result?.value as T
  }

  waitForEvent<T>(method: string, predicate: (params: T) => boolean, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const listener = (value: unknown) => {
        const params = value as T
        if (!predicate(params)) return
        clearTimeout(timer)
        this.listeners.get(method)?.delete(listener)
        resolve(params)
      }
      const timer = setTimeout(() => {
        this.listeners.get(method)?.delete(listener)
        reject(new Error(`Timed out waiting for Chrome CDP event ${method}`))
      }, timeoutMs)
      timer.unref()
      const listeners = this.listeners.get(method) ?? new Set<(params: unknown) => void>()
      listeners.add(listener)
      this.listeners.set(method, listeners)
    })
  }

  close(): void {
    this.socket.close()
  }

  private handleMessage(text: string): void {
    const message = JSON.parse(text) as {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (!message.method) return
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
  }
}

async function createTarget(endpoint: string): Promise<CdpTarget> {
  let response: Response
  try {
    response = await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })
  } catch (error) {
    throw new Error(`Live ChatGPT fixture test requires the authenticated Chrome CDP endpoint at ${endpoint}. Start it with npm run chatgpt.`, {
      cause: error,
    })
  }
  if (!response.ok) throw new Error(`Chrome CDP could not create a temporary fixture tab: HTTP ${response.status}`)
  return (await response.json()) as CdpTarget
}

async function getResponseBodyWithRetry(session: CdpSession, requestId: string): Promise<CdpResponseBody> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await session.call<CdpResponseBody>("Network.getResponseBody", { requestId })
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw new Error(`Could not read live ChatGPT conversation response body for request ${requestId}`, { cause: lastError })
}

async function closeTargetAndWait(endpoint: string, targetId: string): Promise<void> {
  await fetch(`${endpoint}/json/close/${targetId}`)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{ id?: string }>
    if (!targets.some((target) => target.id === targetId)) return
    await delay(50)
  }
  throw new Error(`Chrome CDP target ${targetId} did not close within 5000 ms`)
}

async function waitForFixtureDom(session: CdpSession): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const ready = await session.evaluate<boolean>(
      `Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).some((item) => (item.textContent ?? '').includes('LIVE_SUBAGENT_FIXTURE_BEGIN'))`
    )
    if (ready) return
    await delay(100)
  }
  throw new Error("Timed out waiting for the saved ChatGPT fixture to render")
}

function rawServerContentParts(value: unknown): string[] {
  const found: string[] = []
  const visited = new Set<object>()

  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return
    if (visited.has(current)) return
    visited.add(current)
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    const record = current as Record<string, unknown>
    const content = asRecord(record.content)
    if (content && Array.isArray(content.parts)) {
      for (const part of content.parts) if (typeof part === "string") found.push(part)
    }
    for (const nested of Object.values(record)) visit(nested)
  }

  visit(value)
  return found
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
