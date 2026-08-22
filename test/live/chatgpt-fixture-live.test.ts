import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { chromium } from "playwright-core"

import { MCP_CONFIG } from "../../src/config.js"
import {
  assertAuthenticated,
  assertConversationAvailable,
  createBackgroundPage,
  navigateAndCaptureConversationPayload,
} from "../../src/tools/subagent/chatgpt-subagent-browser.js"
import { extractConversationMessages } from "../../src/tools/subagent/chatgpt-subagent-protocol.js"

const LIVE_FIXTURE_ENABLED = process.env.RUN_LIVE_CHATGPT_FIXTURE_TESTS === "1" && !process.env.CI
const LIVE_TIMEOUT_MS = 90_000
const FIXTURE_TIMEOUT_MS = 40_000
const MANAGED_VIEWPORT = { width: 412, height: 915 } as const
const NORMAL_FIXTURE_FILE = new URL("../fixtures/chatgpt-live-fixture/conversation.json", import.meta.url)
const PROJECT_FIXTURE_FILE = new URL("../fixtures/chatgpt-project-live-fixture/conversation.json", import.meta.url)

interface LiveFixture {
  name: string
  file: URL
  conversationUrl: (conversationId: string) => string
  projectScoped: boolean
}

const LIVE_FIXTURES: LiveFixture[] = [
  {
    name: "normal conversation",
    file: NORMAL_FIXTURE_FILE,
    conversationUrl: (conversationId) => `https://chatgpt.com/c/${conversationId}`,
    projectScoped: false,
  },
  {
    name: "project conversation",
    file: PROJECT_FIXTURE_FILE,
    conversationUrl: projectConversationUrl,
    projectScoped: true,
  },
]

interface DomSnapshot {
  url: string
  rawText: string
  heading: string
  listItems: string[]
  tableText: string
  preBlocks: string[]
}

test(
  "live saved ChatGPT fixtures pass through the production browser and parsing path",
  { skip: !LIVE_FIXTURE_ENABLED, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    for (const fixture of LIVE_FIXTURES) {
      await t.test(fixture.name, { timeout: FIXTURE_TIMEOUT_MS }, async (fixtureTest) => {
        if (fixture.projectScoped && !MCP_CONFIG.chatGpt.projectUrl) {
          fixtureTest.skip("Set MCP_CHATGPT_PROJECT_URL before running the project fixture contract.")
          return
        }
        if (!existsSync(fixture.file)) {
          fixtureTest.skip(`Create ${fixture.file.pathname} before running the ${fixture.name} fixture contract.`)
          return
        }

        const frozenPayload = JSON.parse(await readFile(fixture.file, "utf8")) as unknown
        const frozenRecord = asRecord(frozenPayload)
        const conversationId = stringValue(frozenRecord?.conversation_id)
        assert.ok(conversationId, "frozen fixture must contain conversation_id")
        const fixtureUrl = fixture.conversationUrl(conversationId)
        const frozenMessages = extractConversationMessages(frozenPayload)
        assert.equal(frozenMessages.length, 2)
        const expectedResponse = frozenMessages.at(-1)?.text
        assert.ok(expectedResponse)

        const browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, { timeout: 3_000 })
        const [context] = browser.contexts()
        if (!context) {
          await browser.close().catch(() => undefined)
          assert.fail("connected Chrome must expose its authenticated browser context")
        }
        const page = await createBackgroundPage(browser, context).catch(async (error) => {
          await browser.close().catch(() => undefined)
          throw error
        })
        fixtureTest.after(async () => {
          if (!page.isClosed()) await page.close().catch(() => undefined)
          await browser.close().catch(() => undefined)
        })
        await page.setViewportSize(MANAGED_VIEWPORT)

        const livePayload = await navigateAndCaptureConversationPayload(page, fixtureUrl, conversationId, 15_000)
        assert.ok(livePayload, "ChatGPT must return the saved-conversation payload used by production recovery")
        await assertAuthenticated(page)
        await assertConversationAvailable(page, conversationId, 15_000)

        const liveRecord = asRecord(livePayload)
        assert.equal(liveRecord?.conversation_id, conversationId)
        assert.ok(stringValue(liveRecord?.title), "live conversation payload must contain a title")

        const liveMessages = extractConversationMessages(livePayload)
        assert.deepEqual(liveMessages, frozenMessages, "live conversation branch must still match the frozen compatibility fixture")
        assert.equal(liveMessages.at(-1)?.text, expectedResponse)
        assert.ok(rawServerContentParts(livePayload).includes(expectedResponse), "live content.parts must contain the exact Markdown response")

        const assistant = page.locator('[data-message-author-role="assistant"]').filter({ hasText: "LIVE_SUBAGENT_FIXTURE_BEGIN" }).first()
        await assistant.waitFor({ state: "visible", timeout: 15_000 })
        const dom = (await assistant.evaluate((element) => ({
          url: location.href,
          rawText: (element.textContent ?? "").trim(),
          heading: (element.querySelector("h2")?.textContent ?? "").trim(),
          listItems: Array.from(element.querySelectorAll("li")).map((item) => (item.textContent ?? "").trim()),
          tableText: (element.querySelector("table")?.textContent ?? "").trim(),
          preBlocks: Array.from(element.querySelectorAll("pre")).map((item) => (item.textContent ?? "").trim()),
        }))) as DomSnapshot

        assertConversationUrl(dom.url, conversationId, fixture.projectScoped)
        assert.ok(dom.rawText.includes("LIVE_SUBAGENT_FIXTURE_BEGIN"))
        assert.ok(dom.rawText.includes("LIVE_CTX_b9536da73e8e"))
        assert.equal(dom.heading, "Live Fixture")
        assert.deepEqual(dom.listItems, ["alpha", "beta"])
        assert.match(dom.tableText.replace(/\s+/g, ""), /keyvaluefixtureok/)
        assert.ok(dom.preBlocks.some((block) => block.includes("### Nested Markdown") && block.includes("LIVE_CTX_b9536da73e8e")))
        assert.ok(dom.preBlocks.some((block) => block.includes("const answer: number = 42;")))
      })
    }
  }
)

function projectConversationUrl(conversationId: string): string {
  const configuredProjectUrl = MCP_CONFIG.chatGpt.projectUrl
  if (!configuredProjectUrl) {
    throw new Error("Project fixture requires MCP_CHATGPT_PROJECT_URL to point at a ChatGPT project.")
  }
  const projectUrl = new URL(configuredProjectUrl)
  if (projectUrl.pathname === "/") {
    throw new Error("Project fixture requires MCP_CHATGPT_PROJECT_URL to point at a ChatGPT project.")
  }
  projectUrl.pathname = `${projectUrl.pathname.replace(/\/project\/?$/, "")}/c/${conversationId}`
  projectUrl.search = ""
  projectUrl.hash = ""
  return projectUrl.toString()
}

function assertConversationUrl(url: string, conversationId: string, projectScoped: boolean): void {
  const parsed = new URL(url)
  assert.equal(parsed.hostname, "chatgpt.com")
  assert.match(parsed.pathname, new RegExp(`/c/${escapeRegExp(conversationId)}$`))
  if (projectScoped) assert.match(parsed.pathname, /^\/g\/g-p-[^/]+(?:-[^/]+)?\/c\//)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function rawServerContentParts(value: unknown): string[] {
  const found: string[] = []
  const visited = new Set<object>()

  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return
    if (visited.has(current)) return
    visited.add(current)
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    const record = current as Record<string, unknown>
    const content = asRecord(record.content)
    if (content && Array.isArray(content.parts)) {
      for (const part of content.parts) if (typeof part === "string") found.push(part)
    }
    for (const nested of Object.values(record)) visit(nested)
  }

  visit(value)
  return found
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
