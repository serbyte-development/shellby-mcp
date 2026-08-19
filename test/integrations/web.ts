import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { WebPageOpener } from "../../src/tools/web/web-open.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("renders a real localhost page through the default web stack", { timeout: 20_000 }, async (t) => {
  const pageServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end("<!doctype html><html><head><title>Integration Test</title></head><body><main><h1>Hello MCP</h1><p>Real browser rendering works.</p></main></body></html>")
  })
  await new Promise<void>((resolve, reject) => {
    pageServer.once("error", reject)
    pageServer.listen(0, "127.0.0.1", resolve)
  })
  t.after(async () => {
    await new Promise<void>((resolve) => pageServer.close(() => resolve()))
  })

  const address = pageServer.address()
  assert.ok(address && typeof address !== "string")

  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "fetch-website-real-render-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "fetch_website",
    arguments: {
      url: `http://127.0.0.1:${address.port}/`,
      format: "markdown",
    },
  })

  assert.equal(result.isError, undefined)
  const content = result.structuredContent as { url: string; title: string; content: string }
  assert.equal(content.title, "Integration Test")
  assert.match(content.content, /Hello MCP/)
  assert.match(content.content, /Real browser rendering works\./)
})

test("continues one cached website across MCP client sessions", { timeout: 20_000 }, async (t) => {
  const expected = "🙂".repeat(200)
  let renders = 0
  const webPageOpener = new WebPageOpener({
    renderPage: async () => {
      renders += 1
      return {
        url: "https://example.com/final",
        title: "Example page",
        content: expected,
      }
    },
  })
  const running = await startMcpHttpServer({ port: 0, webPageOpener })
  t.after(() => running.close())

  const first = await connectClient(running.url, "fetch-website-client-1")
  const firstResult = await first.client.callTool({
    name: "fetch_website",
    arguments: {
      url: "https://example.com/start",
      format: "clean_html",
      max_output_tokens: 64,
    },
  })
  assert.equal(firstResult.isError, undefined)
  const firstContent = firstResult.structuredContent as { url: string; content: string; next_cursor?: string }
  assert.equal(firstContent.url, "https://example.com/final")
  assert.ok(firstContent.next_cursor)
  await first.client.close()

  const second = await connectClient(running.url, "fetch-website-client-2")
  t.after(() => second.client.close())
  const secondResult = await second.client.callTool({
    name: "fetch_website",
    arguments: {
      url: "https://example.com/start",
      format: "clean_html",
      cursor: firstContent.next_cursor,
      max_output_tokens: 256,
    },
  })
  assert.equal(secondResult.isError, undefined)
  const secondContent = secondResult.structuredContent as { content: string; next_cursor?: string }
  assert.equal(firstContent.content + secondContent.content, expected)
  assert.equal(secondContent.next_cursor, undefined)
  assert.equal(renders, 1)
})
