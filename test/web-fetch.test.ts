import assert from "node:assert/strict"
import test from "node:test"

import { countTokens } from "../src/tokenizer.js"
import { WebOpenError, WebPageOpener } from "../src/tools/web/web-open.js"

test("paginates fetched content without reopening the page", async () => {
  const expected = "🙂".repeat(1_500)
  let renders = 0
  const opener = new WebPageOpener({
    defaultOutputTokens: 256,
    renderPage: async () => {
      renders += 1
      return {
        url: "https://example.com/final",
        title: "Example",
        content: expected,
      }
    },
  })

  let result = await opener.open({ url: "https://example.com/start" })
  let content = result.content
  assert.ok(countTokens(result.content) <= 256)
  assert.equal(result.url, "https://example.com/final")
  assert.equal(result.format, "markdown")
  assert.equal(result.output_truncated, true)

  while (result.next_cursor) {
    result = await opener.open({
      url: "https://example.com/start",
      cursor: result.next_cursor,
    })
    content += result.content
  }

  assert.equal(content, expected)
  assert.equal(renders, 1)
  assert.equal(result.output_truncated, undefined)
})

test("forwards the requested format and requires it for cursor continuation", async () => {
  const formats: string[] = []
  const opener = new WebPageOpener({
    defaultOutputTokens: 256,
    renderPage: async (_url, format) => {
      formats.push(format)
      return {
        url: "https://example.com/",
        title: "Formatted page",
        content: "🙂".repeat(300),
      }
    },
  })

  const first = await opener.open({
    url: "https://example.com",
    format: "clean_html",
  })
  assert.equal(first.format, "clean_html")
  assert.deepEqual(formats, ["clean_html"])
  assert.equal(first.output_truncated, true)
  assert.ok(first.next_cursor)

  const second = await opener.open({
    url: "https://example.com",
    format: "clean_html",
    cursor: first.next_cursor,
  })
  assert.equal(second.format, "clean_html")
  assert.equal(formats.length, 1)

  await assert.rejects(
    opener.open({
      url: "https://example.com",
      format: "raw_html",
      cursor: first.next_cursor,
    }),
    (error: unknown) => error instanceof WebOpenError && error.code === "invalid_cursor"
  )
})

test("accepts the final redirected URL for cursor reads", async () => {
  const opener = new WebPageOpener({
    defaultOutputTokens: 256,
    renderPage: async () => ({
      url: "https://example.com/final",
      title: "Redirected",
      content: "🙂".repeat(300),
    }),
  })

  const first = await opener.open({ url: "https://example.com/start" })
  assert.equal(first.output_truncated, true)
  assert.ok(first.next_cursor)
  const second = await opener.open({
    url: first.url,
    cursor: first.next_cursor,
  })
  assert.equal(first.content + second.content, "🙂".repeat(300))
})

test("rejects invalid and expired cursors", async () => {
  let now = 1_000
  const opener = new WebPageOpener({
    defaultOutputTokens: 256,
    documentTtlMs: 100,
    now: () => now,
    renderPage: async () => ({
      url: "https://example.com/",
      title: "Example",
      content: "🙂".repeat(300),
    }),
  })

  await assert.rejects(
    opener.open({ url: "https://example.com", cursor: "not-a-cursor" }),
    (error: unknown) => error instanceof WebOpenError && error.code === "invalid_cursor"
  )

  const first = await opener.open({ url: "https://example.com" })
  assert.ok(first.next_cursor)
  now += 101

  await assert.rejects(
    opener.open({
      url: "https://example.com",
      cursor: first.next_cursor,
    }),
    (error: unknown) => error instanceof WebOpenError && error.code === "cursor_expired"
  )
})

test("bounds cached extracted documents and reports dropped source bytes", async () => {
  const opener = new WebPageOpener({
    defaultOutputTokens: 64,
    documentByteLimit: 300,
    renderPage: async () => ({
      url: "https://example.com/",
      title: "Large page",
      content: "🙂".repeat(500),
    }),
  })

  const first = await opener.open({ url: "https://example.com" })
  assert.equal(first.content, "🙂".repeat(64))
  assert.equal(first.output_truncated, true)
  assert.equal(first.source_dropped, true)
  assert.equal(first.dropped_source_bytes, 1_700)
  assert.ok(first.next_cursor)

  const second = await opener.open({
    url: "https://example.com",
    cursor: first.next_cursor,
  })
  assert.equal(second.content, "🙂".repeat(11))
  assert.equal(second.output_truncated, undefined)
  assert.equal(second.source_dropped, true)
  assert.equal(second.dropped_source_bytes, 1_700)
  assert.equal(second.next_cursor, undefined)
})
