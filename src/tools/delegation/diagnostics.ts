import type { ConsoleMessage, Frame, Page, Request, Response } from "playwright-core"
import type { AgentIdentity } from "../../agent/context.js"

const MAX_EVENTS = 20
const SNAPSHOT_TIMEOUT_MS = 1_000
const URL_IN_TEXT = /https?:\/\/[^\s<>"'\p{Cc}]+/gu
const URL_TRAILING_PUNCTUATION = /[),.;]+$/u
const CREDENTIAL_IN_TEXT =
  /\b(authorization|cookie|set-cookie|access_token|refresh_token|api[_-]?key)\s*[:=]\s*[^\r\n]+/giu

/** Failure-only stderr diagnostics for one operation, captured before its pages are cleaned up. */
export class DelegationDiagnostics {
  private readonly startedAt = Date.now()
  private readonly events: Array<Record<string, unknown>> = []
  private readonly pages = new Map<Page, { id: number; detach: () => void }>()
  private phase = "admission"
  private droppedEvents = 0
  private reported: boolean = false
  private submittedTurnId?: string
  private submittedMessageId?: string

  constructor(
    private readonly agentId: string,
    private readonly parentAgent: AgentIdentity | undefined
  ) {}

  stage(phase: string): void {
    this.phase = phase
    this.record("stage", {})
  }

  /** Attach before navigation. Keep bounded metadata, never request/response bodies or headers. */
  watch(page: Page): void {
    if (this.pages.has(page)) return
    const pageId = this.pages.size + 1
    const record = (event: string, data: Record<string, unknown>) =>
      this.record(event, { page: pageId, ...data })
    const onPageError = (error: Error) =>
      record("page.error", { message: diagnosticText(error.stack ?? error.message, 1_000) })
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === "error")
        record("console.error", { message: diagnosticText(message.text(), 1_000) })
    }
    const onRequestFailed = (request: Request) =>
      record("request.failed", {
        url: diagnosticUrl(request.url()),
        resource: request.resourceType(),
        error: diagnosticText(request.failure()?.errorText ?? "unknown", 500),
      })
    const onResponse = (response: Response) => {
      if (response.status() < 400) return
      record("http.error", {
        url: diagnosticUrl(response.url()),
        status: response.status(),
        resource: response.request().resourceType(),
      })
    }
    const onNavigation = (frame: Frame) => {
      if (frame === page.mainFrame()) record("page.navigated", { url: diagnosticUrl(frame.url()) })
    }
    const onCrash = () => record("page.crashed", {})
    const onClose = () => record("page.closed", {})
    page.on("pageerror", onPageError)
    page.on("console", onConsole)
    page.on("requestfailed", onRequestFailed)
    page.on("response", onResponse)
    page.on("framenavigated", onNavigation)
    page.on("crash", onCrash)
    page.on("close", onClose)
    this.pages.set(page, {
      id: pageId,
      detach: () => {
        page.off("pageerror", onPageError)
        page.off("console", onConsole)
        page.off("requestfailed", onRequestFailed)
        page.off("response", onResponse)
        page.off("framenavigated", onNavigation)
        page.off("crash", onCrash)
        page.off("close", onClose)
      },
    })
    record("page.attached", { url: diagnosticUrl(page.url()) })
  }

  submitted(turnId: string, messageId: string): void {
    this.submittedTurnId = turnId
    this.submittedMessageId = messageId
    this.record("submission.observed", {})
  }

  /** Emit once, before cleanup. Diagnostics must never replace the operation's original error. */
  async failure(error: unknown): Promise<void> {
    if (this.reported) return
    this.reported = true
    const elapsedMs = Date.now() - this.startedAt
    try {
      const pages = await Promise.all(
        [...this.pages].map(async ([page, { id }]) => ({
          page: id,
          url: diagnosticUrl(page.url()),
          ...(await pageState(page)),
        }))
      )
      console.warn(
        `[delegation] ${JSON.stringify({
          event: "delegation.failure",
          at: new Date().toISOString(),
          operation: "subagent_run",
          agent_id: this.agentId,
          caller: this.parentAgent
            ? [this.parentAgent.agent, this.parentAgent.taskSlug].filter(Boolean).join("/")
            : "unscoped",
          phase: this.phase,
          elapsed_ms: elapsedMs,
          submission_observed: this.submittedMessageId !== undefined,
          turn_id: this.submittedTurnId,
          submitted_message_id: this.submittedMessageId,
          error: errorDetails(error),
          pages,
          recent_events: this.events,
          dropped_events: this.droppedEvents,
        })}`
      )
    } catch {
      // A closed browser or a failed diagnostic sink must not change submission/cleanup behavior.
    }
  }

  dispose(): void {
    for (const { detach } of this.pages.values()) detach()
    this.pages.clear()
  }

  private record(event: string, details: Record<string, unknown>): void {
    this.events.push({
      elapsed_ms: Date.now() - this.startedAt,
      phase: this.phase,
      event,
      ...details,
    })
    if (this.events.length > MAX_EVENTS) {
      this.events.shift()
      this.droppedEvents += 1
    }
  }
}

/** Serializable DOM read shared with the CDP probe; omit drafts and conversation text. */
export function readChatGptPageState() {
  // Keep callbacks inline: named local functions gain tsx's __name helper, unavailable in Chrome.
  const visibleElements = [
    ...document.querySelectorAll(
      '#prompt-textarea, [data-testid="prompt-textarea"], button, a[href*="/auth/login"], a[href*="/auth/signin"], [data-testid="modal-conversation-history-rate-limit"]'
    ),
  ].filter(
    (element) =>
      element instanceof HTMLElement &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden"
  )
  const retry = visibleElements.find(
    (element) =>
      element.matches("button") && element.textContent?.trim().toLowerCase() === "try again"
  )
  const composerVisible = visibleElements.some((element) =>
    element.matches('#prompt-textarea, [data-testid="prompt-textarea"]')
  )
  return {
    ready_state: document.readyState,
    visibility_state: document.visibilityState,
    composer_visible: composerVisible,
    try_again_visible: retry !== undefined,
    login_visible: visibleElements.some((element) =>
      element.matches('a[href*="/auth/login"], a[href*="/auth/signin"]')
    ),
    rate_limit_visible: visibleElements.some((element) =>
      element.matches('[data-testid="modal-conversation-history-rate-limit"]')
    ),
    user_messages: document.querySelectorAll('[data-message-author-role="user"]').length,
    assistant_messages: document.querySelectorAll('[data-message-author-role="assistant"]').length,
  }
}

async function pageState(page: Page): Promise<Record<string, unknown>> {
  if (page.isClosed()) return { closed: true }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      page.evaluate(readChatGptPageState),
      new Promise<Record<string, unknown>>((resolve) => {
        timer = setTimeout(
          () => resolve({ unavailable: "snapshot timed out" }),
          SNAPSHOT_TIMEOUT_MS
        )
      }),
    ])
  } catch (error) {
    return {
      unavailable: diagnosticText(error instanceof Error ? error.message : String(error), 300),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: diagnosticText(String(error), 1_000) }
  return {
    name: error.name,
    code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    message: diagnosticText(error.message, 2_000),
    stack: error.stack ? diagnosticText(error.stack, 2_000) : undefined,
    cause: error.cause instanceof Error ? diagnosticText(error.cause.message, 1_000) : undefined,
  }
}

function diagnosticText(value: string, limit: number): string {
  return value
    .replace(URL_IN_TEXT, (url) => diagnosticUrl(url.replace(URL_TRAILING_PUNCTUATION, "")))
    .replace(CREDENTIAL_IN_TEXT, "$1=<redacted>")
    .slice(0, limit)
}

function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === "about:") return "about:blank"
    if (url.protocol !== "https:" && url.protocol !== "http:") return "<non-http-url>"
    return `${url.origin}${url.pathname}`.slice(0, 500)
  } catch {
    return "<invalid-url>"
  }
}
