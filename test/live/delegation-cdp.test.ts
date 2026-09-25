import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { type Browser, chromium } from "playwright-core"

import {
  createBackgroundPage,
  enterPrompt,
  findComposer,
  submitComposer,
} from "../../src/tools/delegation/chatgpt-browser.js"
import { startConversation } from "../../src/tools/delegation/conversation.js"
import { DelegationDiagnostics } from "../../src/tools/delegation/diagnostics.js"
import { observeAssistantResponse } from "../../src/tools/delegation/response-observer.js"

// Opt in: starts disposable Chrome with local fixtures, never the managed profile
// or real ChatGPT. CHROME_PATH can select another installed Chromium executable.
test("delegation contracts over a real Chrome CDP connection", {
  skip: process.env.RUN_CDP_TESTS !== "1",
  timeout: 90_000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "shellby-cdp-test-"))
  const child = spawn(
    process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--host-resolver-rules=MAP chatgpt.com 127.0.0.1",
      "--no-proxy-server",
      "--ignore-certificate-errors",
      "--disable-background-networking",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" }
  )
  let browser: Browser | undefined
  let launchError: Error | undefined
  child.on("error", (error) => {
    launchError = error
  })
  t.after(async () => {
    await browser?.close()
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
      killTimer.unref()
      child.kill("SIGTERM")
      await exited
      clearTimeout(killTimer)
    }
    await rm(profile, { recursive: true, force: true })
  })
  let port: string | undefined
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (launchError) throw launchError
    port = await readFile(join(profile, "DevToolsActivePort"), "utf8")
      .then((value) => value.split("\n")[0])
      .catch(() => undefined)
    if (port) break
    await delay(100)
  }
  assert.ok(port, "Disposable Chrome must expose its debugging port")
  const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  browser = connected
  const context = connected.contexts()[0]!
  t.diagnostic(`Chrome ${connected.version()}`)

  await t.test("concurrent background targets bind to distinct pages", async () => {
    const pages = await Promise.all(
      Array.from({ length: 3 }, () => createBackgroundPage(connected, context))
    )
    assert.equal(new Set(pages).size, 3)
    assert.ok(pages.every((page) => page.url() === "about:blank"))
    await Promise.all(pages.map((page) => page.close()))
  })

  await context.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: conversationFixture(route.request().url()) })
  )
  for (const mode of ["fresh", "resume", "popup", "noopener", "same-page"] as const) {
    await t.test(`startConversation handles ${mode}`, async () => {
      const diagnostics = new DelegationDiagnostics("subagent_run", `cdp-${mode}`, undefined)
      const pagesBefore = context.pages().length
      try {
        const page = await startConversation(
          connected,
          context,
          mode === "resume"
            ? { kind: "resume", url: "https://chatgpt.com/c/saved-conversation" }
            : { kind: "new", memory: false, ...(mode === "fresh" ? {} : { conversationId: mode }) },
          diagnostics,
          AbortSignal.timeout(10_000)
        )
        assert.equal(context.pages().length, pagesBefore + 1, "Startup owns only its returned page")
        const expectedPath =
          mode === "fresh" ? "/" : `/c/${mode === "resume" ? "saved-conversation" : `fork-${mode}`}`
        assert.equal(new URL(page.url()).pathname, expectedPath)
        const composer = await findComposer(page)
        await enterPrompt(page, composer, "Exact prompt: café 中文 🐚")
        await submitComposer(page, composer)
        assert.equal(await page.locator("#submitted").textContent(), "Exact prompt: café 中文 🐚")
        await page.close()
      } finally {
        diagnostics.dispose()
      }
    })
  }

  await t.test(
    "HTTP streaming preserves Unicode before the connection finishes",
    async (streamTest) => {
      const answer = "Exact streamed response: café 中文 🐚"
      let activeResponse: ServerResponse | undefined
      // chatgpt.com is HSTS-preloaded. Use local TLS; Chrome's certificate exception
      // applies only to this disposable process and profile.
      const keyPath = join(profile, "fixture-key.pem")
      const certPath = join(profile, "fixture-cert.pem")
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=chatgpt.com",
          "-keyout",
          keyPath,
          "-out",
          certPath,
        ],
        { stdio: "ignore" }
      )
      const server = createServer(
        { key: await readFile(keyPath), cert: await readFile(certPath) },
        (request, response) => {
          if (request.url !== "/backend-api/f/conversation") {
            response.writeHead(200, { "Content-Type": "text/html" })
            response.end(`<textarea id="prompt-textarea"></textarea>
              <button data-testid="send-button" onclick="fetch('/backend-api/f/conversation', {
                method: 'POST',
                body: JSON.stringify({action: 'next', messages: [{
                  id: 'cdp-user', author: {role: 'user'},
                  content: {parts: [document.querySelector('#prompt-textarea').value]}
                }]})
              }).then(response => response.text())">Send</button>`)
            return
          }
          activeResponse = response
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" })
          response.write(": ready\n\n")
          const bytes = Buffer.from(completedStream(answer))
          const split = bytes.indexOf(Buffer.from("🐚")) + 2
          // Wait for the observer to enable streaming, then split an actual UTF-8
          // code point across two network chunks. Leave HTTP open to exclude fallback.
          void delay(300)
            .then(() => {
              response.write(bytes.subarray(0, split))
              return delay(300)
            })
            .then(() => response.write(bytes.subarray(split)))
        }
      )
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      streamTest.after(() => {
        activeResponse?.end()
        server.closeAllConnections()
        server.close()
      })
      const address = server.address()
      assert.ok(address && typeof address !== "string")
      const page = await createBackgroundPage(connected, context)
      streamTest.after(() => page.close())
      await page.goto(`https://chatgpt.com:${address.port}/`)
      const composer = await findComposer(page)
      await enterPrompt(page, composer, "Read the local streamed response")
      const submitted: string[] = []
      const observation = await observeAssistantResponse(page, {
        onSubmitted: (id) => submitted.push(id),
      })
      streamTest.after(() => observation.dispose())
      await observation.submit(() => submitComposer(page, composer))
      const result = await Promise.race([
        observation.response,
        delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error("CDP stream did not complete before HTTP closed")
        }),
      ])
      assert.equal(activeResponse?.writableEnded, false)
      assert.deepEqual(submitted, ["cdp-user"])
      assert.equal(result.text, answer)
    }
  )

  await t.test("disconnect leaves Chrome available for reconnection", async () => {
    await connected.close()
    const reconnected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    browser = reconnected
    assert.ok(reconnected.contexts()[0]?.pages().length)
  })
})

function conversationFixture(url: string): string {
  const mode = new URL(url).pathname.split("/").at(-1)
  const target = `/c/fork-${mode}`
  const branchAction =
    mode === "same-page"
      ? `location.href = '${target}'`
      : `window.open('${target}', '_blank', '${mode === "noopener" ? "noopener,noreferrer" : ""}')`
  return `<!doctype html><html><body>
    <section data-testid="conversation-turn-1">
      <div data-message-author-role="assistant">Source answer</div>
      <button aria-label="More actions" onclick="document.querySelector('#branch-menu').hidden=false">More</button>
    </section>
    <button id="branch-menu" role="menuitem" hidden
      onkeydown="if(event.key==='ArrowRight') document.querySelector('#branch').hidden=false">Open new branch</button>
    <button id="branch" role="menuitem" hidden onclick="${branchAction}">Branch in new Chat</button>
    <textarea id="prompt-textarea"></textarea>
    <button data-testid="send-button"
      onclick="document.querySelector('#submitted').textContent=document.querySelector('#prompt-textarea').value">Send</button>
    <div id="submitted"></div>
  </body></html>`
}

function completedStream(answer: string): string {
  return [
    { type: "input_message", input_message: { id: "cdp-user", author: { role: "user" } } },
    {
      v: {
        message: {
          author: { role: "assistant" },
          content: { parts: [answer] },
          status: "finished_successfully",
          end_turn: true,
          recipient: "all",
        },
      },
    },
    { type: "message_stream_complete" },
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .join("")
}
