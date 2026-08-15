import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { Page } from "playwright-core"

import { MCP_CONFIG } from "../../src/config.js"
import { startMcpHttpServer } from "../../src/server/http-server.js"
import {
  extractConversationMessages,
  findLatestAssistantAfterPrompt,
  loadConversationPayload,
  readAssistantDomMessages,
  type DomAssistantMessage,
} from "../../src/tools/subagent/chatgpt-subagent-browser.js"
import { ChatGptSubagentModule } from "../../src/tools/subagent/chatgpt-subagent.js"

const LIVE_TEST_ENABLED = process.env.RUN_LIVE_SUBAGENT_TESTS === "1" && !process.env.CI
const LIVE_AGENT_ID = "live-subagent-integration"
const LIVE_TIMEOUT_MS = 4 * 60_000
const POLL_WAIT_MS = 60_000
const ARTIFACT_DIR = new URL("./artifacts/", import.meta.url)

interface LiveTrackedFinal {
  message: {
    text: string
  }
}

interface LiveAgentState {
  page: Page
  conversationId?: string
  conversationUrl?: string
  turnCount: number
  tracker: {
    findFinalResponse(query: {
      baselineIds: ReadonlySet<string>
      prompt?: string
      sentAtSeconds?: number
    }): LiveTrackedFinal | undefined
  }
}

interface LiveTurnState {
  turnId: string
  status: "running" | "completed" | "failed"
  response?: string
  tracking?: {
    baselineNetworkIds: ReadonlySet<string>
    baselineDom: readonly DomAssistantMessage[]
    prompt: string
    sentAtSeconds: number
  }
}

interface LiveModuleInternals {
  agents: Map<string, LiveAgentState>
  turns: Map<string, LiveTurnState>
}

interface StructuredRunTurn {
  agent_id: string
  turn_id?: string
  status: "running" | "failed"
  error?: string
}

interface StructuredResultTurn {
  turn_id: string
  status: "running" | "completed" | "failed"
  response?: string
  error?: string
}

interface DomSnapshot {
  rawText: string
  codeBlocks: string[]
}

test(
  "live ChatGPT subagent preserves server response and reuses one conversation across two turns",
  { skip: !LIVE_TEST_ENABLED, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    const contextKey = `LIVE_CTX_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const longLine = `LONG_LINE:${"x".repeat(320)}`
    const firstPrompt = buildFixturePrompt(contextKey, longLine)
    const artifact: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      agent_id: LIVE_AGENT_ID,
      context_key: contextKey,
    }

    const module = new ChatGptSubagentModule({
      maxConcurrentAgents: 1,
      timeoutMs: 180_000,
    })

    t.after(async () => {
      await module.dispose().catch(() => undefined)
      await writeLiveArtifact(artifact).catch(() => undefined)
    })

    try {
      await module.connect()
    } catch (error) {
      throw new Error(
        `Live subagent test requires the authenticated ChatGPT Chrome instance at ${MCP_CONFIG.chatGpt.cdpEndpoint}. Start it with npm run chatgpt before running this test.`,
        { cause: error }
      )
    }

    const running = await startMcpHttpServer({
      port: 0,
      chatGptSubagents: module,
      toolOutputStructured: "optional",
    })
    t.after(() => running.close().catch(() => undefined))

    const client = new Client({ name: "live-subagent-integration-test", version: "1.0.0" })
    t.after(() => client.close().catch(() => undefined))
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))

    t.diagnostic("Chrome connected and local MCP test server started")

    const firstRun = await client.callTool({
      name: "subagent_run",
      arguments: {
        agents: [{ agent_id: LIVE_AGENT_ID, prompt: firstPrompt, oververbosity: 5 }],
        structured: true,
      },
    })
    const firstRunTurn = getRunTurn(firstRun.structuredContent)
    assert.equal(firstRunTurn.agent_id, LIVE_AGENT_ID)
    assert.equal(firstRunTurn.status, "running", firstRunTurn.error ?? "subagent_run did not start turn 1")
    assert.ok(firstRunTurn.turn_id)
    assert.match(firstRunTurn.turn_id, /_turn_1$/)
    t.diagnostic(`Turn 1 submitted: ${firstRunTurn.turn_id}`)

    const firstCompletion = await waitForCompletedTurn(client, firstRunTurn.turn_id)
    const firstResponse = firstCompletion.turn.response
    assert.ok(firstResponse)
    assertFixtureResponse(firstResponse, contextKey, longLine)
    t.diagnostic("Turn 1 completed with required Markdown/code fixture")

    const internals = module as unknown as LiveModuleInternals
    const firstState = requireLiveState(internals)
    const firstTurnState = requireTurnState(internals, firstRunTurn.turn_id)
    const firstConversationId = requireConversationId(firstState)
    assert.equal(firstTurnState.response, firstResponse)
    assert.equal(firstTurnState.status, "completed")

    const trackerResponse = trackedNetworkResponse(firstState, firstTurnState)
    assert.equal(trackerResponse, firstResponse, "network tracker must be the authoritative stored answer")
    t.diagnostic("Network tracker response exactly matches stored turn response")

    const firstPayload = await loadConversationPayload(firstState.page, firstConversationId, 30_000)
    const persistedFirstResponse = persistedServerResponse(firstPayload, firstTurnState)
    assert.equal(persistedFirstResponse, firstResponse, "persisted conversation JSON must match stored turn response exactly")
    assert.ok(rawServerContentParts(firstPayload).includes(firstResponse), "raw server content.parts must contain the exact stored response")
    t.diagnostic("Conversation JSON content.parts exactly matches stored turn response")

    const firstDomMessages = await readAssistantDomMessages(firstState.page)
    const firstDomSnapshot = await readLastAssistantDomSnapshot(firstState.page)
    assert.ok(firstDomMessages.at(-1)?.text.includes(contextKey), "rendered DOM should contain the fixture context key")
    assert.ok(firstDomSnapshot.codeBlocks.length >= 2, "fixture should render at least the Markdown and TypeScript fenced blocks")
    assert.ok(firstDomSnapshot.codeBlocks.some((block) => block.includes(contextKey)), "rendered code block should contain the context key")
    t.diagnostic("Rendered DOM contains both fenced-block content and context key")

    const firstCompact = await client.callTool({
      name: "subagent_result",
      arguments: { turn_ids: [firstRunTurn.turn_id] },
    })
    const firstCompactText = toolText(firstCompact.content)
    assert.ok(firstCompactText.includes("```md"))
    assert.ok(firstCompactText.includes("```ts"))
    assert.ok(firstCompactText.includes(contextKey))
    assert.ok(!firstCompactText.includes("\\n## Live Fixture"), "compact MCP output must contain real newlines, not JSON-escaped newlines")
    t.diagnostic("Compact MCP result preserves fenced Markdown/code without JSON escaping")

    const firstEventCount = [...firstCompletion.observedTexts, firstCompactText].filter((text) =>
      text.includes(`**agent_finished:** agent_id=${LIVE_AGENT_ID} turn_id=${firstRunTurn.turn_id}`)
    ).length
    assert.equal(firstEventCount, 1, "completion event must be delivered exactly once")
    t.diagnostic("Turn 1 completion event delivered exactly once")

    artifact.turn_1 = {
      turn_id: firstRunTurn.turn_id,
      server_response: firstResponse,
      tracker_response: trackerResponse,
      compact_mcp_output: firstCompactText,
      dom_text: firstDomSnapshot.rawText,
      dom_code_blocks: firstDomSnapshot.codeBlocks,
    }

    const secondPrompt = "Reply with only the exact CONTEXT_KEY value from your immediately previous response. No label, punctuation, explanation, or code fence."
    const secondRun = await client.callTool({
      name: "subagent_run",
      arguments: {
        agents: [{ agent_id: LIVE_AGENT_ID, prompt: secondPrompt, oververbosity: 5 }],
        structured: true,
      },
    })
    const secondRunTurn = getRunTurn(secondRun.structuredContent)
    assert.equal(secondRunTurn.agent_id, LIVE_AGENT_ID)
    assert.equal(secondRunTurn.status, "running", secondRunTurn.error ?? "subagent_run did not start turn 2")
    assert.ok(secondRunTurn.turn_id)
    assert.match(secondRunTurn.turn_id, /_turn_2$/)
    t.diagnostic(`Turn 2 submitted on same agent: ${secondRunTurn.turn_id}`)

    const secondCompletion = await waitForCompletedTurn(client, secondRunTurn.turn_id)
    const secondResponse = secondCompletion.turn.response?.trim()
    assert.equal(secondResponse, contextKey, "second turn must recover context that was only supplied in turn 1")

    const secondState = requireLiveState(internals)
    const secondTurnState = requireTurnState(internals, secondRunTurn.turn_id)
    assert.equal(requireConversationId(secondState), firstConversationId, "both turns must use the same ChatGPT conversation")
    assert.equal(secondState.turnCount, 2)
    assert.equal(trackedNetworkResponse(secondState, secondTurnState)?.trim(), contextKey)

    const secondPayload = await loadConversationPayload(secondState.page, firstConversationId, 30_000)
    const persistedSecondResponse = persistedServerResponse(secondPayload, secondTurnState)?.trim()
    assert.equal(persistedSecondResponse, contextKey)
    assert.ok(rawServerContentParts(secondPayload).some((part) => part.trim() === contextKey))
    t.diagnostic("Turn 2 reused the same conversation and recovered prior-turn context")

    const secondCompact = await client.callTool({
      name: "subagent_result",
      arguments: { turn_ids: [secondRunTurn.turn_id] },
    })
    const secondCompactText = toolText(secondCompact.content)
    assert.ok(secondCompactText.includes(contextKey))

    const secondEventCount = [...secondCompletion.observedTexts, secondCompactText].filter((text) =>
      text.includes(`**agent_finished:** agent_id=${LIVE_AGENT_ID} turn_id=${secondRunTurn.turn_id}`)
    ).length
    assert.equal(secondEventCount, 1, "turn 2 completion event must be delivered exactly once")

    artifact.turn_2 = {
      turn_id: secondRunTurn.turn_id,
      server_response: secondResponse,
      compact_mcp_output: secondCompactText,
      same_conversation_as_turn_1: true,
    }
    artifact.result = "pass"

    t.diagnostic("LIVE SUBAGENT INTEGRATION: PASS")
    t.diagnostic(`Sanitized evidence: ${join(new URL(ARTIFACT_DIR).pathname, "subagent-live-last.json")}`)
  }
)

function buildFixturePrompt(contextKey: string, longLine: string): string {
  return [
    "This is a live integration fixture. Do not use tools.",
    "Return one response containing every required marker and block below. Preserve the fenced block types. Do not wrap the entire response in another code fence.",
    "",
    "LIVE_SUBAGENT_FIXTURE_BEGIN",
    "",
    "## Live Fixture",
    "",
    "Paragraph with inline `code` and Unicode: café → ✓",
    "",
    "- alpha",
    "- beta",
    "",
    "```md",
    "### Nested Markdown",
    `CONTEXT_KEY: ${contextKey}`,
    "```",
    "",
    "```ts",
    "const answer: number = 42;",
    "```",
    "",
    "| key | value |",
    "| --- | --- |",
    "| fixture | ok |",
    "",
    longLine,
    "",
    "LIVE_SUBAGENT_FIXTURE_END",
  ].join("\n")
}

function assertFixtureResponse(response: string, contextKey: string, longLine: string): void {
  assert.ok(response.includes("LIVE_SUBAGENT_FIXTURE_BEGIN"))
  assert.ok(response.includes("LIVE_SUBAGENT_FIXTURE_END"))
  assert.ok(response.includes("## Live Fixture"))
  assert.ok(response.includes("inline `code`"))
  assert.ok(response.includes("café → ✓"))
  assert.ok(response.includes("```md"))
  assert.ok(response.includes(`CONTEXT_KEY: ${contextKey}`))
  assert.ok(response.includes("```ts"))
  assert.ok(response.includes("const answer: number = 42;"))
  assert.ok(response.includes("| fixture | ok |"))
  assert.ok(response.includes(longLine))
}

function getRunTurn(value: unknown): StructuredRunTurn {
  const record = asRecord(value)
  const turns = record?.turns
  assert.ok(Array.isArray(turns) && turns.length === 1, "subagent_run must return exactly one live turn")
  return turns[0] as StructuredRunTurn
}

async function waitForCompletedTurn(
  client: Client,
  turnId: string
): Promise<{ turn: StructuredResultTurn; observedTexts: string[] }> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS - 15_000
  const observedTexts: string[] = []

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await client.callTool({
      name: "subagent_result",
      arguments: {
        turn_ids: [turnId],
        wait_ms: Math.min(POLL_WAIT_MS, Math.max(0, remaining)),
        structured: true,
      },
    })
    observedTexts.push(toolText(result.content))

    const record = asRecord(result.structuredContent)
    const turns = record?.turns
    assert.ok(Array.isArray(turns) && turns.length === 1)
    const turn = turns[0] as StructuredResultTurn
    if (turn.status === "completed") return { turn, observedTexts }
    if (turn.status === "failed") throw new Error(`Live subagent turn failed: ${turn.error ?? turnId}`)
  }

  throw new Error(`Timed out waiting for live subagent turn ${turnId}`)
}

function requireLiveState(internals: LiveModuleInternals): LiveAgentState {
  const state = internals.agents.get(LIVE_AGENT_ID)
  assert.ok(state, "live agent state must still exist")
  return state
}

function requireTurnState(internals: LiveModuleInternals, turnId: string): LiveTurnState {
  const turn = internals.turns.get(turnId)
  assert.ok(turn, `missing live turn state ${turnId}`)
  assert.ok(turn.tracking, `missing tracking state for ${turnId}`)
  return turn
}

function requireConversationId(state: LiveAgentState): string {
  assert.ok(state.conversationId, "live subagent must bind a stable ChatGPT conversation ID")
  return state.conversationId
}

function trackedNetworkResponse(state: LiveAgentState, turn: LiveTurnState): string | undefined {
  assert.ok(turn.tracking)
  return state.tracker.findFinalResponse({
    baselineIds: turn.tracking.baselineNetworkIds,
    prompt: turn.tracking.prompt,
    sentAtSeconds: turn.tracking.sentAtSeconds,
  })?.message.text
}

function persistedServerResponse(payload: unknown, turn: LiveTurnState): string | undefined {
  assert.ok(turn.tracking)
  const messages = extractConversationMessages(payload)
  return findLatestAssistantAfterPrompt(messages, turn.tracking.prompt)?.text
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
      for (const part of content.parts) {
        if (typeof part === "string") found.push(part)
      }
    }
    for (const nested of Object.values(record)) visit(nested)
  }

  visit(value)
  return found
}

async function readLastAssistantDomSnapshot(page: Page): Promise<DomSnapshot> {
  const locator = page.locator('[data-message-author-role="assistant"]').last()
  assert.equal(await locator.count(), 1, "expected a rendered assistant message")
  return locator.evaluate((element) => ({
    rawText: (element.textContent ?? "").trim(),
    codeBlocks: Array.from(element.querySelectorAll("pre"))
      .map((pre) => {
        const codeMirrorLines = Array.from(pre.querySelectorAll(".cm-content .cm-line")).map((line) => line.textContent ?? "")
        if (codeMirrorLines.length > 0) return codeMirrorLines.join("\n")
        return (pre.textContent ?? "").trim()
      })
      .filter(Boolean),
  }))
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      const record = asRecord(item)
      return record?.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

async function writeLiveArtifact(artifact: Record<string, unknown>): Promise<void> {
  const directory = new URL(ARTIFACT_DIR)
  await mkdir(directory, { recursive: true })
  await writeFile(new URL("subagent-live-last.json", directory), `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
