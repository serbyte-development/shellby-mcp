import { randomUUID } from "node:crypto"

import { launch } from "cloakbrowser"
import { Defuddle } from "defuddle/node"
import { parseHTML } from "linkedom"

import { tokenChunk } from "../../tokenizer.js"
import { MCP_CONFIG } from "../../config.js"
import { utf8Prefix } from "../../utils.js"

type WebsiteContentFormat = "markdown" | "clean_html" | "raw_html"

export interface WebOpenInput {
  url: string
  format: WebsiteContentFormat
  cursor?: string
  maxOutputTokens: number
  signal?: AbortSignal
}

export interface WebOpenResult extends Record<string, unknown> {
  url: string
  title: string
  format: WebsiteContentFormat
  content: string
  next_cursor?: string
  output_truncated?: true
  source_dropped?: true
  dropped_source_bytes?: number
}

interface RenderedWebPage {
  url: string
  title: string
  content: string
}

export interface WebPageOpenerOptions {
  renderPage?: (url: string, format: WebsiteContentFormat, signal?: AbortSignal) => Promise<RenderedWebPage>
  defaultOutputTokens?: number
  maxOutputTokens?: number
  documentByteLimit?: number
  documentTtlMs?: number
  documentLimit?: number
  now?: () => number
}

interface CachedDocument extends RenderedWebPage {
  id: string
  requestedUrl: string
  format: WebsiteContentFormat
  expiresAt: number
  droppedSourceBytes: number
}

interface CursorPayload {
  v: 1
  documentId: string
  offset: number
}

export class WebPageOpener {
  readonly defaultOutputTokens: number
  readonly maximumOutputTokens: number

  private readonly renderPage: NonNullable<WebPageOpenerOptions["renderPage"]>
  private readonly documentByteLimit: number
  private readonly documentTtlMs: number
  private readonly documentLimit: number
  private readonly now: () => number
  private readonly documents = new Map<string, CachedDocument>()

  constructor(options: WebPageOpenerOptions = {}) {
    this.defaultOutputTokens = options.defaultOutputTokens ?? MCP_CONFIG.web.defaultOutputTokens
    this.maximumOutputTokens = options.maxOutputTokens ?? MCP_CONFIG.web.maxOutputTokens
    this.documentByteLimit = options.documentByteLimit ?? MCP_CONFIG.web.documentByteLimit
    this.documentTtlMs = options.documentTtlMs ?? MCP_CONFIG.web.documentTtlMs
    this.documentLimit = options.documentLimit ?? MCP_CONFIG.web.documentLimit
    this.renderPage = options.renderPage ?? renderWithCloakBrowser
    this.now = options.now ?? Date.now
  }

  async open(input: WebOpenInput): Promise<WebOpenResult> {
    const requestedUrl = input.url
    const format = input.format
    const maxOutputTokens = input.maxOutputTokens
    this.removeExpiredDocuments()

    let document: CachedDocument
    let offset = 0

    if (input.cursor) {
      const cursor = decodeCursor(input.cursor)
      document = this.getDocument(cursor.documentId)
      if (requestedUrl !== document.requestedUrl && requestedUrl !== document.url) {
        throw new WebOpenError("invalid_cursor", "The cursor does not belong to the requested URL.")
      }
      if (format !== document.format) {
        throw new WebOpenError("invalid_cursor", `The cursor belongs to format ${document.format}; continue with the same format.`)
      }
      offset = cursor.offset
      if (offset < 0 || offset > document.content.length) {
        throw new WebOpenError("invalid_cursor", "The cursor offset is invalid.")
      }
    } else {
      const rendered = await this.renderPage(requestedUrl, format, input.signal)
      const finalUrl = normalizeWebUrl(rendered.url)
      const boundedContent = utf8Prefix(rendered.content, this.documentByteLimit)
      document = {
        id: randomUUID(),
        requestedUrl,
        url: finalUrl,
        title: rendered.title.trim(),
        format,
        content: boundedContent.value,
        expiresAt: this.now() + this.documentTtlMs,
        droppedSourceBytes: boundedContent.omittedBytes,
      }
      this.storeDocument(document)
    }

    const chunk = tokenChunk(document.content, offset, maxOutputTokens)
    const result: WebOpenResult = {
      url: document.url,
      title: document.title,
      format: document.format,
      content: chunk.value,
    }
    if (chunk.nextOffset < document.content.length) {
      result.next_cursor = encodeCursor({
        v: 1,
        documentId: document.id,
        offset: chunk.nextOffset,
      })
      result.output_truncated = true
    }
    if (document.droppedSourceBytes > 0) {
      result.source_dropped = true
      result.dropped_source_bytes = document.droppedSourceBytes
    }
    return result
  }

  private getDocument(id: string): CachedDocument {
    const document = this.documents.get(id)
    if (!document || document.expiresAt <= this.now()) {
      if (document) this.documents.delete(id)
      throw new WebOpenError("cursor_expired", "The cursor has expired. Open the page again without a cursor.")
    }

    this.documents.delete(id)
    this.documents.set(id, document)
    return document
  }

  private storeDocument(document: CachedDocument): void {
    this.documents.set(document.id, document)
    while (this.documents.size > this.documentLimit) {
      const oldestId = this.documents.keys().next().value as string | undefined
      if (!oldestId) break
      this.documents.delete(oldestId)
    }
  }

  private removeExpiredDocuments(): void {
    const now = this.now()
    for (const [id, document] of this.documents) {
      if (document.expiresAt <= now) this.documents.delete(id)
    }
  }
}

export class WebOpenError extends Error {
  constructor(
    readonly code: "invalid_url" | "invalid_cursor" | "cursor_expired" | "open_failed",
    message: string
  ) {
    super(message)
    this.name = "WebOpenError"
  }
}

async function renderWithCloakBrowser(url: string, format: WebsiteContentFormat, signal?: AbortSignal): Promise<RenderedWebPage> {
  if (signal?.aborted) {
    throw new WebOpenError("open_failed", "The web request was aborted.")
  }

  // Deliberately launch per fetch: web reads are infrequent, and startup cost is preferable to keeping a background Chromium process alive.
  const browser = await launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route("**/*", async (route) => {
      const resourceType = route.request().resourceType()
      if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
        await route.abort()
        return
      }
      await route.continue()
    })
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    await page.waitForTimeout(1_000)

    if (signal?.aborted) {
      throw new WebOpenError("open_failed", "The web request was aborted.")
    }

    const finalUrl = page.url()
    const browserTitle = await page.title()
    const html = await page.content()

    if (format === "raw_html") {
      return {
        url: finalUrl,
        title: browserTitle,
        content: html,
      }
    }

    const { document } = parseHTML(html)
    const parsed = await Defuddle(document as unknown as Document, finalUrl, {
      markdown: format === "markdown",
      useAsync: false,
    })

    return {
      url: finalUrl,
      title: parsed.title || browserTitle,
      content: parsed.content,
    }
  } catch (error) {
    if (error instanceof WebOpenError) throw error
    throw new WebOpenError("open_failed", error instanceof Error ? error.message : String(error))
  } finally {
    await browser.close()
  }
}

function normalizeWebUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebOpenError("invalid_url", "url must be a valid HTTP or HTTPS URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebOpenError("invalid_url", "url must use HTTP or HTTPS.")
  }
  return url.href
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>
    if (
      parsed.v !== 1 ||
      typeof parsed.documentId !== "string" ||
      parsed.documentId.length === 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor payload")
    }
    return parsed as CursorPayload
  } catch {
    throw new WebOpenError("invalid_cursor", "cursor is invalid.")
  }
}
