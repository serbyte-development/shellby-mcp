import assert from "node:assert/strict"
import { createServer } from "node:http"
import process from "node:process"
import test, { type TestContext } from "node:test"
import express from "express"
import { type Browser, chromium, type Page } from "playwright-core"

import type { AgentIdentity } from "../../src/agent/context.js"
import { createDashboardRouter } from "../../src/agent/dashboard-routes.js"
import { type AgentObserver, createAgentObserver } from "../../src/agent/observer.js"

const identity: AgentIdentity = {
  sessionId: "dashboard-test",
  agent: "agent-1",
  taskSlug: "dashboard-test",
}

// Builds and exercises the real UI, routes, and observer in disposable Chrome.
// No managed browser profile, MCP process, or ChatGPT conversation is involved.
test("dashboard dismissal behavior", {
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
    "delivered messages stay dismissed, while new and queued messages still work",
    async (t) => {
      const observer = createAgentObserver()
      const callId = observer.startTool(identity, "shell_run", { command: "pwd" })
      observer.finishTool(identity, callId)
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
      const callId = observer.startTool(identity, "shell_run", { command: "pwd" })
      observer.finishTool(identity, callId)
      const otherIdentity = { sessionId: "other-session", agent: "agent-2", taskSlug: "other-task" }
      observer.startTool(otherIdentity, "shell_run", { command: "date" })
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
      const newCall = observer.startTool(identity, "shell_run", { command: "echo resumed" })
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
      observer.finishTool(identity, newCall)
      await card.getByText("echo resumed", { exact: true }).waitFor()
    }
  )

  await t.test(
    "old preferences cannot hide a reused agent ID or its new delivery notices",
    async (t) => {
      const observer = createAgentObserver()
      observer.startTool(identity, "shell_run", { command: "pwd" })
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
  await page.getByRole("heading", { name: "agent-1", exact: true }).waitFor()
  await page.getByText("Live", { exact: true }).waitFor()
  return page
}
