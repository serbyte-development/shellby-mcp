import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { McpAuditLogger } from "../../src/server/audit/audit-log.js"
import type { ChatGptDelegationService } from "../../src/tools/delegation/contracts.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("audits tool calls made through the HTTP MCP boundary", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-audit-integration-"))
  const auditPath = join(root, "agent-commands.yaml")
  const chatGptDelegation: ChatGptDelegationService = {
    async ask({ agentId }) {
      if (agentId === "failed-agent") throw new Error("Original submission error: composer missing")
      return `turn-${agentId}`
    },
    async cloneSelf() {
      throw new Error("unused")
    },
    async cloneRun() {
      throw new Error("unused")
    },
    async poll(_turnId) {
      if (_turnId === "failed-turn")
        return {
          status: "failed",
          errorCode: "CHATGPT_UI_CHANGED",
          errorMessage: "Original polling error: reply element missing",
        }
      return { status: "completed", response: "done" }
    },
    drainEvents() {
      return []
    },
    async dispose() {},
  }
  const running = await startMcpHttpServer({
    port: 0,
    auditLogger: new McpAuditLogger(auditPath),
    chatGptDelegation,
  })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })

  const connected = await connectClient(
    running.url,
    "audit-integration-client",
    undefined,
    false,
    "child-session"
  )
  t.after(() => connected.client.close())
  await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "audit-integration" },
  })
  await connected.client.callTool({ name: "shell_list", arguments: {} })
  await connected.client.callTool({
    name: "subagent_run",
    arguments: { agents: [{ agent_id: "audit-check", prompt: "Inspect the audit path." }] },
  })
  await connected.client.callTool({
    name: "skill_list",
    arguments: {},
  })
  const failedSubmit = await connected.client.callTool({
    name: "subagent_run",
    arguments: { agents: [{ agent_id: "failed-agent", prompt: "Failure probe" }] },
  })
  const failedPoll = await connected.client.callTool({
    name: "subagent_result",
    arguments: { turn_ids: ["failed-turn"], wait_ms: 0 },
  })
  assert.equal(failedSubmit.isError, true)
  assert.equal(failedPoll.isError, true)
  assert.doesNotMatch(
    JSON.stringify([failedSubmit, failedPoll]),
    /Original submission|Original polling/u
  )

  const log = await readFile(auditPath, "utf8")
  assert.match(log, /shell_list/u)
  assert.match(log, /args: \{\}/u)
  assert.match(log, /subagent_run/u)
  assert.match(log, /audit-check/u)
  assert.match(log, /Inspect the audit path\./u)
  assert.match(log, /--- # skill_list /u)
  assert.match(log, /session: "agent-1"/u)
  assert.doesNotMatch(log, /child-session/u)
  assert.match(log, /error: "Original submission error: composer missing"/u)
  assert.match(log, /error: "CHATGPT_UI_CHANGED: Original polling error: reply element missing"/u)
})
