import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Client, StreamableHTTPClientTransport, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"
import { UnhingedAgentAuthStore } from "../src/auth/auth.js"
import { MCP_CONFIG } from "../src/config.js"
import { countTokens } from "../src/tokenizer.js"
import type { ChatGptSubagentService } from "../src/tools/subagent/chatgpt-subagent-contracts.js"
import { FeedbackStore } from "../src/tools/feedback.js"
import { startMcpHttpServer as startMcpHttpServerRaw } from "../src/server/http-server.js"
import { McpAuditLogger } from "../src/server/audit-log.js"
import { PeekabooClient } from "../src/tools/computer/peekaboo.js"
import { PersistentShellSession } from "../src/tools/shell/session.js"
import { ShellSessionManager } from "../src/tools/shell/session-manager.js"
import { DEFAULT_WEB_OUTPUT_TOKENS, MAX_WEB_OUTPUT_TOKENS, WebPageOpener } from "../src/tools/web/web-open.js"
import { canonicalizeJsonSchema } from "../src/server/tool-registration-boundary.js"

function startMcpHttpServer(options: Parameters<typeof startMcpHttpServerRaw>[0] = {}) {
  return startMcpHttpServerRaw({ toolOutputStructured: "always", ...options })
}

test("serves shell tools through Streamable HTTP and retains state across MCP sessions", { timeout: 20_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())

  const first = await connectClient(running.url, "integration-client-1")

  const tools = await first.client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "shell_run",
      "shell_poll",
      "apply_patch",
      "shell_reset",
      "shell_list",
      "shell_close",
      "subagent_start",
      "subagent_result",
      "fetch_website",
      "skill_list",
      "skill_load",
      "computer_list",
      "computer_observe",
      "computer_inspect",
      "computer_click",
      "computer_type",
      "computer_press",
      "computer_hotkey",
      "computer_scroll",
      "computer_drag",
      "computer_app",
      "computer_window",
      "feedback_submit",
    ]
  )
  for (const tool of tools.tools) {
    assert.equal(JSON.stringify(tool.inputSchema), JSON.stringify(canonicalizeJsonSchema(tool.inputSchema)), `${tool.name} input schema order`)
    if (tool.outputSchema) {
      assert.equal(JSON.stringify(tool.outputSchema), JSON.stringify(canonicalizeJsonSchema(tool.outputSchema)), `${tool.name} output schema order`)
    }
  }
  const runTool = tools.tools.find((tool) => tool.name === "shell_run")
  assert.equal(runTool?.annotations, undefined)
  const shellIdSchema = (runTool?.inputSchema.properties as Record<string, Record<string, unknown>>).shell_id
  assert.ok(shellIdSchema)
  assert.deepEqual(Object.keys(shellIdSchema), ["description", "type", "default", "minLength", "maxLength"])
  assert.equal(shellIdSchema.default, "default")
  assert.equal(shellIdSchema.minLength, 3)
  assert.equal(shellIdSchema.maxLength, 64)
  const cwdSchema = (runTool?.inputSchema.properties as Record<string, Record<string, unknown>>).cwd
  assert.ok(cwdSchema)
  assert.equal(cwdSchema.minLength, 1)
  const maxOutputSchema = (runTool?.inputSchema.properties as Record<string, Record<string, unknown>>).max_output_tokens
  assert.ok(maxOutputSchema)
  assert.deepEqual(Object.keys(maxOutputSchema), ["description", "type", "default", "minimum", "maximum"])
  assert.equal(maxOutputSchema.minimum, 1)
  assert.equal(maxOutputSchema.default, MCP_CONFIG.shell.defaultOutputTokens)
  assert.equal(maxOutputSchema.maximum, MCP_CONFIG.shell.maxOutputTokens)
  const requestIdSchema = (runTool?.inputSchema.properties as Record<string, Record<string, unknown>>).request_id
  assert.ok(requestIdSchema)
  assert.equal(requestIdSchema.pattern, undefined)
  assert.equal(requestIdSchema.minLength, 3)
  assert.equal(requestIdSchema.maxLength, 128)
  const outputSchema = runTool?.outputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  assert.deepEqual(Object.keys(outputSchema.properties ?? {}).sort(), [
    "cursor_expired",
    "cwd",
    "dropped_output_bytes",
    "exit_code",
    "next_cursor",
    "output",
    "output_truncated",
    "request_id",
    "shell_id",
    "status",
  ])
  assert.deepEqual(outputSchema.required?.sort(), ["cwd", "output", "status"])
  const pollTool = tools.tools.find((tool) => tool.name === "shell_poll")
  const pollOutputSchema = pollTool?.outputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  assert.deepEqual(Object.keys(pollOutputSchema.properties ?? {}).sort(), ["dropped_output_bytes", "exit_code", "next_cursor", "output", "status"])
  assert.deepEqual(pollOutputSchema.required?.sort(), ["output", "status"])
  const applyPatchTool = tools.tools.find((tool) => tool.name === "apply_patch")
  assert.deepEqual(applyPatchTool?.annotations, { openWorldHint: false })
  const applyPatchInputSchema = applyPatchTool?.inputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  assert.deepEqual(Object.keys(applyPatchInputSchema.properties ?? {}).sort(), ["cwd", "patch"])
  assert.deepEqual(applyPatchInputSchema.required?.sort(), ["cwd", "patch"])
  const applyPatchOutputSchema = applyPatchTool?.outputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  assert.deepEqual(Object.keys(applyPatchOutputSchema.properties ?? {}).sort(), ["exit_code", "output", "output_dropped", "status"])
  assert.deepEqual(applyPatchOutputSchema.required?.sort(), ["exit_code", "status"])
  const shellListTool = tools.tools.find((tool) => tool.name === "shell_list")
  assert.deepEqual(shellListTool?.annotations, { readOnlyHint: true, openWorldHint: false })
  const shellCloseTool = tools.tools.find((tool) => tool.name === "shell_close")
  assert.deepEqual(shellCloseTool?.annotations, { openWorldHint: false })
  const closeShellIdSchema = (shellCloseTool?.inputSchema.properties as Record<string, Record<string, unknown>>).shell_id
  assert.ok(closeShellIdSchema)
  assert.equal(closeShellIdSchema.default, undefined)
  const fetchWebsiteTool = tools.tools.find((tool) => tool.name === "fetch_website")
  assert.deepEqual(fetchWebsiteTool?.annotations, { readOnlyHint: true })
  const webMaxOutputSchema = (fetchWebsiteTool?.inputSchema.properties as Record<string, Record<string, unknown>>).max_output_tokens
  assert.ok(webMaxOutputSchema)
  assert.deepEqual(Object.keys(webMaxOutputSchema), ["type", "default", "minimum", "maximum"])
  assert.equal(webMaxOutputSchema.minimum, 1)
  assert.equal(webMaxOutputSchema.default, DEFAULT_WEB_OUTPUT_TOKENS)
  assert.equal(webMaxOutputSchema.maximum, MAX_WEB_OUTPUT_TOKENS)
  const websiteFormatSchema = (fetchWebsiteTool?.inputSchema.properties as Record<string, Record<string, unknown>>).format
  assert.ok(websiteFormatSchema)
  assert.equal(websiteFormatSchema.default, "markdown")
  const fetchWebsiteOutputSchema = fetchWebsiteTool?.outputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  assert.deepEqual(Object.keys(fetchWebsiteOutputSchema.properties ?? {}).sort(), ["content", "dropped_source_bytes", "next_cursor", "title", "url"])
  assert.deepEqual(websiteFormatSchema.enum, ["markdown", "clean_html", "raw_html"])
  const skillListTool = tools.tools.find((tool) => tool.name === "skill_list")
  assert.deepEqual(skillListTool?.annotations, { readOnlyHint: true, openWorldHint: false })
  const skillLoadTool = tools.tools.find((tool) => tool.name === "skill_load")
  assert.deepEqual(skillLoadTool?.annotations, { readOnlyHint: true, openWorldHint: false })
  const skillLoadInputSchema = skillLoadTool?.inputSchema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  assert.deepEqual(Object.keys(skillLoadInputSchema.properties ?? {}), ["name"])
  assert.deepEqual(skillLoadInputSchema.required, ["name"])
  const skillLoadOutputSchema = skillLoadTool?.outputSchema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  assert.deepEqual(Object.keys(skillLoadOutputSchema.properties ?? {}), ["path", "instructions"])
  assert.deepEqual(skillLoadOutputSchema.required, ["path", "instructions"])
  const feedbackTool = tools.tools.find((tool) => tool.name === "feedback_submit")
  assert.deepEqual(feedbackTool?.annotations, { destructiveHint: false, openWorldHint: false })
  const feedbackInputSchema = feedbackTool?.inputSchema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  assert.deepEqual(Object.keys(feedbackInputSchema.properties ?? {}), ["feedback"])
  assert.deepEqual(feedbackInputSchema.required, ["feedback"])
  const subagentTool = tools.tools.find((tool) => tool.name === "subagent_start")
  assert.deepEqual(subagentTool?.annotations, { destructiveHint: false })
  const subagentInputSchema = subagentTool?.inputSchema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  assert.deepEqual(Object.keys(subagentInputSchema.properties ?? {}), ["agents"])
  assert.deepEqual(subagentInputSchema.required, ["agents"])
  const subagentAgentsSchema = subagentInputSchema.properties?.agents as {
    minItems?: number
    maxItems?: number
    items?: { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  }
  assert.equal(subagentAgentsSchema.minItems, 1)
  assert.equal(subagentAgentsSchema.maxItems, 3)
  assert.deepEqual(Object.keys(subagentAgentsSchema.items?.properties ?? {}).sort(), ["agent_id", "oververbosity", "prompt"])
  assert.deepEqual(subagentAgentsSchema.items?.required?.sort(), ["agent_id", "prompt"])
  assert.equal(subagentAgentsSchema.items?.properties?.agent_id?.maxLength, 64)
  assert.equal(subagentAgentsSchema.items?.properties?.oververbosity?.default, 2)
  assert.equal(subagentAgentsSchema.items?.properties?.oververbosity?.minimum, 1)
  assert.equal(subagentAgentsSchema.items?.properties?.oververbosity?.maximum, 5)
  const subagentOutputSchema = subagentTool?.outputSchema as {
    properties?: Record<string, Record<string, unknown>>
  }
  const subagentTurnsSchema = subagentOutputSchema.properties?.turns as {
    items?: { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  }
  assert.deepEqual(Object.keys(subagentTurnsSchema.items?.properties ?? {}).sort(), ["agent_id", "error", "status", "turn_id"])
  assert.deepEqual(subagentTurnsSchema.items?.required?.sort(), ["agent_id", "status"])
  const subagentPollTool = tools.tools.find((tool) => tool.name === "subagent_result")
  assert.deepEqual(subagentPollTool?.annotations, { readOnlyHint: true })
  const subagentPollInputSchema = subagentPollTool?.inputSchema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  const subagentPollOutputSchema = subagentPollTool?.outputSchema as {
    properties?: Record<string, Record<string, unknown>>
  }
  const subagentPollTurnsSchema = subagentPollOutputSchema.properties?.turns as {
    items?: { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  }
  assert.deepEqual(subagentPollTurnsSchema.items?.properties?.activity?.enum, ["Working", "Searching the web", "Using tools", "Generating response"])
  assert.equal(subagentPollTurnsSchema.items?.properties?.activity_age_ms?.type, "integer")
  assert.deepEqual(Object.keys(subagentPollTurnsSchema.items?.properties ?? {}).sort(), [
    "activity",
    "activity_age_ms",
    "error",
    "response",
    "status",
    "turn_id",
  ])
  assert.deepEqual(subagentPollTurnsSchema.items?.required?.sort(), ["status", "turn_id"])
  assert.deepEqual(Object.keys(subagentPollInputSchema.properties ?? {}).sort(), ["turn_ids", "wait_ms"])
  assert.deepEqual(subagentPollInputSchema.required?.sort(), ["turn_ids"])
  assert.equal(subagentPollInputSchema.properties?.turn_ids?.minItems, 1)
  assert.equal(subagentPollInputSchema.properties?.turn_ids?.maxItems, 3)
  assert.equal(subagentPollInputSchema.properties?.wait_ms?.default, 0)
  assert.equal(subagentPollInputSchema.properties?.wait_ms?.maximum, 60_000)

  const firstResult = await callUntilComplete(first.client, "mcp001", ["cd /tmp", "export MCP_HTTP_RETAINED=yes", "printf initialized"].join("; "))
  assert.equal(firstResult.output, "initialized")
  assert.equal(firstResult.exit_code, 0)
  assert.equal(firstResult.cwd, "/tmp")
  assert.deepEqual(Object.keys(firstResult).sort(), ["cwd", "exit_code", "output", "status"])

  await first.client.close()

  const second = await connectClient(running.url, "integration-client-2")
  t.after(() => second.client.close())
  const secondResult = await callUntilComplete(second.client, "MCP-State-2", `printf '%s|%s' "$PWD" "$MCP_HTTP_RETAINED"`)
  assert.equal(secondResult.output, "/tmp|yes")
  assert.equal(secondResult.exit_code, 0)
  assert.equal(secondResult.cwd, "/tmp")

  const expectedPagedOutput = "🙂".repeat(1_500)
  const pagedResult = await callUntilComplete(
    second.client,
    "page01",
    `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(expectedPagedOutput)})`)}`
  )
  assert.equal(pagedResult.output, expectedPagedOutput)
  assert.equal(Buffer.byteLength(pagedResult.output, "utf8"), 6_000)

  const parallelResult = await callUntilComplete(second.client, "parallel-http", ["*** Run: .", "printf first", "*** Run: /tmp", "false"].join("\n"))
  assert.equal(parallelResult.status, "completed")
  assert.equal(parallelResult.exit_code, 1)
  assert.equal("commands" in parallelResult, false)
  assert.match(parallelResult.output, /\[run 1 path="\." exit=0\]\nfirst/)
  assert.match(parallelResult.output, /\[run 2 path="\/tmp" exit=1\]/)
})

test("lists and loads dynamic workspace skills through MCP", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-skill-integration-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const skillDirectory = join(workspace, "skills", "create-wiki")
  await mkdir(skillDirectory, { recursive: true })
  const content = "---\nname: create-wiki\ndescription: Create a project wiki.\n---\n\n# Create Wiki\n"
  await writeFile(join(skillDirectory, "SKILL.md"), content)

  const running = await startMcpHttpServer({
    port: 0,
    shellManager: new ShellSessionManager({ defaultShell: new PersistentShellSession({ cwd: workspace }) }),
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "skill-integration-client")
  t.after(() => connected.client.close())

  const listed = await connected.client.callTool({
    name: "skill_list",
    arguments: {},
  })
  assert.deepEqual(listed.structuredContent, {
    skills: [
      {
        name: "create-wiki",
        description: "Create a project wiki.",
      },
    ],
  })

  const loaded = await connected.client.callTool({
    name: "skill_load",
    arguments: { name: "create-wiki" },
  })
  assert.deepEqual(loaded.structuredContent, {
    path: join(skillDirectory, "SKILL.md"),
    instructions: content,
  })
})

test("supports always, optional, and never model-facing tool output modes", { timeout: 20_000 }, async () => {
  for (const mode of ["always", "optional", "never"] as const) {
    const running = await startMcpHttpServer({ port: 0, toolOutputStructured: mode })
    const connected = await connectClient(running.url, `tool-output-${mode}`)
    try {
      const tools = await connected.client.listTools()
      const shellList = tools.tools.find((tool) => tool.name === "shell_list")
      assert.ok(shellList)
      const properties = shellList.inputSchema.properties as Record<string, Record<string, unknown>>
      const computerList = tools.tools.find((tool) => tool.name === "computer_list")
      const computerProperties = computerList?.inputSchema.properties as Record<string, Record<string, unknown>>

      assert.equal("structured" in computerProperties, false)
      if (mode === "always") {
        assert.ok(shellList.outputSchema)
        assert.equal("structured" in properties, false)
      } else {
        assert.equal(shellList.outputSchema, undefined)
        assert.equal("structured" in properties, mode === "optional")
        if (mode === "optional") assert.equal(properties.structured?.default, false)
      }

      const compact = await connected.client.callTool({ name: "shell_list", arguments: {} })
      if (mode === "always") {
        assert.ok(compact.structuredContent)
      } else {
        assert.equal(compact.structuredContent, undefined)
        const text = compact.content.find((item) => item.type === "text")
        assert.ok(text?.type === "text")
        assert.match(text.text, /count=\d+ limit=\d+ idle_timeout_ms=\d+/)
        assert.match(text.text, /shells:/)
      }

      if (mode === "optional") {
        const structured = await connected.client.callTool({ name: "shell_list", arguments: { structured: true } })
        assert.ok(structured.structuredContent)
      }
    } finally {
      await connected.client.close()
      await running.close()
    }
  }
})

test("appends pending subagent completion events to the next tool result exactly once", { timeout: 10_000 }, async (t) => {
  const events = ["agent_finished:reviewer:reviewer_turn_1"]
  const chatGptSubagents: ChatGptSubagentService = {
    async ask() {
      throw new Error("unused")
    },
    async poll() {
      throw new Error("unused")
    },
    drainEvents() {
      return events.splice(0)
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({ port: 0, chatGptSubagents, toolOutputStructured: "never" })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "subagent-event-client")
  t.after(() => connected.client.close())

  const first = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const firstText = first.content.find((item) => item.type === "text")
  assert.ok(firstText?.type === "text")
  assert.match(firstText.text, /agent_finished:reviewer:reviewer_turn_1/)

  const second = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const secondText = second.content.find((item) => item.type === "text")
  assert.ok(secondText?.type === "text")
  assert.doesNotMatch(secondText.text, /agent_finished:/)
})

test("returns the actual subagent answer through compact subagent_result content", { timeout: 10_000 }, async (t) => {
  const chatGptSubagents: ChatGptSubagentService = {
    async ask() {
      throw new Error("unused")
    },
    async poll(turnId) {
      return {
        agentId: "reviewer",
        turnId,
        status: "completed",
        response: "Use the shared registration boundary.",
      }
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({ port: 0, chatGptSubagents, toolOutputStructured: "never" })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "compact-subagent-result-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["reviewer_turn_1"] },
  })
  assert.equal(result.structuredContent, undefined)
  const text = result.content.find((item) => item.type === "text")
  assert.ok(text?.type === "text")
  assert.match(text.text, /turn_id=reviewer_turn_1 status=completed response="Use the shared registration boundary\."/)
})

test("logs output tokens from the final compact model-facing result", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-compact-audit-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const auditPath = join(root, "agent-commands.yaml")
  const running = await startMcpHttpServer({
    port: 0,
    auditLogger: new McpAuditLogger(auditPath),
    toolOutputStructured: "never",
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "compact-audit-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
  const text = result.content.find((item) => item.type === "text")
  assert.ok(text?.type === "text")
  const log = await readFile(auditPath, "utf8")
  assert.match(log, new RegExp(`shell_list - \\d+ms - ${countTokens("{}")} in / ${countTokens(text.text)} out`))
})

test("records agent feedback through MCP", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-feedback-integration-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const feedbackPath = join(workspace, "agent-feedback.jsonl")
  const feedbackStore = new FeedbackStore({
    path: feedbackPath,
    now: () => new Date("2026-08-09T22:00:00.000Z"),
    createId: () => "fb_test",
  })

  const running = await startMcpHttpServer({
    port: 0,
    shellManager: new ShellSessionManager({ defaultShell: new PersistentShellSession({ cwd: workspace }) }),
    feedbackStore,
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "feedback-integration-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "feedback_submit",
    arguments: {
      feedback: "## Result feedback\n\n`subagent_result` should make progress easier to distinguish from a stalled turn.",
    },
  })

  assert.deepEqual(result.structuredContent, {
    id: "fb_test",
    created_at: "2026-08-09T22:00:00.000Z",
  })
  assert.deepEqual(JSON.parse((await readFile(feedbackPath, "utf8")).trim()), {
    id: "fb_test",
    created_at: "2026-08-09T22:00:00.000Z",
    feedback: "## Result feedback\n\n`subagent_result` should make progress easier to distinguish from a stalled turn.",
  })
})

test("starts staggered subagents and polls turns concurrently across stateless MCP requests", { timeout: 25_000 }, async (t) => {
  const turns = new Map<string, string[]>()
  const completed = new Map<string, { agentId: string; response: string }>()
  const starts: Array<{ agentId: string; at: number }> = []
  let activePolls = 0
  let maxActivePolls = 0
  const chatGptSubagents: ChatGptSubagentService = {
    async ask({ agentId, prompt }) {
      if (agentId === "unavailable-agent") throw new Error("browser unavailable")
      starts.push({ agentId, at: Date.now() })
      const history = turns.get(agentId) ?? []
      history.push(prompt)
      turns.set(agentId, history)
      const turnId = `turn-${agentId}-${history.length}`
      completed.set(turnId, {
        agentId,
        response: `${agentId}:${history.length}:${prompt}`,
      })
      return {
        agentId,
        turnId,
        status: "running",
        submitted: true,
        conversationUrl: `https://chatgpt.com/c/fake-${agentId}`,
      }
    },
    async poll(turnId) {
      activePolls += 1
      maxActivePolls = Math.max(maxActivePolls, activePolls)
      try {
        await new Promise((resolve) => setTimeout(resolve, 25))
        if (turnId === "heartbeat-fixture") {
          return {
            agentId: "heartbeat-agent",
            turnId,
            status: "running",
            activity: "Searching the web",
            activityAgeMs: 2_750,
          }
        }
        const result = completed.get(turnId)
        if (!result) throw new Error(`unknown turn ${turnId}`)
        return {
          agentId: result.agentId,
          turnId,
          status: "completed",
          conversationUrl: `https://chatgpt.com/c/fake-${result.agentId}`,
          response: result.response,
        }
      } finally {
        activePolls -= 1
      }
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({
    port: 0,
    chatGptSubagents,
  })
  t.after(() => running.close())

  const first = await connectClient(running.url, "subagent-client-1")
  const firstResult = await first.client.callTool({
    name: "subagent_start",
    arguments: {
      agents: [
        { agent_id: " architecture-reviewer ", prompt: "Review the architecture." },
        { agent_id: "test-reviewer", prompt: "Review the tests." },
        { agent_id: "simplifier", prompt: "Find the simplest implementation." },
      ],
    },
  })
  assert.deepEqual(firstResult.structuredContent, {
    turns: [
      {
        agent_id: "architecture-reviewer",
        turn_id: "turn-architecture-reviewer-1",
        status: "running",
      },
      {
        agent_id: "test-reviewer",
        turn_id: "turn-test-reviewer-1",
        status: "running",
      },
      {
        agent_id: "simplifier",
        turn_id: "turn-simplifier-1",
        status: "running",
      },
    ],
  })
  assert.deepEqual(firstResult.content, [{ type: "text", text: "Submitted 3 ChatGPT subagent turns." }])
  assert.equal(starts.length, 3)
  assert.ok(starts[1]!.at - starts[0]!.at >= 4_500)
  assert.ok(starts[2]!.at - starts[1]!.at >= 6_500)

  const failedStart = await first.client.callTool({
    name: "subagent_start",
    arguments: { agents: [{ agent_id: "unavailable-agent", prompt: "Try to start." }] },
  })
  assert.deepEqual(failedStart.content, [{ type: "text", text: "Submitted 1 ChatGPT subagent turn." }])
  assert.deepEqual(failedStart.structuredContent, {
    turns: [{ agent_id: "unavailable-agent", status: "failed", error: "subagent_failed: browser unavailable" }],
  })
  await first.client.close()

  const second = await connectClient(running.url, "subagent-client-2")
  t.after(() => second.client.close())
  const batchPoll = await second.client.callTool({
    name: "subagent_result",
    arguments: {
      turn_ids: ["turn-architecture-reviewer-1", "turn-test-reviewer-1", "turn-simplifier-1"],
      wait_ms: 0,
    },
  })
  assert.deepEqual(batchPoll.structuredContent, {
    turns: [
      {
        turn_id: "turn-architecture-reviewer-1",
        status: "completed",
        response: "architecture-reviewer:1:Review the architecture.",
      },
      {
        turn_id: "turn-test-reviewer-1",
        status: "completed",
        response: "test-reviewer:1:Review the tests.",
      },
      {
        turn_id: "turn-simplifier-1",
        status: "completed",
        response: "simplifier:1:Find the simplest implementation.",
      },
    ],
  })
  assert.deepEqual(batchPoll.content, [{ type: "text", text: "Retrieved 3 ChatGPT subagent turn results." }])
  assert.equal(maxActivePolls, 3)

  const partialFailurePoll = await second.client.callTool({
    name: "subagent_result",
    arguments: {
      turn_ids: ["turn-architecture-reviewer-1", "missing-turn", "turn-simplifier-1"],
      wait_ms: 0,
    },
  })
  assert.equal(partialFailurePoll.isError, undefined)
  assert.deepEqual(partialFailurePoll.structuredContent, {
    turns: [
      {
        turn_id: "turn-architecture-reviewer-1",
        status: "completed",
        response: "architecture-reviewer:1:Review the architecture.",
      },
      {
        turn_id: "missing-turn",
        status: "failed",
        error: "subagent_failed: unknown turn missing-turn",
      },
      {
        turn_id: "turn-simplifier-1",
        status: "completed",
        response: "simplifier:1:Find the simplest implementation.",
      },
    ],
  })

  const heartbeatPoll = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["heartbeat-fixture"] },
  })
  assert.deepEqual(heartbeatPoll.structuredContent, {
    turns: [
      {
        turn_id: "heartbeat-fixture",
        status: "running",
        activity: "Searching the web",
        activity_age_ms: 2_750,
      },
    ],
  })
  const secondResult = await second.client.callTool({
    name: "subagent_start",
    arguments: {
      agents: [{ agent_id: "architecture-reviewer", prompt: "Now critique your answer." }],
    },
  })
  assert.deepEqual(secondResult.structuredContent, {
    turns: [
      {
        agent_id: "architecture-reviewer",
        turn_id: "turn-architecture-reviewer-2",
        status: "running",
      },
    ],
  })
  const secondPoll = await second.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["turn-architecture-reviewer-2"] },
  })
  assert.deepEqual(secondPoll.structuredContent, {
    turns: [
      {
        turn_id: "turn-architecture-reviewer-2",
        status: "completed",
        response: "architecture-reviewer:2:Now critique your answer.",
      },
    ],
  })
})

test("audits tool calls at the HTTP MCP boundary", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-audit-integration-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const auditPath = join(root, "agent-commands.yaml")
  const auditLogger = new McpAuditLogger(auditPath)
  const chatGptSubagents: ChatGptSubagentService = {
    async ask({ agentId }) {
      return {
        agentId,
        turnId: `turn-${agentId}`,
        status: "running",
        submitted: true,
        conversationUrl: `https://chatgpt.com/c/fake-${agentId}`,
      }
    },
    async poll(turnId) {
      return {
        agentId: "audit-check",
        turnId,
        status: "completed",
        response: "fake:Inspect the audit path.",
      }
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({
    port: 0,
    auditLogger,
    chatGptSubagents,
  })
  t.after(() => running.close())

  const connected = await connectClient(running.url, "audit-integration-client")
  t.after(() => connected.client.close())
  await connected.client.callTool({
    name: "shell_list",
    arguments: {},
  })
  await connected.client.callTool({
    name: "subagent_start",
    arguments: {
      agents: [{ agent_id: "audit-check", prompt: "Inspect the audit path." }],
    },
  })

  const log = await readFile(auditPath, "utf8")
  assert.match(log, /--- # \d{2}:\d{2}:\d{2} - shell_list - \d+ms - \d+ in \/ \d+ out\nargs: \{\}/)
  assert.match(
    log,
    /--- # \d{2}:\d{2}:\d{2} - subagent_start - \d+ms - \d+ in \/ \d+ out\nargs: \{"agents":\[\{"agent_id":"audit-check","prompt":"Inspect the audit path\."\}\]\}/
  )
})

test("exposes a stable Peekaboo Computer Use surface and preserves semantic errors", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-mcp-integration-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/fake-peekaboo.mjs")
  const peekaboo = new PeekabooClient({
    executable: process.execPath,
    baseArgs: [fixture],
    env: {
      ...process.env,
      FAKE_PEEKABOO_FAIL_COMMAND: "app",
      FAKE_PEEKABOO_FAIL_SUBCOMMAND: "switch",
      FAKE_PEEKABOO_LOG: join(root, "peekaboo.jsonl"),
    },
    timeoutMs: 2_000,
  })
  const running = await startMcpHttpServer({
    port: 0,
    peekaboo,
  })
  t.after(() => running.close())

  const connected = await connectClient(running.url, "computer-use-integration-client")
  t.after(() => connected.client.close())

  const tools = await connected.client.listTools()
  const computerTools = tools.tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("computer_"))
    .sort()
  assert.deepEqual(computerTools, [
    "computer_app",
    "computer_click",
    "computer_drag",
    "computer_hotkey",
    "computer_inspect",
    "computer_list",
    "computer_observe",
    "computer_press",
    "computer_scroll",
    "computer_type",
    "computer_window",
  ])

  const state = await connected.client.callTool({
    name: "computer_observe",
    arguments: { app: "Finder" },
  })
  assert.equal(state.isError, undefined)
  assert.ok(Array.isArray(state.content))
  assert.deepEqual(
    state.content.map((block) => block.type),
    ["text", "image"]
  )
  assert.equal(state.content[0]?.type, "text")
  assert.equal(state.content[0]?.type === "text" ? state.content[0].text : undefined, "Observed computer.")
  assert.equal(state.content[1]?.type, "image")
  assert.equal(state.content[1]?.type === "image" ? state.content[1].mimeType : undefined, "image/jpeg")
  assert.ok(state.content[1]?.type === "image" && state.content[1].data.length > 0)
  assert.deepEqual(state.structuredContent, { snapshot_id: "snapshot-42" })

  const inspection = await connected.client.callTool({
    name: "computer_inspect",
    arguments: {
      snapshot_id: "snapshot-42",
      max_depth: 4,
      max_elements: 20,
      max_children: 10,
    },
  })
  assert.equal(inspection.isError, undefined)
  assert.deepEqual(inspection.content, [{ type: "text", text: '[B1] button "Continue"' }])
  assert.equal(inspection.structuredContent, undefined)

  const invalidClick = await connected.client.callTool({
    name: "computer_click",
    arguments: { element_id: "B1" },
  })
  assert.equal(invalidClick.isError, true)
  assert.match(JSON.stringify(invalidClick.content), /snapshot_id/)

  const click = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-42", element_id: "B1" },
  })
  assert.equal(click.isError, undefined)
  assert.deepEqual(click.content, [{ type: "text", text: "click:ok" }])
  assert.deepEqual(click.structuredContent, {
    command: "click",
    args: ["click", "--on", "B1", "--snapshot", "snapshot-42", "--json"],
  })

  const windowCoordinateClick = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-42", x: 10, y: 20 },
  })
  assert.deepEqual(windowCoordinateClick.structuredContent, {
    command: "click",
    args: ["click", "--coords", "10,20", "--window-id", "4242", "--json"],
  })

  const windowCoordinateDrag = await connected.client.callTool({
    name: "computer_drag",
    arguments: {
      snapshot_id: "snapshot-42",
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
    },
  })
  assert.deepEqual(windowCoordinateDrag.structuredContent, {
    command: "drag",
    args: ["drag", "--snapshot", "snapshot-42", "--from-coords", "60,95", "--to-coords", "80,115", "--window-id", "4242", "--json"],
  })

  const screenState = await connected.client.callTool({
    name: "computer_observe",
    arguments: { screen_index: 1 },
  })
  assert.deepEqual(screenState.structuredContent, {
    snapshot_id: "snapshot-screen",
  })
  const screenCoordinateClick = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-screen", x: 10, y: 20 },
  })
  assert.deepEqual(screenCoordinateClick.structuredContent, {
    command: "click",
    args: ["click", "--coords", "1090,1620", "--global-coords", "--foreground", "--json"],
  })

  const forwardingCases = [
    {
      name: "computer_list",
      arguments: { kind: "apps", include_hidden: true },
      expected: ["app", "list", "--include-hidden", "--json"],
    },
    {
      name: "computer_type",
      arguments: {
        snapshot_id: "snapshot-42",
        text: "hello",
        clear: true,
        press_return: true,
        foreground: true,
        delay_ms: 5,
      },
      expected: ["type", "--text", "hello", "--snapshot", "snapshot-42", "--clear", "--return", "--foreground", "--delay", "5", "--json"],
    },
    {
      name: "computer_press",
      arguments: { window_id: 4242, keys: ["tab", "return"], count: 2 },
      expected: ["press", "tab", "return", "--window-id", "4242", "--count", "2", "--json"],
    },
    {
      name: "computer_hotkey",
      arguments: { app: "Finder", keys: ["cmd", "shift", "g"] },
      expected: ["hotkey", "--keys", "cmd,shift,g", "--app", "Finder", "--json"],
    },
    {
      name: "computer_scroll",
      arguments: {
        snapshot_id: "snapshot-42",
        element_id: "B1",
        direction: "down",
        amount: 3,
        smooth: true,
      },
      expected: ["scroll", "--direction", "down", "--amount", "3", "--on", "B1", "--snapshot", "snapshot-42", "--smooth", "--json"],
    },
    {
      name: "computer_app",
      arguments: {
        action: "launch",
        app: "TextEdit",
        open: ["/tmp/note.txt"],
      },
      expected: ["app", "launch", "TextEdit", "--wait-until-ready", "--open", "/tmp/note.txt", "--json"],
    },
    {
      name: "computer_window",
      arguments: {
        action: "set_bounds",
        window_id: 4242,
        x: 10,
        y: 20,
        width: 800,
        height: 600,
      },
      expected: ["window", "set-bounds", "--window-id", "4242", "--x", "10", "--y", "20", "--width", "800", "--height", "600", "--json"],
    },
  ] as const
  for (const forwarding of forwardingCases) {
    const result = await connected.client.callTool({
      name: forwarding.name,
      arguments: forwarding.arguments,
    })
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.structuredContent, {
      command: forwarding.expected[0],
      args: [...forwarding.expected],
    })
  }

  for (const argumentsValue of [
    { action: "move", window_id: 4242, x: 10.5, y: 20 },
    { action: "focus", window_id: 4242, width: 800 },
  ]) {
    const invalidWindow = await connected.client.callTool({
      name: "computer_window",
      arguments: argumentsValue,
    })
    assert.equal(invalidWindow.isError, true)
  }

  const failedApp = await connected.client.callTool({
    name: "computer_app",
    arguments: { action: "switch", app: "Finder" },
  })
  assert.equal(failedApp.isError, true)
  assert.deepEqual(failedApp.content, [
    {
      type: "text",
      text: "FAKE_COMMAND_FAILED: Fake Peekaboo failure for app (fixture requested failure)",
    },
  ])

  const toolsAfterFailure = await connected.client.listTools()
  assert.deepEqual(
    toolsAfterFailure.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("computer_"))
      .sort(),
    computerTools
  )
})

test("continues serving an existing client after a stateless HTTP server restart", { timeout: 20_000 }, async (t) => {
  const firstServer = await startMcpHttpServer({ port: 0 })
  const { port, url } = firstServer
  const connection = await connectClient(url, "restart-client")

  let activeServer = firstServer
  t.after(async () => {
    await connection.client.close()
    await activeServer.close()
  })

  const beforeRestart = await callUntilComplete(connection.client, "before-restart", "printf before")
  assert.equal(beforeRestart.output, "before")

  await firstServer.close()
  activeServer = await startMcpHttpServer({ port })

  const afterRestart = await callUntilComplete(connection.client, "after-restart", "printf after")
  assert.equal(afterRestart.output, "after")
  assert.equal(afterRestart.exit_code, 0)
})

test("reports an expired shell_poll cursor as a tool error", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-expired-poll-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const shell = new PersistentShellSession({ cwd: workspace, transcriptLimit: 1 })
  const running = await startMcpHttpServer({
    port: 0,
    shellManager: new ShellSessionManager({
      defaultShell: shell,
    }),
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "expired-poll-client")
  t.after(() => connected.client.close())

  const started = snapshotFromResult(
    await connected.client.callTool({
      name: "shell_run",
      arguments: {
        request_id: "expires",
        command: "sleep 0.1; printf AB",
        wait_ms: 0,
      },
    })
  )
  assert.equal(started.status, "running")
  assert.notEqual(started.next_cursor, undefined)

  for (let attempt = 0; attempt < 100 && shell.hasActiveWork; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(shell.hasActiveWork, false, "command did not complete before expired-cursor assertion")

  const expired = await connected.client.callTool({
    name: "shell_poll",
    arguments: {
      request_id: "expires",
      cursor: started.next_cursor,
      wait_ms: 0,
    },
  })
  assert.equal(expired.isError, true)
  assert.equal(expired.structuredContent, undefined)
  assert.match(JSON.stringify(expired.content), /cursor_expired/)
})

test("fetches and paginates one cached website across MCP sessions", { timeout: 20_000 }, async (t) => {
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
  const running = await startMcpHttpServer({
    port: 0,
    webPageOpener,
  })
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
  const firstContent = firstResult.structuredContent as {
    url: string
    title: string
    content: string
    next_cursor?: string
  }
  assert.equal(firstContent.url, "https://example.com/final")
  assert.equal(firstContent.title, "Example page")
  assert.deepEqual(Object.keys(firstContent).sort(), ["content", "next_cursor", "title", "url"])
  assert.ok(countTokens(firstContent.content) <= 64)
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
  const secondContent = secondResult.structuredContent as {
    content: string
    next_cursor?: string
  }
  assert.equal(firstContent.content + secondContent.content, expected)
  assert.equal(secondContent.next_cursor, undefined)
  assert.equal(renders, 1)
})

test("isolates named shell state and allows foreground commands in parallel", { timeout: 20_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "named-shell-client")
  t.after(() => connected.client.close())

  const explicitCwd = await mkdtemp(join(tmpdir(), "mcp-explicit-cwd-"))
  t.after(() => rm(explicitCwd, { recursive: true, force: true }))

  const explicitResult = snapshotFromResult(
    await connected.client.callTool({
      name: "shell_run",
      arguments: {
        shell_id: "cwd-shell",
        request_id: "cwd001",
        cwd: explicitCwd,
        command: "printf '%s' \"$PWD\"",
        wait_ms: 1_000,
      },
    })
  )
  assert.equal(explicitResult.status, "completed")
  assert.equal(explicitResult.output, explicitCwd)
  assert.equal(explicitResult.cwd, explicitCwd)

  const retainedCwd = await callUntilComplete(connected.client, "cwd002", "printf '%s' \"$PWD\"", "cwd-shell")
  assert.equal(retainedCwd.output, explicitCwd)
  assert.equal(retainedCwd.cwd, explicitCwd)

  const closedCwdShell = await connected.client.callTool({
    name: "shell_close",
    arguments: { shell_id: "cwd-shell" },
  })
  assert.equal(closedCwdShell.isError, undefined)

  const alphaState = await callUntilComplete(connected.client, "shared-request", "cd /tmp && export NAMED_STATE=alpha && printf alpha-ready", "alpha")
  const betaState = await callUntilComplete(connected.client, "shared-request", `printf '%s|%s' "$PWD" "\${NAMED_STATE-unset}"`, "beta")
  assert.equal(alphaState.output, "alpha-ready")
  assert.equal(alphaState.shell_id, "alpha")
  assert.match(betaState.output, /\|unset$/)
  assert.equal(betaState.shell_id, "beta")

  const slowAlpha = connected.client.callTool({
    name: "shell_run",
    arguments: {
      shell_id: "alpha",
      request_id: "slow01",
      command: "sleep 0.3; printf alpha-done",
      wait_ms: 0,
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 25))

  const betaWhileAlphaRuns = await callUntilComplete(connected.client, "parallel", "printf beta-done", "beta")
  assert.equal(betaWhileAlphaRuns.output, "beta-done")

  const alphaBusy = await connected.client.callTool({
    name: "shell_run",
    arguments: {
      shell_id: "alpha",
      request_id: "blocked",
      command: "printf should-not-run",
    },
  })
  assert.equal(alphaBusy.isError, true)
  assert.match(JSON.stringify(alphaBusy.content), /busy/)

  let alphaSnapshot = snapshotFromResult(await slowAlpha)
  assert.equal(alphaSnapshot.shell_id, "alpha")
  let alphaOutput = alphaSnapshot.output
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (alphaSnapshot.status !== "running" && alphaSnapshot.next_cursor === undefined) break
    assert.notEqual(alphaSnapshot.next_cursor, undefined)
    alphaSnapshot = snapshotFromResult(
      await connected.client.callTool({
        name: "shell_poll",
        arguments: {
          shell_id: "alpha",
          request_id: "slow01",
          cursor: alphaSnapshot.next_cursor,
          wait_ms: 100,
        },
      })
    )
    alphaOutput += alphaSnapshot.output
  }
  assert.equal(alphaSnapshot.status, "completed")
  assert.equal(alphaOutput, "alpha-done")

  await connected.client.callTool({
    name: "shell_reset",
    arguments: {
      shell_id: "alpha",
      request_id: "reset1",
      reason: "test reset isolation",
    },
  })
  const betaAfterReset = await callUntilComplete(connected.client, "after-reset", "printf beta-still-ready", "beta")
  assert.equal(betaAfterReset.output, "beta-still-ready")

  const listed = await connected.client.callTool({ name: "shell_list" })
  assert.equal(listed.isError, undefined)
  const listedContent = listed.structuredContent as {
    shells: Array<{
      shell_id: string
      status: "idle" | "active"
      is_default: boolean
      can_close: boolean
      idle_ms: number
    }>
    count: number
    limit: number
    idle_timeout_ms: number
  }
  assert.deepEqual(
    listedContent.shells.map((shell) => shell.shell_id),
    ["default", "alpha", "beta"]
  )
  assert.equal(listedContent.count, 3)
  assert.equal(listedContent.limit, 8)
  assert.equal(listedContent.idle_timeout_ms, 1_800_000)
  const defaultShell = listedContent.shells.find((shell) => shell.shell_id === "default")
  assert.ok(defaultShell)
  assert.deepEqual(defaultShell, {
    shell_id: "default",
    status: "idle",
    is_default: true,
    can_close: false,
    idle_ms: defaultShell.idle_ms,
  })

  const closed = await connected.client.callTool({
    name: "shell_close",
    arguments: { shell_id: "alpha" },
  })
  assert.equal(closed.isError, undefined)
  assert.deepEqual(closed.structuredContent, {
    shell_id: "alpha",
    closed: true,
  })

  const closeDefault = await connected.client.callTool({
    name: "shell_close",
    arguments: { shell_id: "default" },
  })
  assert.equal(closeDefault.isError, true)
  assert.match(JSON.stringify(closeDefault.content), /protected_shell/)
  assert.match(JSON.stringify(closeDefault.content), /shell_reset/)

  const resetDefault = await connected.client.callTool({
    name: "shell_reset",
    arguments: {
      shell_id: "default",
      request_id: "default-reset",
      reason: "prove protected shell remains resettable",
    },
  })
  assert.equal(resetDefault.isError, undefined)
  assert.equal((resetDefault.structuredContent as { status: string }).status, "ready")

  const afterClose = await connected.client.callTool({ name: "shell_list" })
  assert.deepEqual(
    (
      afterClose.structuredContent as {
        shells: Array<{ shell_id: string }>
      }
    ).shells.map((shell) => shell.shell_id),
    ["default", "beta"]
  )
})

test("applies patches through the native MCP tool", { timeout: 20_000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-native-patch-")))
  const project = join(directory, "project with ' quote")
  const bin = join(directory, "bin")
  const auditPath = join(directory, "agent-commands.yaml")
  await mkdir(project, { recursive: true })
  await mkdir(bin, { recursive: true })
  const executable = join(bin, "apply_patch")
  await writeFile(
    executable,
    '#!/bin/sh\npatch=$(cat)\ncase "$patch" in *SLOW_PATCH*) sleep 0.2 ;; *FAIL_PATCH*) printf \'%020000d\' 0 >&2; exit 9 ;; esac\nprintf \'cwd=%s\\n%s\' "$PWD" "$patch"\n'
  )
  await chmod(executable, 0o755)

  const shell = new PersistentShellSession({ cwd: directory })
  const running = await startMcpHttpServer({
    port: 0,
    shellManager: new ShellSessionManager({ defaultShell: shell }),
    applyPatchExecutable: executable,
    auditLogger: new McpAuditLogger(auditPath),
  })
  t.after(async () => {
    await running.close()
    await rm(directory, { recursive: true, force: true })
  })
  const connected = await connectClient(running.url, "native-patch-client")
  t.after(() => connected.client.close())

  const patch = ["*** Begin Patch", "*** Add File: example.txt", "+literal $() `ticks` 'quotes'", "+__MCP_PATCH_not_the_random_token__", "*** End Patch"].join(
    "\n"
  )
  const result = await connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: project, patch },
  })
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent, {
    status: "completed",
    exit_code: 0,
  })
  assert.doesNotMatch(JSON.stringify(result.content), /literal \$\(\)/)
  assert.match(JSON.stringify(result.content), /apply_patch completed, exit=0/)
  assert.doesNotMatch(await readFile(auditPath, "utf8"), /Begin Patch|literal \$\(\)/)

  const noisyPatch = ["*** Begin Patch", "*** Add File: noisy.txt", `+${"x".repeat(400)}`, "*** End Patch"].join("\n")
  const noisyResult = await connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: project, patch: noisyPatch },
  })
  assert.deepEqual(noisyResult.structuredContent, {
    status: "completed",
    exit_code: 0,
  })

  const failed = await connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: project, patch: `${patch}\nFAIL_PATCH` },
  })
  assert.equal(failed.isError, true)
  const failedContent = failed.structuredContent as {
    status: "failed"
    exit_code: number
    output: string
    output_dropped?: true
  }
  assert.equal(failedContent.status, "failed")
  assert.equal(failedContent.exit_code, 9)
  assert.equal(countTokens(failedContent.output), 1_024)
  assert.equal(failedContent.output_dropped, true)
  const failedText = (failed.content?.[0] as { text?: string } | undefined)?.text ?? ""
  assert.match(failedText, /apply_patch failed, exit=9/)
  assert.ok(failedText.endsWith(failedContent.output))
  const failedAudit = await readFile(auditPath, "utf8")
  assert.match(failedAudit, /--- # ! \d{2}:\d{2}:\d{2} - apply_patch - \d+ms/)
  assert.match(failedAudit, /patch: \|-\n {2}\*\*\* Begin Patch/)
  assert.match(failedAudit, / {2}FAIL_PATCH/)

  const invalid = await connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: "relative/project", patch },
  })
  assert.equal(invalid.isError, true)
  assert.match(JSON.stringify(invalid.content), /cwd must be an absolute path/)

  const slowPatch = connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: project, patch: `${patch}\nSLOW_PATCH` },
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  const concurrent = await connected.client.callTool({
    name: "shell_run",
    arguments: {
      request_id: "during-patch",
      command: "printf runs-independently",
    },
  })
  assert.equal(concurrent.isError, undefined)
  assert.equal((concurrent.structuredContent as { output: string }).output, "runs-independently")
  assert.equal((await slowPatch).isError, undefined)
})

test("force-kills a SIGTERM-resistant apply_patch after request abort", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-aborted-patch-")))
  const project = join(directory, "project")
  const bin = join(directory, "bin")
  await mkdir(project, { recursive: true })
  await mkdir(bin, { recursive: true })
  const executable = join(bin, "apply_patch")
  await writeFile(executable, "#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' \"$$\" > \"$PWD/patch.pid\"\ncat >/dev/null\nwhile :; do sleep 1; done\n")
  await chmod(executable, 0o755)

  const shell = new PersistentShellSession({ cwd: directory })
  const running = await startMcpHttpServer({
    port: 0,
    shellManager: new ShellSessionManager({ defaultShell: shell }),
    applyPatchExecutable: executable,
  })
  let patchPid: number | undefined
  // eslint-disable-next-line prefer-const -- assigned after cleanup registration so early failures can still destroy it.
  let request: ReturnType<typeof httpRequest> | undefined
  t.after(async () => {
    request?.destroy()
    if (patchPid) {
      try {
        process.kill(-patchPid, "SIGKILL")
      } catch {
        // Best-effort cleanup if the process already exited.
      }
    }
    await running.close()
    await rm(directory, { recursive: true, force: true })
  })

  const target = new URL(running.url)
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "apply_patch",
      arguments: {
        cwd: project,
        patch: "*** Begin Patch\n*** End Patch",
      },
    },
  })
  request = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
        "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      },
    },
    (response) => response.resume()
  )
  request.on("error", () => {})
  request.end(body)

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      patchPid = Number.parseInt(await readFile(join(project, "patch.pid"), "utf8"), 10)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  assert.ok(patchPid && Number.isSafeInteger(patchPid), "fake apply_patch did not start")

  request.destroy()

  let exited = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(patchPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        exited = true
        break
      }
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(exited, true, "SIGTERM-resistant apply_patch process was not force-killed")
})

test("rejects a mismatched HTTP Host", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())

  const status = await postWithHost(running.url, "attacker.example", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "host-validation-test", version: "1.0.0" },
    },
  })

  assert.equal(status, 403)
})

test("remote MCP binds on the first tool call while local MCP remains available", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unhinged-agent-remote-auth-"))
  const authStore = new UnhingedAgentAuthStore(join(root, "auth.json"))
  await authStore.ensureState()
  const running = await startMcpHttpServer({ port: 0, authStore })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal(
    await postWithHost(`${running.url}/`, `localhost:${running.port}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "remote-trailing-slash-bypass", version: "1.0.0" },
      },
    }),
    404
  )

  const local = await connectClient(running.url, "local-auth-bypass")
  assert.ok((await local.client.callTool({ name: "shell_list", arguments: {} })).content)

  const discovery = await connectClient(running.url, "remote-discovery", undefined, true)
  assert.ok((await discovery.client.listTools()).tools.length > 0)
  assert.equal((await authStore.readState()).subject, null)
  await assert.rejects(() => discovery.client.callTool({ name: "shell_list", arguments: {} }), /403|denied/i)
  assert.equal((await authStore.readState()).subject, null)

  const failedOwner = await connectClient(running.url, "remote-failed-owner", "subject-a", true)
  await assert.rejects(() => failedOwner.client.callTool({ name: "tool_that_does_not_exist", arguments: {} }), /not found/i)
  assert.equal((await authStore.readState()).subject, "subject-a")

  const owner = await connectClient(running.url, "remote-owner", "subject-a", true)
  assert.ok((await owner.client.callTool({ name: "shell_list", arguments: {} })).content)
  assert.equal((await authStore.readState()).subject, "subject-a")

  const sameOwner = await connectClient(running.url, "remote-owner-new-conversation", "subject-a", true)
  assert.ok((await sameOwner.client.callTool({ name: "shell_list", arguments: {} })).content)

  const otherSubject = await connectClient(running.url, "remote-other-subject", "subject-b", true)
  await assert.rejects(() => otherSubject.client.callTool({ name: "shell_list", arguments: {} }), /403|denied/i)
})

test("remote MCP owner survives an HTTP server restart", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unhinged-agent-remote-restart-"))
  const filePath = join(root, "auth.json")
  const firstAuthStore = new UnhingedAgentAuthStore(filePath)
  await firstAuthStore.ensureState()
  let running = await startMcpHttpServer({ port: 0, authStore: firstAuthStore })
  const port = running.port
  const remoteUrl = `http://${running.host}:${port}/mcp`

  const owner = await connectClient(remoteUrl, "remote-owner-before-restart", "subject-a", true)
  await owner.client.callTool({ name: "shell_list", arguments: {} })
  await running.close()

  const secondAuthStore = new UnhingedAgentAuthStore(filePath)
  assert.deepEqual(await secondAuthStore.ensureState(), { version: 1, subject: "subject-a" })
  running = await startMcpHttpServer({ port, authStore: secondAuthStore })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  const afterRestart = await connectClient(remoteUrl, "remote-owner-after-restart", "subject-a", true)
  assert.ok((await afterRestart.client.callTool({ name: "shell_list", arguments: {} })).content)
})

function postWithHost(url: string, host: string, value: unknown): Promise<number> {
  const target = new URL(url)
  const body = JSON.stringify(value)

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          host,
        },
      },
      (response) => {
        response.resume()
        response.once("end", () => resolve(response.statusCode ?? 0))
      }
    )
    request.once("error", reject)
    request.end(body)
  })
}

async function connectClient(url: string, name: string, openAiSubject?: string, trustedRemote = false) {
  const client = new Client({ name, version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit:
      openAiSubject || trustedRemote
        ? {
            headers: {
              ...(openAiSubject ? { "x-openai-subject": openAiSubject } : {}),
              ...(trustedRemote ? { "x-unhinged-agent-remote": "1" } : {}),
            },
          }
        : undefined,
  })
  await client.connect(transport)
  return { client, transport }
}

interface ToolSnapshot {
  shell_id?: string
  status: "running" | "completed" | "shell_exited" | "reset"
  exit_code?: number
  cwd: string
  output: string
  request_id?: string
  next_cursor?: number
  cursor_expired?: true
  output_truncated?: true
  dropped_output_bytes?: number
}

async function callUntilComplete(client: Client, requestId: string, command: string, shellId?: string): Promise<ToolSnapshot> {
  let snapshot = snapshotFromResult(
    await client.callTool({
      name: "shell_run",
      arguments: {
        ...(shellId ? { shell_id: shellId } : {}),
        request_id: requestId,
        command,
        wait_ms: 1_000,
      },
    })
  )
  const cwd = snapshot.cwd
  let output = snapshot.output

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && snapshot.next_cursor === undefined) {
      return { ...snapshot, ...(shellId ? { shell_id: shellId } : {}), cwd, output }
    }
    assert.notEqual(snapshot.next_cursor, undefined)
    snapshot = snapshotFromResult(
      await client.callTool({
        name: "shell_poll",
        arguments: {
          ...(shellId ? { shell_id: shellId } : {}),
          request_id: requestId,
          cursor: snapshot.next_cursor,
          wait_ms: 100,
        },
      })
    )
    output += snapshot.output
  }

  throw new Error(`MCP command ${requestId} did not complete.`)
}

function snapshotFromResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolSnapshot {
  assert.equal(result.isError, undefined)
  assert.ok(result.structuredContent)
  return result.structuredContent as unknown as ToolSnapshot
}
