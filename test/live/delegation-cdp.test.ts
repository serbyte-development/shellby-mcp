import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import type { RequestListener, ServerResponse } from "node:http"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { type Browser, chromium } from "playwright-core"
import { MCP_CONFIG } from "../../src/config.js"
import {
  createBackgroundPage,
  enterPrompt,
  findComposer,
  submitComposer,
} from "../../src/tools/delegation/chatgpt-browser.js"
import { prepareConversationTab } from "../../src/tools/delegation/conversation-tab.js"
import { DelegationDiagnostics } from "../../src/tools/delegation/diagnostics.js"
import { observeAssistantResponse } from "../../src/tools/delegation/response-observer.js"
import { createSubagents } from "../../src/tools/delegation/subagents.js"
import { getAgentResponse, sendAgentMessage } from "../fixtures/subagents.js"

// Opt in: starts disposable Chrome with local fixtures, never the managed profile
// or real ChatGPT. CHROME_PATH can select another installed Chromium executable.
test("delegation contracts over a real Chrome CDP connection", {
  skip: process.env.RUN_CDP_TESTS !== "1",
  timeout: 90_000,
}, async (t) => {
  const previousProjectUrl = MCP_CONFIG.chatGpt.projectUrl
  MCP_CONFIG.chatGpt.projectUrl = "https://chatgpt.com/g/g-p-cdp-fixture/project"
  t.after(() => {
    MCP_CONFIG.chatGpt.projectUrl = previousProjectUrl
  })
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
  for (const mode of [
    "fresh",
    "resume",
    "popup",
    "noopener",
    "same-page",
    "redirect-popup",
    "moving-menu",
  ] as const) {
    await t.test(`prepareConversationTab handles ${mode}`, async () => {
      const diagnostics = new DelegationDiagnostics(`cdp-${mode}`, undefined)
      const pagesBefore = context.pages().length
      const startSource =
        mode === "popup"
          ? "https://chatgpt.com/c/popup"
          : mode === "same-page"
            ? "https://chatgpt.com/g/g-p-fixture/c/same-page"
            : mode
      try {
        const page = await prepareConversationTab(
          connected,
          context,
          mode === "resume"
            ? { kind: "resume", url: "https://chatgpt.com/c/saved-conversation" }
            : { kind: "new", ...(mode === "fresh" ? {} : { startSource }) },
          diagnostics,
          AbortSignal.timeout(10_000)
        )
        assert.equal(context.pages().length, pagesBefore + 1, "Startup owns only its returned page")
        const expectedPath =
          mode === "fresh"
            ? "/g/g-p-cdp-fixture/project"
            : mode === "redirect-popup"
              ? "/c/WEB:fork-redirect-popup"
              : mode === "moving-menu"
                ? "/c/local-chatgpt%3Apending-moving-menu"
                : `/c/${mode === "resume" ? "saved-conversation" : `fork-${mode}`}`
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
      const origin = await startHttpsFixture(streamTest, profile, (request, response) => {
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
      })
      const page = await createBackgroundPage(connected, context)
      streamTest.after(() => page.close())
      await page.goto(origin)
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

  await t.test("saved-agent lifecycle over CDP", async (lifecycleTest) => {
    const savedConfig = {
      stateDir: MCP_CONFIG.stateDir,
      projectUrl: MCP_CONFIG.chatGpt.projectUrl,
      cdpEndpoint: MCP_CONFIG.chatGpt.cdpEndpoint,
      maxDelegatedAgents: MCP_CONFIG.chatGpt.maxDelegatedAgents,
    }
    let service: ReturnType<typeof createSubagents> | undefined
    lifecycleTest.after(async () => {
      await service?.dispose()
      MCP_CONFIG.stateDir = savedConfig.stateDir
      Object.assign(MCP_CONFIG.chatGpt, {
        projectUrl: savedConfig.projectUrl,
        cdpEndpoint: savedConfig.cdpEndpoint,
        maxDelegatedAgents: savedConfig.maxDelegatedAgents,
      })
    })

    const users: Array<{
      id: string
      author: { role: string }
      content: { parts: string[] }
    }> = []
    const streams = new Map<number, ServerResponse>()
    const savedAnswers = new Map<number, string>()
    let historyReads = 0
    const origin = await startHttpsFixture(lifecycleTest, profile, (request, response) => {
      if (request.url === "/backend-api/f/conversation" && request.method === "POST") {
        let body = ""
        request.on("data", (chunk) => {
          body += chunk
        })
        request.on("end", () => {
          const user = JSON.parse(body).messages[0]
          users.push(user)
          streams.set(users.length, response)
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
          })
          response.write(
            `data: ${JSON.stringify({ v: { message: user }, conversation_id: "cdp-conversation" })}\n\n`
          )
        })
        return
      }
      if (request.url === "/backend-api/conversations/cdp-conversation") {
        historyReads += 1
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify({
            messages: users.flatMap((user, index) => {
              const answer = savedAnswers.get(index + 1)
              return answer === undefined ? [user] : [user, completedMessage(answer)]
            }),
          })
        )
        return
      }
      response.writeHead(200, { "Content-Type": "text/html" })
      response.end(`<textarea id="prompt-textarea"></textarea>
        <button data-testid="send-button" onclick="
          history.replaceState({}, '', '/c/cdp-conversation');
          fetch('/backend-api/f/conversation', {
            method: 'POST',
            body: JSON.stringify({action: 'next', messages: [{
              id: crypto.randomUUID(), author: {role: 'user'},
              content: {parts: [document.querySelector('#prompt-textarea').value]}
            }]})
          }).then(response => response.text())">Send</button>
        <script>
          if (location.pathname.startsWith('/c/')) {
            fetch('/backend-api/conversations/cdp-conversation').then(response => response.json())
          }
        </script>`)
    })

    MCP_CONFIG.stateDir = join(profile, "lifecycle-state")
    MCP_CONFIG.chatGpt.projectUrl = `${origin}/g/g-p-cdp-fixture/project`
    MCP_CONFIG.chatGpt.cdpEndpoint = `http://127.0.0.1:${port}`
    MCP_CONFIG.chatGpt.maxDelegatedAgents = 1
    // Advance backend inactivity time only; Chrome, networking, page actions, and
    // the production service run normally against one reusable local conversation.
    lifecycleTest.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() })
    const agentService = createSubagents()
    service = agentService
    const request = { agentId: "cdp-lifecycle", prompt: "Test the lifecycle" }

    async function until(predicate: () => boolean | Promise<boolean>, label: string) {
      const deadline = performance.now() + 7_000
      while (performance.now() < deadline) {
        if (await predicate()) return
        await delay(20)
      }
      assert.fail(`Timed out: ${label}; submissions=${users.length}; historyReads=${historyReads}`)
    }

    await lifecycleTest.test("heartbeats keep a long turn alive without recovery", async () => {
      const turn = await sendAgentMessage(agentService, request, {})
      await until(() => streams.has(1), "first submission")
      for (let interval = 0; interval < 5; interval += 1) {
        lifecycleTest.mock.timers.tick(120_000)
        streams.get(1)!.write(": heartbeat\n\n")
        await until(
          async () => (await getAgentResponse(agentService, turn, 0)).activityAgeMs === 0,
          "heartbeat reaches the lifecycle"
        )
        assert.equal((await getAgentResponse(agentService, turn, 0)).status, "running")
        assert.equal(historyReads, 0)
      }
      savedAnswers.set(1, "first completed")
      streams.get(1)!.end(completedStream("first completed", users[0]!.id))
      assert.equal((await getAgentResponse(agentService, turn, 5_000)).response, "first completed")
      assert.equal(users.length, 1)
    })

    await lifecycleTest.test(
      "idle recovery reads a saved final answer without resubmission",
      async () => {
        lifecycleTest.mock.timers.tick(60_000)
        const turn = await sendAgentMessage(
          agentService,
          { ...request, prompt: "Recover completed history" },
          {}
        )
        await until(() => streams.has(2), "second submission")
        savedAnswers.set(2, "recovered completed answer")
        for (let minute = 0; minute < 3; minute += 1) {
          lifecycleTest.mock.timers.tick(60_000)
          await delay(100)
        }
        assert.equal(
          (await getAgentResponse(agentService, turn, 5_000)).response,
          "recovered completed answer"
        )
        assert.equal(historyReads, 1)
        assert.equal(users.length, 2)
      }
    )

    await lifecycleTest.test(
      "a late answer after pending history completes and leaves the agent reusable at capacity",
      async () => {
        lifecycleTest.mock.timers.tick(60_000)
        const turn = await sendAgentMessage(
          agentService,
          { ...request, prompt: "History is still pending" },
          {}
        )
        await until(() => streams.has(3), "third submission")
        const readsBefore = historyReads
        for (let minute = 0; minute < 3; minute += 1) {
          lifecycleTest.mock.timers.tick(60_000)
          await delay(100)
        }
        await until(() => historyReads > readsBefore, "pending history recovery")
        assert.equal((await getAgentResponse(agentService, turn, 0)).status, "running")
        assert.equal(historyReads, readsBefore + 1, "A quiet turn gets one history check")

        // History may lag streaming. Keep its third answer absent so a refreshed
        // history response cannot hide the loss of the original live observation.
        streams.get(3)!.end(completedStream("late completed answer", users[2]!.id))
        const result = await getAgentResponse(agentService, turn, 5_000)
        assert.equal(result.status, "completed", "A late final answer must remain recoverable")
        assert.equal(result.response, "late completed answer")
        assert.equal(users.length, 3, "Recovery must not submit the prompt again")

        savedAnswers.set(3, "late completed answer")
        lifecycleTest.mock.timers.tick(60_000)
        const followUp = await sendAgentMessage(
          agentService,
          { ...request, prompt: "Continue working" },
          {}
        )
        await until(() => streams.has(4), "same agent accepts a follow-up at capacity")
        streams.get(4)!.end(completedStream("follow-up completed", users[3]!.id))
        assert.equal(
          (await getAgentResponse(agentService, followUp, 5_000)).response,
          "follow-up completed"
        )
        assert.equal(users.length, 4)
      }
    )
  })

  await t.test("disconnect leaves Chrome available for reconnection", async () => {
    await connected.close()
    const reconnected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    browser = reconnected
    assert.ok(reconnected.contexts()[0]?.pages().length)
  })
})

/** Serve local TLS fixtures in the disposable browser and close every connection after the test. */
async function startHttpsFixture(
  t: TestContext,
  profile: string,
  listener: RequestListener
): Promise<string> {
  // chatgpt.com is HSTS-preloaded. The certificate exception belongs only to the
  // disposable Chrome process; the managed browser and authenticated profile are untouched.
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
    listener
  )
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `https://chatgpt.com:${address.port}`
}

function conversationFixture(url: string): string {
  const mode = new URL(url).pathname.split("/").at(-1)
  // Live project chats redirect the source while an unsaved WEB: branch opens later.
  const target =
    mode === "redirect-popup"
      ? "/c/WEB:fork-redirect-popup"
      : mode === "moving-menu"
        ? "/c/local-chatgpt%3Apending-moving-menu"
        : `/c/fork-${mode}`
  const branchAction =
    mode === "same-page"
      ? `location.href = '${target}'`
      : mode === "redirect-popup"
        ? `setTimeout(() => window.open('${target}', '_blank'), 300)`
        : `window.open('${target}', '_blank', '${mode === "noopener" ? "noopener,noreferrer" : ""}')`
  const redirectSource =
    mode === "redirect-popup" ? `history.replaceState(null, '', '/g/g-p-fixture/c/${mode}');` : ""
  // The live menu gains items after opening and shifts the trigger above the pointer.
  const hoverMenu =
    mode === "moving-menu"
      ? `if (!this.dataset.loaded) setTimeout(() => { this.dataset.loaded='1'; this.style.transform='translateY(-80px)'; }, 50); else setTimeout(() => document.querySelector('#branch').hidden=false, 100)`
      : `setTimeout(() => document.querySelector('#branch').hidden=false, 100)`
  return `<!doctype html><html><body>
    <section data-testid="conversation-turn-1">
      <div data-message-author-role="assistant">Source answer</div>
      <button aria-label="More actions" onclick="${redirectSource}document.querySelector('#branch-menu').hidden=false">More</button>
    </section>
    <button id="branch-menu" role="menuitem" hidden style="position:fixed;bottom:100px;left:100px"
      onpointermove="${hoverMenu}"
      onpointerleave="document.querySelector('#branch').hidden=true"
      onclick="document.querySelector('#branch').hidden=true">Open new branch</button>
    <button id="branch" role="menuitem" hidden onclick="${branchAction}">Branch in new Chat</button>
    <textarea id="prompt-textarea"></textarea>
    <button data-testid="send-button"
      onclick="document.querySelector('#submitted').textContent=document.querySelector('#prompt-textarea').value">Send</button>
    <div id="submitted"></div>
  </body></html>`
}

function completedMessage(answer: string) {
  return {
    author: { role: "assistant" },
    content: { parts: [answer] },
    status: "finished_successfully",
    end_turn: true,
    recipient: "all",
  }
}

function completedStream(answer: string, messageId = "cdp-user"): string {
  return [
    { type: "input_message", input_message: { id: messageId, author: { role: "user" } } },
    { v: { message: completedMessage(answer) } },
    { type: "message_stream_complete" },
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .join("")
}
