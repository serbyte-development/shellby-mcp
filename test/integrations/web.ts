import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { WebPageOpener } from "../../src/tools/web/web-open.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("renders a real localhost page through the default web stack", { timeout: 60_000 }, async (t) => {
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
      format: "html",
      compact: false,
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
      format: "html",
      compact: false,
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

test("compact only removes explicit token-heavy markup", { timeout: 60_000 }, async (t) => {
  const pageServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <html class="root-class">
        <head><title>Full Page</title><style>.paint { color: blue; }</style><script>window.headNoise = true</script></head>
        <body class="page" data-page="reviews" style="margin:0">
          <nav>Site Navigation</nav>
          <main class="paint" data-controller="reviews">
            <h1>Customer Reviews</h1>
            <article>
              <p>Customer review body survives.</p>
              <div class="review-reply">
                <strong>Reply from business</strong>
                <div class="card-text">Owner reply should survive.</div>
              </div>
            </article>
            <aside>Sidebar details should survive.</aside>
            <table><tr><th>Service</th><th>Warranty</th></tr><tr><td>Painting</td><td>1 year</td></tr></table>
            <img alt="House" src="data:image/png;base64,AAAA" srcset="one.jpg 1x, two.jpg 2x" sizes="100vw" width="800" height="600" loading="lazy">
            <button onclick="doThing()">Useful button</button>
            <svg viewBox="0 0 10 10"><path d="M0 0h10v10z"></path></svg>
            <div aria-hidden="true">ARIA hidden detail</div>
            <div hidden>Hidden detail</div>
            <div style="display:none">Inline hidden detail</div>
            <script>window.bodyNoise = true</script>
          </main>
          <footer>Site Footer</footer>
        </body>
      </html>`)
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
  const url = `http://127.0.0.1:${address.port}/reviews`
  const opener = new WebPageOpener()

  const fullHtml = await opener.open({
    url,
    format: "html",
    compact: false,
    maxOutputTokens: opener.maximumOutputTokens,
  })
  assert.match(fullHtml.content, /<head>/)
  assert.match(fullHtml.content, /Site Navigation/)
  assert.match(fullHtml.content, /Site Footer/)
  assert.match(fullHtml.content, /class="card-text"/)
  assert.match(fullHtml.content, /srcset=/)
  assert.match(fullHtml.content, /data:image\/png;base64,AAAA/)
  assert.match(fullHtml.content, /<svg/)
  assert.match(fullHtml.content, /window\.bodyNoise/)

  const compactHtml = await opener.open({
    url,
    format: "html",
    compact: true,
    maxOutputTokens: opener.maximumOutputTokens,
  })
  assert.doesNotMatch(compactHtml.content, /<head/)
  assert.doesNotMatch(compactHtml.content, /<nav/)
  assert.doesNotMatch(compactHtml.content, /<footer/)
  assert.doesNotMatch(compactHtml.content, /<script/)
  assert.doesNotMatch(compactHtml.content, /<style/)
  assert.doesNotMatch(compactHtml.content, /<svg/)
  assert.doesNotMatch(compactHtml.content, /class=/)
  assert.doesNotMatch(compactHtml.content, /style=/)
  assert.doesNotMatch(compactHtml.content, /data-controller=/)
  assert.doesNotMatch(compactHtml.content, /onclick=/)
  assert.doesNotMatch(compactHtml.content, /srcset=/)
  assert.doesNotMatch(compactHtml.content, /sizes=/)
  assert.doesNotMatch(compactHtml.content, /width=/)
  assert.doesNotMatch(compactHtml.content, /height=/)
  assert.doesNotMatch(compactHtml.content, /loading=/)
  assert.doesNotMatch(compactHtml.content, /data:image/)
  assert.doesNotMatch(compactHtml.content, /ARIA hidden detail|Hidden detail|Inline hidden detail/)
  assert.match(compactHtml.content, /Owner reply should survive\./)
  assert.match(compactHtml.content, /Sidebar details should survive\./)
  assert.match(compactHtml.content, /Useful button/)
  assert.match(compactHtml.content, /<table>/)

  const compactMarkdown = await opener.open({
    url,
    format: "markdown",
    compact: true,
    maxOutputTokens: opener.maximumOutputTokens,
  })
  assert.match(compactMarkdown.content, /Owner reply should survive\./)
  assert.match(compactMarkdown.content, /Sidebar details should survive\./)
  assert.match(compactMarkdown.content, /\| Service\s+\| Warranty\s+\|/)
  assert.doesNotMatch(compactMarkdown.content, /Site Navigation|Site Footer|ARIA hidden detail|Hidden detail|Inline hidden detail/)
})
