import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { characterCount, compactTimestamp, extractResultCharacterCounts, McpAuditLogger } from "../src/mcp-audit-log.js"

test("formats shell commands as readable blocks and records completion metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.log")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const timestamp = new Date(2026, 7, 7, 20, 58, 30)
  let clock = 1_000
  const logger = new McpAuditLogger(
    file,
    () => timestamp,
    () => clock
  )
  const args = {
    shell_id: "api-audit",
    request_id: "scan-1",
    command: "rg -n foo src",
  }

  const [call] = logger.startToolCalls({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "shell_run", arguments: args },
  })
  assert.ok(call)
  clock = 1_275
  call.finish({ httpStatus: 200, state: "finished", outputChars: 42 })
  call.finish({ httpStatus: 500, state: "closed", outputChars: 999 })

  const serializedArguments = JSON.stringify(args)
  assert.equal(compactTimestamp(timestamp), "AUG-7-20:58:30")
  assert.equal(characterCount("🙂a"), 2)
  assert.equal(
    await readFile(file, "utf8"),
    [
      `AUG-7-20:58:30\tCALL\tshell_run\tchars=${characterCount(serializedArguments)}\t${JSON.stringify({ shell_id: "api-audit", request_id: "scan-1" })}`,
      `COMMAND\tchars=${characterCount(args.command)}`,
      args.command,
      "END COMMAND",
      "AUG-7-20:58:30\tRESULT\tshell_run\tchars=42\tduration_ms=275\thttp_status=200\tstate=finished",
      "",
      "",
    ].join("\n")
  )
})

test("omits apply_patch bodies while retaining metadata and patch size", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.log")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const timestamp = new Date(2026, 7, 7, 21, 12, 3)
  const logger = new McpAuditLogger(file, () => timestamp)
  const args = {
    patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
    cwd: "/workspace/project",
    max_output_bytes: 4096,
  }

  logger.startToolCalls({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "apply_patch", arguments: args },
  })

  const log = await readFile(file, "utf8")
  assert.equal(
    log,
    `AUG-7-21:12:03\tCALL\tapply_patch\tchars=${characterCount(JSON.stringify(args))}\tpatch_chars=${characterCount(args.patch)}\t${JSON.stringify({ cwd: args.cwd, max_output_bytes: args.max_output_bytes })}\n`
  )
  assert.doesNotMatch(log, /Begin Patch|Update File|old|new/)
})

test("counts only the JSON-RPC tool result or error payload", () => {
  const payload = JSON.stringify([
    {
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: { response: "hello" } },
    },
    {
      jsonrpc: "2.0",
      id: "two",
      error: { code: -32000, message: "failed" },
    },
  ])
  const counts = extractResultCharacterCounts(payload)
  assert.equal(counts.get("1"), characterCount(JSON.stringify({ structuredContent: { response: "hello" } })))
  assert.equal(counts.get("two"), characterCount(JSON.stringify({ code: -32000, message: "failed" })))
})

test("ignores non-tool MCP requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.log")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const logger = new McpAuditLogger(file)
  assert.deepEqual(logger.startToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/list" }), [])
  await assert.rejects(readFile(file, "utf8"), /ENOENT/)
})
