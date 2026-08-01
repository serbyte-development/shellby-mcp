import { randomUUID } from "node:crypto";

import { launch } from "cloakbrowser";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

export const DEFAULT_WEB_OUTPUT_BYTES = 8 * 1024;
export const MAX_WEB_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_WEB_DOCUMENT_BYTES = 2 * 1024 * 1024;

const DEFAULT_DOCUMENT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_DOCUMENT_LIMIT = 20;

export interface WebOpenInput {
  url: string;
  cursor?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface WebOpenResult extends Record<string, unknown> {
  url: string;
  title: string;
  content: string;
  next_cursor?: string;
  source_truncated?: true;
}

export interface RenderedWebPage {
  url: string;
  title: string;
  content: string;
}

export interface WebPageOpenerOptions {
  renderPage?: (url: string, signal?: AbortSignal) => Promise<RenderedWebPage>;
  defaultOutputBytes?: number;
  maxOutputBytes?: number;
  documentByteLimit?: number;
  documentTtlMs?: number;
  documentLimit?: number;
  now?: () => number;
}

interface CachedDocument extends RenderedWebPage {
  id: string;
  requestedUrl: string;
  expiresAt: number;
  sourceTruncated: boolean;
}

interface CursorPayload {
  v: 1;
  documentId: string;
  offset: number;
}

export class WebPageOpener {
  readonly defaultOutputBytes: number;
  readonly maximumOutputBytes: number;

  private readonly renderPage: NonNullable<WebPageOpenerOptions["renderPage"]>;
  private readonly documentByteLimit: number;
  private readonly documentTtlMs: number;
  private readonly documentLimit: number;
  private readonly now: () => number;
  private readonly documents = new Map<string, CachedDocument>();

  constructor(options: WebPageOpenerOptions = {}) {
    this.defaultOutputBytes = positiveInteger(
      options.defaultOutputBytes,
      DEFAULT_WEB_OUTPUT_BYTES,
    );
    this.maximumOutputBytes = positiveInteger(
      options.maxOutputBytes,
      MAX_WEB_OUTPUT_BYTES,
    );
    if (this.defaultOutputBytes > this.maximumOutputBytes) {
      throw new Error("defaultOutputBytes cannot exceed maxOutputBytes.");
    }

    this.documentByteLimit = positiveInteger(
      options.documentByteLimit,
      DEFAULT_WEB_DOCUMENT_BYTES,
    );

    this.documentTtlMs = positiveInteger(
      options.documentTtlMs,
      DEFAULT_DOCUMENT_TTL_MS,
    );
    this.documentLimit = positiveInteger(
      options.documentLimit,
      DEFAULT_DOCUMENT_LIMIT,
    );
    this.renderPage = options.renderPage ?? renderWithCloakBrowser;
    this.now = options.now ?? Date.now;
  }

  async open(input: WebOpenInput): Promise<WebOpenResult> {
    const requestedUrl = normalizeWebUrl(input.url);
    const maxOutputBytes = this.resolveOutputBytes(input.maxOutputBytes);
    this.removeExpiredDocuments();

    let document: CachedDocument;
    let offset = 0;

    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      document = this.getDocument(cursor.documentId);
      if (
        requestedUrl !== document.requestedUrl &&
        requestedUrl !== document.url
      ) {
        throw new WebOpenError(
          "invalid_cursor",
          "The cursor does not belong to the requested URL.",
        );
      }
      offset = cursor.offset;
      if (offset < 0 || offset > document.content.length) {
        throw new WebOpenError(
          "invalid_cursor",
          "The cursor offset is invalid.",
        );
      }
    } else {
      const rendered = await this.renderPage(requestedUrl, input.signal);
      const finalUrl = normalizeWebUrl(rendered.url);
      const boundedContent = utf8Prefix(
        rendered.content,
        this.documentByteLimit,
      );
      document = {
        id: randomUUID(),
        requestedUrl,
        url: finalUrl,
        title: rendered.title.trim(),
        content: boundedContent.value,
        expiresAt: this.now() + this.documentTtlMs,
        sourceTruncated: boundedContent.omittedBytes > 0,
      };
      this.storeDocument(document);
    }

    const chunk = utf8Chunk(document.content, offset, maxOutputBytes);
    const result: WebOpenResult = {
      url: document.url,
      title: document.title,
      content: chunk.value,
    };
    if (chunk.nextOffset < document.content.length) {
      result.next_cursor = encodeCursor({
        v: 1,
        documentId: document.id,
        offset: chunk.nextOffset,
      });
    }
    if (document.sourceTruncated) result.source_truncated = true;
    return result;
  }

  private resolveOutputBytes(value: number | undefined): number {
    const resolved = value ?? this.defaultOutputBytes;
    if (
      !Number.isSafeInteger(resolved) ||
      resolved < 256 ||
      resolved > this.maximumOutputBytes
    ) {
      throw new WebOpenError(
        "invalid_output_limit",
        `max_output_bytes must be an integer from 256 to ${this.maximumOutputBytes}.`,
      );
    }
    return resolved;
  }

  private getDocument(id: string): CachedDocument {
    const document = this.documents.get(id);
    if (!document || document.expiresAt <= this.now()) {
      if (document) this.documents.delete(id);
      throw new WebOpenError(
        "cursor_expired",
        "The cursor has expired. Open the page again without a cursor.",
      );
    }

    this.documents.delete(id);
    this.documents.set(id, document);
    return document;
  }

  private storeDocument(document: CachedDocument): void {
    this.documents.set(document.id, document);
    while (this.documents.size > this.documentLimit) {
      const oldestId = this.documents.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.documents.delete(oldestId);
    }
  }

  private removeExpiredDocuments(): void {
    const now = this.now();
    for (const [id, document] of this.documents) {
      if (document.expiresAt <= now) this.documents.delete(id);
    }
  }
}

export class WebOpenError extends Error {
  constructor(
    readonly code:
      | "invalid_url"
      | "invalid_cursor"
      | "cursor_expired"
      | "invalid_output_limit"
      | "open_failed",
    message: string,
  ) {
    super(message);
    this.name = "WebOpenError";
  }
}

async function renderWithCloakBrowser(
  url: string,
  signal?: AbortSignal,
): Promise<RenderedWebPage> {
  if (signal?.aborted) {
    throw new WebOpenError("open_failed", "The web request was aborted.");
  }

  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(1_000);

    if (signal?.aborted) {
      throw new WebOpenError("open_failed", "The web request was aborted.");
    }

    const finalUrl = page.url();
    const browserTitle = await page.title();
    const html = await page.content();
    const { document } = parseHTML(html);
    const parsed = await Defuddle(document as unknown as Document, finalUrl, {
      markdown: true,
      useAsync: false,
    });

    return {
      url: finalUrl,
      title: parsed.title || browserTitle,
      content: parsed.content,
    };
  } catch (error) {
    if (error instanceof WebOpenError) throw error;
    throw new WebOpenError(
      "open_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await browser.close();
  }
}

function normalizeWebUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebOpenError(
      "invalid_url",
      "url must be a valid HTTP or HTTPS URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebOpenError("invalid_url", "url must use HTTP or HTTPS.");
  }
  return url.href;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.documentId !== "string" ||
      parsed.documentId.length === 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed as CursorPayload;
  } catch {
    throw new WebOpenError("invalid_cursor", "cursor is invalid.");
  }
}

function utf8Chunk(
  value: string,
  start: number,
  maxBytes: number,
): { value: string; nextOffset: number } {
  let offset = start;
  let bytes = 0;

  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes = Buffer.byteLength(
      value.slice(offset, offset + codeUnits),
      "utf8",
    );
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    offset += codeUnits;
  }

  return {
    value: value.slice(start, offset),
    nextOffset: offset,
  };
}

function utf8Prefix(
  value: string,
  maxBytes: number,
): { value: string; omittedBytes: number } {
  const chunk = utf8Chunk(value, 0, maxBytes);
  return {
    value: chunk.value,
    omittedBytes: Buffer.byteLength(value.slice(chunk.nextOffset), "utf8"),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Expected a positive integer.");
  }
  return value;
}
