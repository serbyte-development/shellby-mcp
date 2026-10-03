import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { type BrowserContext, chromium } from "playwright-core"
import { MCP_CONFIG } from "../../src/config.js"
import { acquireWebResource } from "../../src/tools/web/web-acquisition.js"

// Exercise the attach-only path against disposable Chrome, never the managed profile or ChatGPT.
test("web fetches share a Chrome profile while owning only their own tabs", {
  skip: process.env.RUN_CDP_TESTS !== "1",
  timeout: 60_000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "shellby-web-cdp-"))
  let ownedContext: BrowserContext | undefined
  t.after(async () => {
    await ownedContext?.close()
    await rm(profile, { recursive: true, force: true })
  })
  const context = (ownedContext = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--remote-debugging-port=0", "--user-agent=Shellby-Web-Fixture"],
  }))
  const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]
  const previousEndpoint = MCP_CONFIG.chatGpt.cdpEndpoint
  MCP_CONFIG.chatGpt.cdpEndpoint = `http://127.0.0.1:${port}`
  t.after(() => {
    MCP_CONFIG.chatGpt.cdpEndpoint = previousEndpoint
  })

  const requests: Array<{ path: string; cookie: string | undefined }> = []
  let onHangingRequest: () => void = () => {}
  const hangingRequest = new Promise<void>((resolve) => {
    onHangingRequest = resolve
  })
  const server = createServer((request, response) => {
    const path = request.url ?? "/"
    requests.push({ path, cookie: request.headers.cookie })
    if (path === "/hang") {
      onHangingRequest()
      return
    }
    if (path === "/data") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"shared":"profile"}')
      return
    }
    if (path === "/large") {
      response.writeHead(200, { "content-type": "text/plain", "content-length": "100" })
      response.end("x".repeat(100))
      return
    }
    if (path === "/script.js") {
      response.writeHead(200, { "content-type": "text/javascript" })
      response.end(
        "document.querySelector('main').textContent += ' Script loaded ' + navigator.userAgent"
      )
      return
    }
    if (path === "/pixel.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" })
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
      return
    }
    if (path === "/font.woff") {
      response.writeHead(200, { "content-type": "font/woff" })
      response.end("fixture")
      return
    }
    response.writeHead(200, { "content-type": "text/html" })
    response.end(`<!doctype html><html><head><title>${path}</title>
      <style>@font-face {font-family: fixture;src:url('/font.woff')} main {font-family: fixture}</style>
      </head><body><main>${path}</main><img src="/pixel.svg"><script src="/script.js"></script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const base = `http://127.0.0.1:${address.port}`
  await context.addCookies([{ name: "web-fixture", value: "shared-session", url: base }])
  const keeper = context.pages()[0]!
  await keeper.goto(`${base}/keeper`)
  await keeper.evaluate("window.keepMe = 'original page'")
  const read = (path: string, signal?: AbortSignal, resourceByteLimit?: number) =>
    acquireWebResource({
      url: `${base}${path}`,
      format: "markdown",
      compact: false,
      headless: false,
      signal,
      resourceByteLimit,
    })

  await t.test(
    "concurrent fetches retain cookies and load scripts, images, and fonts",
    async () => {
      requests.length = 0
      const results = await Promise.all([read("/first"), read("/second")])
      assert.deepEqual(
        results.map((result) => result.title),
        ["/first", "/second"]
      )
      for (const result of results) {
        assert.ok(result.kind !== "image")
        assert.match(result.content, /Script loaded Shellby-Web-Fixture/u)
      }
      for (const path of ["/first", "/second", "/script.js", "/pixel.svg", "/font.woff"]) {
        assert.ok(
          requests.some((request) => request.path === path),
          `Resource must load: ${path}`
        )
      }
      assert.ok(
        requests
          .filter((request) => ["/first", "/second"].includes(request.path))
          .every((request) => request.cookie?.includes("web-fixture=shared-session"))
      )
      assert.deepEqual(context.pages(), [keeper])
      assert.equal(await keeper.evaluate("window.keepMe"), "original page")
    }
  )

  await t.test("raw resource reads and size-limit failures release their tabs", async () => {
    const result = await read("/data")
    assert.ok(result.kind !== "image")
    assert.equal(result.content, '{"shared":"profile"}')
    await assert.rejects(read("/large", undefined, 32), { code: "resource_too_large" })
    assert.deepEqual(context.pages(), [keeper])
  })

  await t.test("cancelling a pending navigation closes only its fetch tab", async () => {
    const controller = new AbortController()
    const pending = read("/hang", controller.signal)
    const rejected = assert.rejects(pending, { code: "open_failed" })
    await hangingRequest
    controller.abort()
    await rejected
    assert.deepEqual(context.pages(), [keeper])
    assert.equal(await keeper.evaluate("window.keepMe"), "original page")
  })
})
