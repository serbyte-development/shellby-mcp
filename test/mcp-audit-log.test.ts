import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { characterCount, formatAuditTime, McpAuditLogger } from "../src/server/audit-log.js"

test("writes one compact YAML document for a shell command", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const timestamp = new Date(2026, 7, 7, 20, 58, 30)
  let clock = 1_000
  const logger = new McpAuditLogger(
    file,
    () => timestamp,
    () => clock
  )
  const [call] = logger.startToolCalls({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: {
        shell_id: "api-audit",
        request_id: "scan-1",
        command: "rg -n foo src",
      },
    },
  })
  assert.ok(call)
  clock = 1_275
  call.finish({ httpStatus: 200, state: "finished" })
  call.finish({ httpStatus: 500, state: "closed" })

  assert.equal(formatAuditTime(timestamp), "20:58:30")
  assert.equal(characterCount("🙂a"), 2)
  assert.equal(
    await readFile(file, "utf8"),
    ["--- # 20:58:30 - shell_run - 275ms", 'shell: "api-audit/scan-1"', "command: |-", "  rg -n foo src", "", ""].join("\n")
  )
})

test("omits apply_patch bodies while retaining cwd and patch size", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const timestamp = new Date(2026, 7, 7, 21, 12, 3)
  let clock = 2_000
  const logger = new McpAuditLogger(
    file,
    () => timestamp,
    () => clock
  )
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch"
  const [call] = logger.startToolCalls({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "apply_patch", arguments: { patch, cwd: "/workspace/project" } },
  })
  assert.ok(call)
  clock = 2_051
  call.finish({ httpStatus: 200, state: "finished" })

  const log = await readFile(file, "utf8")
  assert.equal(log, `--- # 21:12:03 - apply_patch - 51ms\ncwd: "/workspace/project"\npatch_chars: ${characterCount(patch)}\n\n`)
  assert.doesNotMatch(log, /Begin Patch|Update File|old|new/)
})

test("caps large ordinary tool arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 7, 22, 0, 0),
    () => 0
  )
  const [call] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "feedback_submit", arguments: { feedback: "x".repeat(2_000) } },
  })
  assert.ok(call)
  call.finish({ httpStatus: 200, state: "finished" })

  const log = await readFile(file, "utf8")
  assert.match(log, /^--- # 22:00:00 - feedback_submit - 0ms\nargs: "/)
  assert.match(log, /chars omitted/)
  assert.ok(log.length < 800)
})

test("ignores non-tool MCP requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const logger = new McpAuditLogger(file)
  assert.deepEqual(logger.startToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/list" }), [])
  await assert.rejects(readFile(file, "utf8"), /ENOENT/)
})
