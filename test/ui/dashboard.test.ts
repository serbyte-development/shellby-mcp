import assert from "node:assert/strict"
import { createServer } from "node:http"
import process from "node:process"
import test, { type TestContext } from "node:test"
import express from "express"
import { type Browser, chromium, type Page } from "playwright-core"

import {
  type AgentIdentity,
  bindAgentParent,
  getAgentIdentity,
  runWithAgent,
  setAgentTaskSlug,
} from "../../src/agent/context.js"
import { createDashboardRouter } from "../../src/agent/dashboard-routes.js"
import { type AgentObserver, createAgentObserver } from "../../src/agent/observer.js"
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

      await parentCard.getByPlaceholder("Steer this agent...").fill("Parent draft")
      await tiles.getByRole("button", { name: `Show ${child.agent}`, exact: true }).click()
      const childCard = page.getByRole("region", { name: child.agent, exact: true })
      await childCard.getByRole("heading", { name: child.agent, exact: true }).waitFor()
      assert.equal(await childCard.getByPlaceholder("Steer this agent...").inputValue(), "")
      assert.equal(await childCard.getByText(`echo ${parent.agent}`, { exact: true }).count(), 0)
      await childCard.getByText(`echo ${child.agent}`, { exact: true }).waitFor()
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
    }
  )

  await t.test(
    "open tool details update with returned output, errors, and unavailable history",
    async (t) => {
      const observer = createAgentObserver()
      const callId = publishCall(observer, identity, "shell_run", { command: "printf output" })
      const page = await openDashboard(t, browser, observer)
      await page.getByText("printf output", { exact: true }).click()
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
      await page.getByText("failing command", { exact: true }).click()
      await modal.getByText("COMMAND_FAILED: exit 1", { exact: true }).waitFor()
      await modal.getByRole("button", { name: "Close tool call details" }).click()

      const legacyCall = publishCall(observer, identity, "shell_run", { command: "older call" })
      legacyCall.finish()
      await page.getByText("older call", { exact: true }).click()
      await modal.getByText("Output was not captured for this call.", { exact: true }).waitFor()
      await modal.getByRole("button", { name: "Close tool call details" }).click()

      const large = publishCall(observer, identity, "shell_run", { command: "large output" })
      const fullOutput = "Full output before preview truncation.\n".repeat(1_000)
      large.finish({ response: { content: [{ type: "text", text: fullOutput }] } })
      await page.getByText("large output", { exact: true }).click()
      await modal.getByText(/Dashboard output truncated/u).waitFor()
      await modal
        .getByRole("heading", {
          name: `Output returned to agent ${countTokens(fullOutput).toLocaleString()} tokens`,
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
        await page.getByText(`Delivered: ${message}`, { exact: true }).hover()
        await page.getByRole("button", { name: "Dismiss delivered instruction" }).click()
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
      assert.equal(await card.getByText("pwd", { exact: true }).count(), 1)

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
      await card.getByText("echo resumed", { exact: true }).waitFor()
      await page.getByText("Dismissed agents (1)", { exact: true }).waitFor()
      assert.equal(await page.getByRole("region", { name: "agent-2", exact: true }).count(), 0)
      await page.reload()
      await card.waitFor()
      await page.getByText("Live", { exact: true }).waitFor()

      // Finishing a call also counts as activity after dismissal of a running agent.
      await card.getByRole("button", { name: "Dismiss agent-1", exact: true }).click()
      await card.waitFor({ state: "detached" })
      newCall.finish({ finishedAt: ++timestamp })
      await card.getByText("echo resumed", { exact: true }).waitFor()
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
  observer: AgentObserver
): Promise<Page> {
  const app = express()
  app.use(express.json())
  app.use("/ui", createDashboardRouter(observer))
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
  await page.goto(`http://127.0.0.1:${address.port}/ui/`)
  await page.getByRole("region").first().waitFor()
  await page.getByText("Live", { exact: true }).waitFor()
  return page
}
