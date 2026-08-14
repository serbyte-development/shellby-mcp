import assert from "node:assert/strict"
import { chmod, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

import { characterCount, formatAuditTime, McpAuditLogger } from "../src/server/audit-log.js"
import { countTokens } from "../src/tokenizer.js"
import { tempDir } from "./helpers/temp.js"

test("writes one compact YAML document for a shell command", async (t) => {
  const file = await auditFile(t)

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
    ["--- # 20:58:30 - shell_run - 275ms - 23 in", 'shell: "api-audit/scan-1"', "command: |-", "  rg -n foo src", "", ""].join("\n")
  )
})

test("logs shell output token count", async (t) => {
  const file = await auditFile(t)

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 13, 19, 13, 46),
    () => 1_380
  )
  const [call] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: { shell_id: "default", request_id: "tokens", command: "printf 'hello world'" },
    },
  })
  assert.ok(call)
  const output = "hello world"
  const structuredContent = { status: "completed", exit_code: 0, cwd: "/workspace", output }
  const responseBody = JSON.stringify({
    result: {
      structuredContent,
    },
  })
  call.finish({
    httpStatus: 200,
    state: "finished",
    responseBytes: Buffer.byteLength(responseBody, "utf8"),
    responseBody,
  })

  const log = await readFile(file, "utf8")
  const inputTokens = countTokens(JSON.stringify({ shell_id: "default", request_id: "tokens", command: "printf 'hello world'" }))
  const outputTokens = countTokens(JSON.stringify(structuredContent))
  assert.match(log, new RegExp(`--- # 19:13:46 - shell_run - 0ms - ${inputTokens} in / ${outputTokens} out`))
})

test("marks explicit structured and max_output_tokens tool arguments in the heading", async (t) => {
  const file = await auditFile(t)
  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 14, 8, 11, 0),
    () => 0
  )
  const [call] = logger.startToolCalls({
    method: "tools/call",
    params: {
      name: "shell_run",
      arguments: {
        shell_id: "default",
        request_id: "markers",
        command: "pwd",
        structured: true,
        max_output_tokens: 4_096,
      },
    },
  })
  assert.ok(call)
  call.finish({ httpStatus: 200, state: "finished", responseBytes: 100 })

  const log = await readFile(file, "utf8")
  assert.match(log, /^--- # 08:11:00 - shell_run - 0ms - \d+ in - structured - max_output_tokens=4096$/m)
})

test("matches batched tool responses by JSON-RPC id", async (t) => {
  const file = await auditFile(t)

  const logger = new McpAuditLogger(
    file,
    () => new Date(2026, 7, 14, 0, 30, 0),
    () => 1_000
  )
  const calls = logger.startToolCalls([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "shell_list", arguments: { first: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "feedback_submit", arguments: { feedback: "second" } } },
  ])
  assert.equal(calls.length, 2)

  const firstOutput = "first"
  const secondOutput = "second output has several more tokens"
  const responseBody = JSON.stringify([
    { jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: secondOutput }] } },
    { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: firstOutput }] } },
  ])
  const responseBytes = Buffer.byteLength(responseBody, "utf8")
  for (const call of calls) call.finish({ httpStatus: 200, state: "finished", responseBytes, responseBody })

  const log = await readFile(file, "utf8")
  assert.match(log, new RegExp(`shell_list - 0ms - ${countTokens(JSON.stringify({ first: true }))} in / ${countTokens(firstOutput)} out`))
  assert.match(
    log,
    new RegExp(`! 00:30:00 - feedback_submit - 0ms - ${countTokens(JSON.stringify({ feedback: "second" }))} in / ${countTokens(secondOutput)} out`)
  )
})

test("creates and repairs audit logs with owner-only permissions", async (t) => {
  const directory = await tempDir(t, "mcp-audit-log-permissions-")
  const newFile = join(directory, "new.yaml")
  const existingFile = join(directory, "existing.yaml")

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
  const file = await auditFile(t)

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
  assert.equal(log, `--- # 21:12:03 - apply_patch - 51ms - 33 in\ncwd: "/workspace/project"\npatch_chars: ${characterCount(patch)}\n\n`)
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
  const file = await auditFile(t)

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
  assert.match(finalLog, /--- # 22:50:00 - shell_run - 0ms - \d+ in\nshell: "parallel\/child-nonzero"/)
  assert.doesNotMatch(finalLog, /--- # ! 22:50:00 - shell_run - 0ms - \d+ in\nshell: "parallel\/child-nonzero"/)
})

test("caps large ordinary tool arguments", async (t) => {
  const file = await auditFile(t)

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
  assert.match(log, /^--- # 22:00:00 - feedback_submit - 0ms - \d+ in\nargs: "/)
  assert.match(log, /chars omitted/)
  assert.ok(log.length < 800)
})

test("uses Better Comments tags for large, slow, and failed calls", async (t) => {
  const file = await auditFile(t)

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
  assert.match(log, /--- # \? 22:30:00 - shell_list - 100ms - 1 in - 9\.0KB/)
  assert.match(log, /--- # ~ 22:30:00 - shell_list - 5100ms - 1 in - 9\.0KB/)
  assert.match(log, /--- # ! 22:30:00 - shell_list - 50ms - 1 in - 20KB - HTTP 500 closed/)
})

test("logs tools/list as one timestamped line and ignores other non-tool MCP requests", async (t) => {
  const file = await auditFile(t)

  const timestamp = new Date(2026, 7, 7, 22, 30, 0)
  const logger = new McpAuditLogger(file, () => timestamp)
  assert.deepEqual(logger.startToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/list" }), [])
  assert.deepEqual(logger.startToolCalls({ jsonrpc: "2.0", id: 2, method: "initialize" }), [])
  assert.equal(await readFile(file, "utf8"), "--- # 22:30:00 - tools/list\n")
})

async function auditFile(t: TestContext): Promise<string> {
  return join(await tempDir(t, "mcp-audit-log-"), "agent-commands.yaml")
}
