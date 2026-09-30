import assert from "node:assert/strict"
import { createServer } from "node:http"
import process from "node:process"
import test, { type TestContext } from "node:test"
import express, { type Express, type Response } from "express"
import { type Browser, chromium, type Locator, type Page } from "playwright-core"

import {
  type AgentIdentity,
  bindAgentParent,
  getAgentIdentity,
  runWithAgent,
  setAgentTaskSlug,
} from "../../src/agent/context.js"
import { createDashboardRouter } from "../../src/agent/dashboard-routes.js"
import { type AgentObserver, createAgentObserver } from "../../src/agent/observer.js"
import { ToolCallTracker } from "../../src/mcp/tool-call-tracker.js"
import { countTokens } from "../../src/tokenizer.js"
import { publishCall } from "../fixtures/tool-call.js"

const identity: AgentIdentity = {
  sessionId: "dashboard-test",
  agent: "agent-1",
  taskSlug: "dashboard-test",
}

// Builds and exercises the real UI, routes, and observer in disposable Chrome.
// No managed browser profile, MCP process, or ChatGPT conversation is involved.
test("dashboard interactions", {
  skip: process.env.RUN_UI_TESTS !== "1",
  timeout: 60_000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  })
  t.after(() => browser.close())

  await t.test(
    "dashboard, editor, and assets use root URLs while legacy URLs still work",
    async (t) => {
      const observer = createAgentObserver()
      publishCall(observer, identity, "shell_run", { command: "pwd" }).finish()
      const page = await openDashboard(t, browser, observer)
      const origin = new URL(page.url()).origin
      assert.equal(new URL(page.url()).pathname, "/")
      assert.match(
        (await page.locator('script[type="module"]').getAttribute("src")) ?? "",
        /^\/assets\//u
      )
      assert.match(
        (await page.locator('link[rel="stylesheet"]').getAttribute("href")) ?? "",
        /^\/assets\//u
      )

      const asset = "/pixel-agents/assets/floors/floor_5.png"
      for (const [oldPath, target] of [
        ["/ui", "/"],
        ["/ui/", "/"],
        ["/ui/?editor=1", "/?editor=1"],
        ["/ui/editor?example=1", "/editor?example=1"],
        ["/ui/api/agents", "/api/agents"],
        ["/ui/icons.svg", "/icons.svg"],
        [`/ui${asset}`, asset],
        ["/ui//example.com", "/example.com"],
      ]) {
        const response = await page.request.get(`${origin}${oldPath}`, { maxRedirects: 0 })
        assert.equal(response.status(), 308, oldPath)
        assert.equal(response.headers().location, target, oldPath)
      }
      const rootAsset = await page.request.get(`${origin}${asset}`)
      const legacyAsset = await page.request.get(`${origin}/ui${asset}`)
      assert.equal(rootAsset.status(), 200)
      assert.equal(legacyAsset.status(), 200)
      assert.deepEqual(await legacyAsset.body(), await rootAsset.body())
      const catalog = await page.request.get(`${origin}/pixel-agents/catalog.json`)
      assert.equal(catalog.status(), 200)
      assert.doesNotMatch(await catalog.text(), /"\/ui\//u)

      const steer = await page.request.post(`${origin}/ui/api/agents/${identity.agent}/steer`, {
        data: { message: "Legacy client instruction" },
      })
      assert.equal(steer.status(), 202)
      const { instruction } = await steer.json()
      assert.equal(
        observer.listAgents()[0]?.instructions.length,
        1,
        "Redirected POST retains its body and runs once"
      )
      const cancel = await page.request.delete(
        `${origin}/ui/api/agents/${identity.agent}/instructions/${instruction.id}`
      )
      assert.equal(cancel.status(), 204)

      await page.goto(`${origin}/ui/editor`)
      assert.equal(new URL(page.url()).pathname, "/editor")
      await page.getByRole("heading", { name: "Room Editor", exact: true }).waitFor()
      await page.getByRole("button", { name: "Back to Shellby Control", exact: true }).click()
      await page.getByRole("heading", { name: "Shellby Control", exact: true }).waitFor()
      assert.equal(new URL(page.url()).pathname, "/")
      await page.getByRole("button", { name: "Edit room", exact: true }).click()
      await page.getByRole("heading", { name: "Room Editor", exact: true }).waitFor()
      assert.equal(new URL(page.url()).pathname, "/editor")
      await page.goto(`${origin}/ui/?editor=1`)
      await page.getByRole("heading", { name: "Room Editor", exact: true }).waitFor()
      assert.equal(new URL(page.url()).pathname, "/")
      assert.equal(new URL(page.url()).search, "?editor=1")
    }
  )

  await t.test(
    "late parent links form selectable families with three-column previews and two main columns",
    async (t) => {
      const observer = createAgentObserver()
      const family = Array.from({ length: 5 }, (_, index) =>
        runWithAgent(`dashboard-family-${index}`, () => {
          setAgentTaskSlug(index === 0 ? "Build dashboard" : `Subtask ${index}`)
          return getAgentIdentity()!
        })
      )
      const parent = family[0]!
      const child = family[1]!
      for (let index = 0; index < 6; index++) {
        publishCall(observer, parent, "file_read", { path: `file-${index}.ts` }).finish()
      }
      for (const member of family) {
        publishCall(observer, member, "shell_run", { command: `echo ${member.agent}` })
      }
      for (const id of ["other-a", "other-b"]) {
        publishCall(observer, { sessionId: id, agent: id }, "shell_run", { command: id })
      }
      const page = await openDashboard(t, browser, observer)
      assert.equal(await page.getByRole("region").count(), 7)
      for (const member of family.slice(1)) {
        bindAgentParent(member.sessionId, parent.sessionId)
      }
      const parentCard = page.getByRole("region", { name: parent.agent, exact: true })
      const tiles = page.getByRole("group", { name: `Agent family ${parent.agent}` })
      await tiles.getByRole("button").nth(3).waitFor()
      assert.equal(await page.getByRole("region").count(), 3)
      assert.equal(await page.locator('canvas[data-animated="true"]').count(), 3)
      assert.equal(await tiles.locator('canvas[data-animated="false"]').count(), 4)
      const tileBoxes = await tiles.getByRole("button").evaluateAll((elements) =>
        elements.map((el) => {
          const { x, y, width } = el.getBoundingClientRect()
          return { x, y, width }
        })
      )
      assert.equal(tileBoxes[0]!.y, tileBoxes[2]!.y)
      assert.ok(tileBoxes[3]!.y > tileBoxes[0]!.y)
      const cardBoxes = await page
        .getByRole("region")
        .evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().y))
      assert.equal(cardBoxes[0], cardBoxes[1])
      assert.ok(cardBoxes[2]! > cardBoxes[0]!)

      await parentCard
        .getByPlaceholder("Steer this agent...")
        .fill("Parent draft\nSecond line\nThird line\nFourth line")
      const childTile = tiles.getByRole("button", { name: `Show ${child.agent}`, exact: true })
      await childTile.scrollIntoViewIfNeeded()
      const parentLayout = await cardLayout(parentCard)
      const scrollBeforeSwitch = await page.evaluate(() => scrollY)
      assert.equal(
        await parentCard
          .getByRole("list", { name: "Recent tool calls" })
          .evaluate((el) => el.scrollHeight > el.clientHeight),
        true
      )
      await childTile.click()
      const childCard = page.getByRole("region", { name: child.agent, exact: true })
      await childCard.getByRole("heading", { name: child.agent, exact: true }).waitFor()
      assert.deepEqual(
        await cardLayout(childCard),
        parentLayout,
        "Switching agents preserves card and section dimensions"
      )
      assert.equal(
        await page.evaluate(() => scrollY),
        scrollBeforeSwitch,
        "Selection does not jump back to the header"
      )
      assert.equal(await childCard.getByPlaceholder("Steer this agent...").inputValue(), "")
      assert.equal(await childCard.getByTitle(`echo ${parent.agent}`, { exact: true }).count(), 0)
      await childCard.getByTitle(`echo ${child.agent}`, { exact: true }).waitFor()
      const parentTile = tiles.getByRole("button", {
        name: `Show ${parent.agent}, parent`,
        exact: true,
      })
      await parentTile.getByText("PARENT", { exact: true }).waitFor()
      assert.notEqual(
        await parentTile.evaluate((el) => getComputedStyle(el).borderColor),
        await tiles
          .getByRole("button", { name: `Show ${family[2]!.agent}`, exact: true })
          .evaluate((el) => getComputedStyle(el).borderColor)
      )
      await childCard.getByPlaceholder("Steer this agent...").fill("Child only")
      await childCard.getByRole("button", { name: "Send instruction", exact: true }).click()
      await childCard.getByText("Queued: Child only", { exact: true }).waitFor()
      assert.deepEqual(observer.drainInstructions(parent), [])
      assert.deepEqual(observer.drainInstructions(child), ["Human instruction: Child only"])

      publishCall(observer, family[2]!, "shell_run", { command: "New background activity" })
      await childCard.getByRole("heading", { name: child.agent, exact: true }).waitFor()
      await childCard.getByRole("button", { name: `Dismiss ${child.agent}`, exact: true }).click()
      await parentCard.getByRole("heading", { name: parent.agent, exact: true }).waitFor()
      await page.getByText("Dismissed agents (1)", { exact: true }).click()
      await page.getByRole("button", { name: `Restore ${child.agent}`, exact: true }).click()
      await tiles.getByRole("button", { name: `Show ${child.agent}`, exact: true }).waitFor()
      assert.equal(
        await parentCard.count(),
        1,
        "Restoring a child does not replace the active parent"
      )

      await parentCard.getByRole("button", { name: `Dismiss ${parent.agent}`, exact: true }).click()
      await page.getByText("Dismissed agents (1)", { exact: true }).click()
      await page.getByRole("button", { name: `Restore ${parent.agent}`, exact: true }).waitFor()
      assert.equal(
        await page.getByRole("region").count(),
        3,
        "Hidden parents do not split siblings into separate cards"
      )
      await page.getByRole("button", { name: `Restore ${parent.agent}`, exact: true }).click()
      await parentTile.waitFor()
      await parentTile.click()
      await parentCard.getByRole("heading", { name: parent.agent, exact: true }).waitFor()

      await page.setViewportSize({ width: 375, height: 900 })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      )
      assert.equal(await tiles.getByRole("button").count(), 4)
      const mobileLayout = await cardLayout(parentCard)
      await childTile.click()
      assert.deepEqual(
        await cardLayout(childCard),
        mobileLayout,
        "Mobile family tiles and card height stay fixed"
      )
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      )
    }
  )

  await t.test("header token totals update live and follow the selected agent", async (t) => {
    const observer = createAgentObserver()
    const parentTracker = new ToolCallTracker({ agentObserver: observer })
    const input = { command: "printf hello" }
    const parent = runWithAgent("dashboard-token-parent", () => {
      parentTracker.startRequest({
        id: 1,
        method: "tools/call",
        params: { name: "shell_run", arguments: input },
      })
      return getAgentIdentity()!
    })
    const page = await openDashboard(t, browser, observer)
    const parentCard = page.getByRole("region", { name: parent.agent, exact: true })
    const totals = parentCard.getByRole("group", { name: "Tool token totals" })
    await totals
      .getByLabel(`Total tool input: ${countTokens(JSON.stringify(input)).toLocaleString()} tokens`)
      .waitFor()
    await totals.getByLabel("Total tool output: 0 tokens").waitFor()
    const initialLayout = await cardLayout(parentCard)
    const output = "Full output before preview truncation.\n".repeat(1_000)
    const outputLabel = `Total tool output: ${countTokens(output).toLocaleString()} tokens`
    parentTracker.respond({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: output }] },
    })
    await totals.getByLabel(outputLabel).waitFor()
    assert.match((await totals.getByLabel(outputLabel).textContent()) ?? "", /K$/u)
    assert.deepEqual(await cardLayout(parentCard), initialLayout)

    const childTracker = new ToolCallTracker({ agentObserver: observer })
    const child = runWithAgent("dashboard-token-child", () => {
      bindAgentParent(getAgentIdentity()!.sessionId, parent.sessionId)
      childTracker.startRequest({
        id: 1,
        method: "tools/call",
        params: { name: "shell_list" },
      })
      return getAgentIdentity()!
    })
    await page.getByRole("button", { name: `Show ${child.agent}`, exact: true }).click()
    const childCard = page.getByRole("region", { name: child.agent, exact: true })
    const childTotals = childCard.getByRole("group", { name: "Tool token totals" })
    await childTotals.getByLabel(`Total tool input: ${countTokens("{}")} tokens`).waitFor()
    await childTotals.getByLabel("Total tool output: 0 tokens").waitFor()
    childTracker.respond({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "done" }] },
    })
    await childTotals.getByLabel(`Total tool output: ${countTokens("done")} tokens`).waitFor()
    await childCard.getByRole("button", { name: `Show parent ${parent.agent}` }).click()
    await totals.getByLabel(outputLabel).waitFor()
    await page.reload()
    await totals.getByLabel(outputLabel).waitFor()

    await page.setViewportSize({ width: 375, height: 900 })
    const mobileLayout = await cardLayout(parentCard)
    await page.getByRole("button", { name: `Show ${child.agent}`, exact: true }).click()
    assert.deepEqual(await cardLayout(childCard), mobileLayout)
    assert.equal(
      await childCard
        .getByRole("heading", { name: child.agent, exact: true })
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
      "The compact header keeps the agent name readable"
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
  })

  await t.test(
    "open tool details update with returned output, errors, and unavailable history",
    async (t) => {
      const observer = createAgentObserver()
      const callId = publishCall(observer, identity, "shell_run", { command: "printf output" })
      const page = await openDashboard(t, browser, observer)
      const row = page.getByRole("button", {
        name: "Inspect shell_run: printf output (running)",
        exact: true,
      })
      await row.getByText("Running commands", { exact: true }).waitFor()
      assert.equal(
        await row.locator("svg use").first().getAttribute("href"),
        "/icons.svg#tabler-terminal-2"
      )
      await page.waitForFunction(() => {
        const icon = document.querySelector(
          'button[title="printf output"] svg'
        ) as SVGGraphicsElement | null
        return (icon?.getBBox().width ?? 0) > 0
      })
      const sprite = await page.request.get(new URL("/icons.svg", page.url()).href)
      assert.equal(sprite.status(), 200)
      assert.match(sprite.headers()["content-type"] ?? "", /image\/svg\+xml/u)
      assert.match(await sprite.text(), /id="tabler-terminal-2"/u)
      const runningLayout = await cardLayout(
        page.getByRole("region", { name: identity.agent, exact: true })
      )
      await page.getByTitle("printf output", { exact: true }).click()
      const modal = page.getByRole("dialog")
      await modal.getByText("Waiting for the tool to return…", { exact: true }).waitFor()
      await modal
        .getByRole("heading", {
          name: `Input ${countTokens(JSON.stringify({ command: "printf output" }))} tokens`,
        })
        .waitFor()
      assert.equal(
        await modal.getByRole("heading", { name: "Output returned to agent", exact: true }).count(),
        1
      )
      const output =
        "First line\nSecond line\n<script>throw new Error('must not execute')</script>\n\n```js\nconst value = 42;\n```\n\n```markdown\n# Literal heading\n```\n\n**Notice:** Human instruction: Continue"
      callId.finish({
        response: { content: [{ type: "text", text: output }] },
      })
      await modal.getByText(output, { exact: true }).waitFor()
      await modal
        .getByRole("heading", { name: `Output returned to agent ${countTokens(output)} tokens` })
        .waitFor()
      assert.equal(await modal.locator("pre").nth(1).textContent(), output)
      assert.equal(
        await modal.locator("pre").nth(1).locator(".hljs-keyword").textContent(),
        "const"
      )
      assert.equal(await modal.locator("pre").nth(1).locator("h1, script").count(), 0)
      assert.equal(await modal.getByText("Waiting for the tool to return…").count(), 0)
      await modal.getByRole("button", { name: "Close tool call details" }).click()
      await page
        .getByRole("button", { name: "Inspect shell_run: printf output (completed)", exact: true })
        .waitFor()
      assert.deepEqual(
        await cardLayout(page.getByRole("region", { name: identity.agent, exact: true })),
        runningLayout,
        "Completion does not resize the card"
      )

      const failedCall = publishCall(observer, identity, "shell_run", {
        command: "failing command",
      })
      failedCall.finish({
        status: "failed",
        response: {
          isError: true,
          content: [{ type: "text", text: "COMMAND_FAILED: exit 1" }],
        },
      })
      await page.getByTitle("failing command", { exact: true }).click()
      await modal.getByText("COMMAND_FAILED: exit 1", { exact: true }).waitFor()
      await modal.getByRole("button", { name: "Close tool call details" }).click()

      const legacyCall = publishCall(observer, identity, "shell_run", { command: "older call" })
      legacyCall.finish()
      await page.getByTitle("older call", { exact: true }).click()
      await modal.getByText("Output was not captured for this call.", { exact: true }).waitFor()
      await modal.getByRole("button", { name: "Close tool call details" }).click()

      const large = publishCall(observer, identity, "shell_run", { command: "large output" })
      const fullOutput = "Full output before preview truncation.\n".repeat(1_000)
      large.finish({ response: { content: [{ type: "text", text: fullOutput }] } })
      await page.getByTitle("large output", { exact: true }).click()
      await modal.getByText(/Dashboard output truncated/u).waitFor()
      await modal
        .getByRole("heading", {
          name: `Output returned to agent ${countTokens(fullOutput).toLocaleString()} tokens`,
        })
        .waitFor()
    }
  )

  await t.test(
    "reconnect recovers missed output without overwriting live events with a delayed snapshot",
    async (t) => {
      const observer = createAgentObserver()
      const call = publishCall(observer, identity, "shell_run", { command: "long-running command" })
      const otherAgent = { sessionId: "dashboard-reconnect-race", agent: "race-agent" }
      publishCall(observer, otherAgent, "file_read", { path: "/tmp/older-file.txt" }).finish()
      let events: Response | undefined
      let acceptEvents = true
      let holdSnapshot = false
      let releaseSnapshot: (() => void) | undefined
      let snapshotReady: () => void = () => {}
      const snapshotHeld = new Promise<void>((resolve) => {
        snapshotReady = resolve
      })
      const page = await openDashboard(t, browser, observer, (app) => {
        app.get("/api/agents", (_req, res, next) => {
          if (!holdSnapshot) return next()
          const agents = observer.listAgents()
          releaseSnapshot = () => res.json({ agents })
          snapshotReady()
        })
        app.get("/api/events", (_req, res, next) => {
          if (!acceptEvents) {
            res.status(503).end()
            return
          }
          events = res
          next()
        })
      })
      await page.getByTitle("long-running command", { exact: true }).click()
      const modal = page.getByRole("dialog")
      await modal.getByText("Waiting for the tool to return…", { exact: true }).waitFor()
      acceptEvents = false
      assert.ok(events)
      events.end()
      await page.getByText("Reconnecting", { exact: true }).waitFor()
      call.finish({ response: { content: [{ type: "text", text: "Finished during disconnect" }] } })
      holdSnapshot = true
      acceptEvents = true
      await page.getByText("Live", { exact: true }).waitFor()
      await snapshotHeld
      publishCall(observer, otherAgent, "image_view", { path: "/tmp/new-image.png" })
      await page.getByTitle("/tmp/new-image.png", { exact: true }).waitFor()
      const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/agents"))
      assert.ok(releaseSnapshot)
      releaseSnapshot()
      await (await refreshed).finished()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
      await modal.getByText("Finished during disconnect", { exact: true }).waitFor()
      await modal.getByRole("button", { name: "Close tool call details" }).click()
      await page
        .getByRole("button", {
          name: "Inspect image_view: /tmp/new-image.png (running)",
          exact: true,
        })
        .waitFor()
      await page
        .getByRole("button", {
          name: "Inspect shell_run: long-running command (completed)",
          exact: true,
        })
        .waitFor()
    }
  )

  await t.test(
    "delivered messages stay dismissed, while new and queued messages still work",
    async (t) => {
      const observer = createAgentObserver()
      const callId = publishCall(observer, identity, "shell_run", { command: "pwd" })
      callId.finish()
      const page = await openDashboard(t, browser, observer)

      for (const message of ["First steer", "Second steer"]) {
        await page.getByPlaceholder("Steer this agent...").fill(message)
        await page.getByRole("button", { name: "Send instruction", exact: true }).click()
        await page.getByText(`Queued: ${message}`, { exact: true }).waitFor()
        assert.deepEqual(observer.drainInstructions(identity), [`Human instruction: ${message}`])
        await page.getByText(`Delivered: ${message}`, { exact: true }).waitFor()
      }

      for (const message of ["Second steer", "First steer"]) {
        const row = page
          .getByRole("list", { name: "Steer messages" })
          .getByRole("listitem")
          .filter({ hasText: `Delivered: ${message}` })
        await row.hover()
        await row.getByRole("button", { name: "Dismiss delivered instruction" }).click()
      }
      await page
        .getByRole("button", { name: "Dismiss delivered instruction" })
        .waitFor({ state: "detached" })
      assert.equal(
        observer.listAgents()[0]?.instructions.length,
        2,
        "Dismissal preserves server history"
      )

      await page.reload()
      await page.getByPlaceholder("Steer this agent...").waitFor()
      await page.getByText("Live", { exact: true }).waitFor()
      assert.equal(await page.getByText(/^Delivered:/u).count(), 0)

      // A new delivered message must still appear after the older notices were dismissed.
      observer.queueInstruction(identity.agent, "Third steer")
      observer.drainInstructions(identity)
      await page.getByText("Delivered: Third steer", { exact: true }).waitFor()
      await page.getByText("Delivered: Third steer", { exact: true }).hover()
      await page.getByRole("button", { name: "Dismiss delivered instruction" }).click()

      observer.queueInstruction(identity.agent, "Cancel me")
      await page.getByText("Queued: Cancel me", { exact: true }).hover()
      await page.getByRole("button", { name: "Cancel queued instruction" }).click()
      await page
        .getByRole("button", { name: "Cancel queued instruction" })
        .waitFor({ state: "detached" })
      assert.deepEqual(observer.drainInstructions(identity), [])
      assert.equal(await page.getByText(/^Delivered:/u).count(), 0)

      // Hiding and restoring a card must not resurrect dismissed delivery notices either.
      await page.getByRole("button", { name: "Dismiss agent-1", exact: true }).click()
      await page.getByText("Dismissed agents (1)", { exact: true }).click()
      await page.getByRole("button", { name: "Restore agent-1", exact: true }).click()
      await page.getByPlaceholder("Steer this agent...").waitFor()
      assert.equal(await page.getByText(/^Delivered:/u).count(), 0)
    }
  )

  await t.test(
    "steer messages scroll within fixed space and actions target individual messages",
    async (t) => {
      const observer = createAgentObserver()
      publishCall(observer, identity, "shell_run", { command: "pwd" }).finish()
      const page = await openDashboard(t, browser, observer)
      await page.setViewportSize({ width: 1440, height: 1000 })
      const card = page.getByRole("region", { name: identity.agent, exact: true })
      const messages = card.getByRole("list", { name: "Steer messages" })
      const emptyLayout = await cardLayout(card)

      observer.queueInstruction(identity.agent, "Earlier delivery")
      observer.queueInstruction(identity.agent, "Later delivery")
      observer.drainInstructions(identity)
      for (let index = 1; index <= 6; index++) {
        observer.queueInstruction(identity.agent, `Queued message ${index}`)
      }
      await messages.getByText("Queued: Queued message 6", { exact: true }).waitFor()
      assert.equal(await messages.getByRole("listitem").count(), 8)
      assert.equal(
        await messages.getByText(/^Delivered:/u).count(),
        2,
        "Delivered messages remain visible alongside queued messages"
      )
      assert.deepEqual(
        await cardLayout(card),
        emptyLayout,
        "Filling the message list does not resize the card"
      )
      assert.equal(await messages.evaluate((el) => el.scrollHeight > el.clientHeight), true)
      await messages.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      assert.ok((await messages.evaluate((el) => el.scrollTop)) > 0, "Overflow can be scrolled")

      const queued = messages.getByRole("listitem").filter({ hasText: "Queued: Queued message 3" })
      await queued.hover()
      await queued.getByRole("button", { name: "Cancel queued instruction", exact: true }).click()
      await queued.waitFor({ state: "detached" })
      assert.equal(
        observer.listAgents()[0]?.instructions.some((item) => item.message === "Queued message 3"),
        false
      )
      assert.equal(await messages.getByText(/^Queued:/u).count(), 5)

      const delivered = messages
        .getByRole("listitem")
        .filter({ hasText: "Delivered: Earlier delivery" })
      await delivered.hover()
      await delivered
        .getByRole("button", { name: "Dismiss delivered instruction", exact: true })
        .click()
      await delivered.waitFor({ state: "detached" })
      assert.equal(
        await messages.getByText("Delivered: Later delivery", { exact: true }).count(),
        1
      )
      assert.equal(
        observer.listAgents()[0]?.instructions.some((item) => item.message === "Earlier delivery"),
        true
      )

      await page.route("**/api/agents/agent-1/steer", (route) =>
        route.fulfill({ status: 500, json: { error: "Unable to send instruction" } })
      )
      await card.getByPlaceholder("Steer this agent...").fill("Retry this message")
      await card.getByRole("button", { name: "Send instruction", exact: true }).click()
      await messages.getByRole("alert").waitFor()
      assert.equal(
        await messages.getByText(/^Queued:/u).count(),
        5,
        "A send error does not hide existing messages"
      )
      assert.deepEqual(await cardLayout(card), emptyLayout)
      await page.unroute("**/api/agents/agent-1/steer")

      observer.drainInstructions(identity)
      await messages.getByText("Delivered: Queued message 6", { exact: true }).waitFor()
      assert.equal(await messages.getByText(/^Queued:/u).count(), 0)
      assert.equal(await messages.getByText(/^Delivered:/u).count(), 6)
      await page.reload()
      await messages.getByText("Delivered: Queued message 6", { exact: true }).waitFor()
      assert.equal(
        await messages.getByText("Delivered: Earlier delivery", { exact: true }).count(),
        0
      )

      await page.setViewportSize({ width: 375, height: 900 })
      const mobileLayout = await cardLayout(card)
      observer.queueInstruction(identity.agent, "Mobile message")
      await messages.getByText("Queued: Mobile message", { exact: true }).waitFor()
      assert.deepEqual(await cardLayout(card), mobileLayout)
      assert.equal(await messages.evaluate((el) => el.scrollHeight > el.clientHeight), true)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      )
    }
  )

  await t.test(
    "agent dismissal survives refresh and steering changes, supports restore, and ends on activity",
    async (t) => {
      let timestamp = Date.now() - 60_000
      const observer = createAgentObserver(() => ++timestamp)
      const callId = publishCall(observer, identity, "shell_run", { command: "pwd" }, ++timestamp)
      callId.finish({ finishedAt: ++timestamp })
      const otherIdentity = { sessionId: "other-session", agent: "agent-2", taskSlug: "other-task" }
      publishCall(observer, otherIdentity, "shell_run", { command: "date" }, ++timestamp)
      const page = await openDashboard(t, browser, observer)
      const card = page.getByRole("region", { name: "agent-1", exact: true })
      await card.getByText("INACTIVE", { exact: true }).waitFor()
      await card.getByRole("button", { name: "Dismiss agent-1", exact: true }).click()
      await card.waitFor({ state: "detached" })
      assert.equal(observer.listAgents().length, 2)
      await page.reload()
      await page.getByText("Live", { exact: true }).waitFor()
      await page.getByText("Dismissed agents (1)", { exact: true }).waitFor()
      assert.equal(await card.count(), 0)

      // Queue updates emit agent_changed but are not agent activity.
      const queued = observer.queueInstruction(identity.agent, "Wait for activity")
      assert.ok(queued)
      observer.queueInstruction(otherIdentity.agent, "Still visible")
      await page.getByText("Queued: Still visible", { exact: true }).waitFor()
      assert.equal(await card.count(), 0)
      await page.getByText("Dismissed agents (1)", { exact: true }).click()
      await page.getByRole("button", { name: "Restore agent-1", exact: true }).click()
      await card.getByText("Queued: Wait for activity", { exact: true }).waitFor()
      assert.equal(await card.getByTitle("pwd", { exact: true }).count(), 1)

      await page.getByRole("button", { name: "Dismiss agent-1", exact: true }).click()
      await page.getByRole("button", { name: "Dismiss agent-2", exact: true }).click()
      await page.getByRole("heading", { name: "All agents are dismissed" }).waitFor()

      timestamp = Date.now()
      const newCall = publishCall(
        observer,
        identity,
        "shell_run",
        { command: "echo resumed" },
        ++timestamp
      )
      await card.getByText("ACTIVE", { exact: true }).waitFor()
      await card.getByTitle("echo resumed", { exact: true }).waitFor()
      await page.getByText("Dismissed agents (1)", { exact: true }).waitFor()
      assert.equal(await page.getByRole("region", { name: "agent-2", exact: true }).count(), 0)
      await page.reload()
      await card.waitFor()
      await page.getByText("Live", { exact: true }).waitFor()

      // Finishing a call also counts as activity after dismissal of a running agent.
      await card.getByRole("button", { name: "Dismiss agent-1", exact: true }).click()
      await card.waitFor({ state: "detached" })
      newCall.finish({ finishedAt: ++timestamp })
      await card.getByTitle("echo resumed", { exact: true }).waitFor()
    }
  )

  await t.test(
    "old preferences cannot hide a reused agent ID or its new delivery notices",
    async (t) => {
      const observer = createAgentObserver()
      publishCall(observer, identity, "shell_run", { command: "pwd" })
      const instruction = observer.queueInstruction(identity.agent, "New session instruction")
      assert.ok(instruction)
      observer.drainInstructions(identity)
      const page = await openDashboard(t, browser, observer)

      await page.evaluate(
        ({ instructionId }) => {
          localStorage.setItem(
            "shellby-dashboard-dismissals-v1",
            JSON.stringify({
              "agent-1": {
                firstSeenAt: 1,
                hiddenThrough: Number.MAX_SAFE_INTEGER,
                instructionIds: [instructionId],
              },
            })
          )
        },
        { instructionId: instruction.id }
      )
      await page.reload()
      await page.getByText("Delivered: New session instruction", { exact: true }).waitFor()

      await page.evaluate(() => localStorage.setItem("shellby-dashboard-dismissals-v1", "not JSON"))
      await page.reload()
      await page.getByText("Delivered: New session instruction", { exact: true }).waitFor()
    }
  )
})

async function openDashboard(
  t: TestContext,
  browser: Browser,
  observer: AgentObserver,
  configure?: (app: Express) => void
): Promise<Page> {
  const app = express()
  app.use(express.json())
  configure?.(app)
  app.use(createDashboardRouter(observer))
  const server = createServer(app)
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  t.after(async () => {
    await context.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const page = await context.newPage()
  page.setDefaultTimeout(5_000)
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  t.after(() => assert.deepEqual(pageErrors, [], "Dashboard must not throw browser errors"))
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.getByRole("region").first().waitFor()
  await page.getByText("Live", { exact: true }).waitFor()
  return page
}

async function cardLayout(card: Locator) {
  return card.evaluate((element) => {
    const card = element.getBoundingClientRect()
    return {
      width: card.width,
      height: card.height,
      sections: [
        ...element.querySelectorAll('canvas[data-animated="true"], ul, textarea, fieldset'),
      ].map((section) => {
        const box = section.getBoundingClientRect()
        return { x: box.x - card.x, y: box.y - card.y, width: box.width, height: box.height }
      }),
    }
  })
}
