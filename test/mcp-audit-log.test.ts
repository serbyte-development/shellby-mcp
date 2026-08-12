import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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
  call.finish({ httpStatus: 200, state: "finished", responseBytes: 512 })
  call.finish({ httpStatus: 500, state: "closed", responseBytes: 999 })

  assert.equal(formatAuditTime(timestamp), "20:58:30")
  assert.equal(characterCount("🙂a"), 2)
  assert.equal(
    await readFile(file, "utf8"),
    ["--- # 20:58:30 - shell_run - 275ms", 'shell: "api-audit/scan-1"', "command: |-", "  rg -n foo src", "", ""].join("\n")
  )
})

test("creates and repairs audit logs with owner-only permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-permissions-"))
  const newFile = join(directory, "new.yaml")
  const existingFile = join(directory, "existing.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const newLogger = new McpAuditLogger(newFile)
  const [call] = newLogger.startToolCalls({ method: "tools/call", params: { name: "shell_list", arguments: {} } })
  assert.ok(call)
  call.finish({ httpStatus: 200, state: "finished", responseBytes: 100 })
  assert.equal((await stat(newFile)).mode & 0o777, 0o600)

  await writeFile(existingFile, "existing\n")
  await chmod(existingFile, 0o644)
  new McpAuditLogger(existingFile)
  assert.equal((await stat(existingFile)).mode & 0o777, 0o600)
  assert.equal(await readFile(existingFile, "utf8"), "existing\n")
})

test("logs apply_patch bodies only when the tool fails", async (t) => {
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
  call.finish({ httpStatus: 200, state: "finished", responseBytes: 200, responseBody: '{"result":{"isError":false}}' })

  let log = await readFile(file, "utf8")
  assert.equal(log, `--- # 21:12:03 - apply_patch - 51ms\ncwd: "/workspace/project"\npatch_chars: ${characterCount(patch)}\n\n`)
  assert.doesNotMatch(log, /Begin Patch|Update File|old|new/)

  const [failedCall] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "apply_patch", arguments: { patch, cwd: "/workspace/project" } },
  })
  assert.ok(failedCall)
  clock = 2_100
  failedCall.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: 400,
    responseBody: `event: message\ndata: ${JSON.stringify({
      result: {
        isError: true,
        structuredContent: { status: "failed", exit_code: 1, output: "Invalid patch hunk on line 4\nUnexpected @@" },
      },
    })}\n\n`,
  })

  log = await readFile(file, "utf8")
  assert.match(log, /--- # ! 21:12:03 - apply_patch - 49ms/)
  assert.match(log, /message: "Invalid patch hunk on line 4\\nUnexpected @@"/)
  assert.match(log, /patch: \|-\n {2}\*\*\* Begin Patch/)
  assert.match(log, / {2}\+new/)

  const [thrownFailure] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "apply_patch", arguments: { patch, cwd: "/workspace/project" } },
  })
  assert.ok(thrownFailure)
  thrownFailure.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: 300,
    responseBody: JSON.stringify({
      result: {
        isError: true,
        content: [{ type: "text", text: "apply_patch_failed: apply_patch request was aborted." }],
      },
    }),
  })

  log = await readFile(file, "utf8")
  assert.match(log, /message: "apply_patch_failed: apply_patch request was aborted\."/)
})

test("logs shell tool errors with their MCP failure reason", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 11, 22, 50, 0),
    () => 100
  )
  const [run] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: { shell_id: "parallel", request_id: "bad-batch", command: "*** Run\npwd" },
    },
  })
  assert.ok(run)
  assert.equal(run.needsResponseBody, true)
  run.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: 250,
    responseBody: `event: message\ndata: ${JSON.stringify({
      result: {
        isError: true,
        content: [{ type: "text", text: "invalid_command: Expected '*** Run: <directory-or-relative-path>' on line 1." }],
      },
    })}\n\n`,
  })

  const [poll] = logger.startToolCalls({
    method: "tools/call",
    params: { name: "shell_poll", arguments: { shell_id: "parallel", request_id: "missing", cursor: 0 } },
  })
  assert.ok(poll)
  assert.equal(poll.needsResponseBody, true)
  poll.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: 180,
    responseBody: `event: message\ndata: ${JSON.stringify({
      result: {
        isError: true,
        content: [{ type: "text", text: "unknown_request: No retained command for request_id missing." }],
      },
    })}\n\n`,
  })

  const log = await readFile(file, "utf8")
  assert.match(log, /--- # ! 22:50:00 - shell_run/)
  assert.match(log, /message: "invalid_command: Expected '\*\*\* Run: <directory-or-relative-path>' on line 1\."/)
  assert.match(log, /--- # ! 22:50:00 - shell_poll/)
  assert.match(log, /shell: "parallel\/missing"\ncursor: 0\nmessage: "unknown_request: No retained command for request_id missing\."/)

  const [childNonzero] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: { shell_id: "parallel", request_id: "child-nonzero", command: "*** Run: .\nfalse" },
    },
  })
  assert.ok(childNonzero)
  childNonzero.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: 220,
    responseBody: JSON.stringify({
      result: {
        isError: false,
        structuredContent: {
          status: "completed",
          exit_code: 1,
          commands: [{ run: 1, path: ".", status: "completed", exit_code: 1 }],
        },
      },
    }),
  })

  const finalLog = await readFile(file, "utf8")
  assert.match(finalLog, /--- # 22:50:00 - shell_run - 0ms\nshell: "parallel\/child-nonzero"/)
  assert.doesNotMatch(finalLog, /--- # ! 22:50:00 - shell_run - 0ms\nshell: "parallel\/child-nonzero"/)
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
  call.finish({ httpStatus: 200, state: "finished", responseBytes: 200 })

  const log = await readFile(file, "utf8")
  assert.match(log, /^--- # 22:00:00 - feedback_submit - 0ms\nargs: "/)
  assert.match(log, /chars omitted/)
  assert.ok(log.length < 800)
})

test("uses Better Comments tags for large, slow, and failed calls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  let clock = 0
  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 7, 22, 30, 0),
    () => clock
  )
  const request = { method: "tools/call", params: { name: "shell_list", arguments: {} } }

  const [large] = logger.startToolCalls(request)
  assert.ok(large)
  clock = 100
  large.finish({ httpStatus: 200, state: "finished", responseBytes: 9 * 1024 })

  const [slow] = logger.startToolCalls(request)
  assert.ok(slow)
  clock = 5_200
  slow.finish({ httpStatus: 200, state: "finished", responseBytes: 9 * 1024 })

  const [failed] = logger.startToolCalls(request)
  assert.ok(failed)
  clock = 5_250
  failed.finish({ httpStatus: 500, state: "closed", responseBytes: 20 * 1024 })

  const log = await readFile(file, "utf8")
  assert.match(log, /--- # \? 22:30:00 - shell_list - 100ms - 9\.0KB/)
  assert.match(log, /--- # ~ 22:30:00 - shell_list - 5100ms - 9\.0KB/)
  assert.match(log, /--- # ! 22:30:00 - shell_list - 50ms - 20KB - HTTP 500 closed/)
})

test("ignores non-tool MCP requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-audit-log-"))
  const file = join(directory, "agent-commands.yaml")
  t.after(() => rm(directory, { recursive: true, force: true }))

  const logger = new McpAuditLogger(file)
  assert.deepEqual(logger.startToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/list" }), [])
  await assert.rejects(readFile(file, "utf8"), /ENOENT/)
})
