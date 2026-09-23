import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { McpServer } from "@modelcontextprotocol/server"
import { runWithAgent, setAgentTaskSlug } from "../src/agent/context.js"
import { log, startRuntimeLogging, withLogContext } from "../src/logging.js"
import { createToolRegistrar } from "../src/mcp/tool-registration-boundary.js"
import { startMcpHttpServer } from "../src/server/http-server.js"

test("runtime log preserves concurrent identity, original errors, and flushes on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shellby-log-"))
  const logging = await startRuntimeLogging(directory)
  try {
    await Promise.all(
      ["first", "second"].map((requestId, index) =>
        runWithAgent(requestId, () =>
          withLogContext({ request_id: requestId }, async () => {
            setAgentTaskSlug(requestId)
            log("info", "tool.started", { token: "private-token" })
            await delay(index === 0 ? 10 : 1)
            log("error", "tool.failed", {
              err: new Error(requestId, { cause: new Error("cause") }),
            })
          })
        )
      )
    )
    await logging.close()
    const records = (await readFile(logging.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.equal(records.length, 4)
    for (const requestId of ["first", "second"]) {
      const events = records.filter((record) => record.request_id === requestId)
      assert.deepEqual(
        events.map((record) => record.msg),
        ["tool.started", "tool.failed"]
      )
      assert.ok(events.every((record) => record.task === requestId))
      assert.equal(events[0].token, "[Redacted]")
      assert.equal(events[1].err.message, requestId)
      assert.equal(events[1].err.cause.message, "cause")
      assert.match(events[1].err.stack, /Error:/)
    }
    assert.equal(new Set(records.map((record) => record.run_id)).size, 1)
    assert.equal((await stat(logging.path)).mode & 0o777, 0o600)
  } finally {
    await logging.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("runtime log appends across writer restarts and bounds error details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shellby-log-"))
  try {
    for (let index = 0; index < 2; index += 1) {
      const logging = await startRuntimeLogging(directory)
      log("error", "probe", { err: new Error("x".repeat(20_000)) })
      await logging.close()
    }
    const files = (await readdir(join(directory, "logs"))).filter((name) => name.endsWith(".jsonl"))
    const records = (
      await Promise.all(files.map((name) => readFile(join(directory, "logs", name), "utf8")))
    ).flatMap((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
    assert.equal(records.length, 2)
    assert.equal(new Set(records.map((record) => record.run_id)).size, 2)
    assert.ok(
      records.every(
        (record) => record.err.message.length <= 4096 && record.err.stack.length <= 8192
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("HTTP and tool failures share correlation and retain the original exception", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shellby-log-"))
  const logging = await startRuntimeLogging(directory)
  const server = await startMcpHttpServer(
    {
      createMcpServer: () => {
        const mcp = new McpServer({ name: "logging-probe", version: "1.0.0" })
        const register = createToolRegistrar(mcp, { structuredOutput: false })
        register("probe", {}, async () => {
          throw new Error("original failure", { cause: new Error("root cause") })
        })
        return mcp
      },
    },
    { port: 0 }
  )
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "probe" },
      }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /"isError":true/)
    await server.close()
    await logging.close()
    const records = (await readFile(logging.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      records.map((record) => record.msg),
      ["http.started", "tool.started", "tool.failed", "http.finished"]
    )
    assert.equal(new Set(records.map((record) => record.request_id)).size, 1)
    const failure = records.find((record) => record.msg === "tool.failed")
    assert.equal(failure.tool, "probe")
    assert.equal(failure.mcp_request_id, 42)
    assert.equal(failure.err.cause.message, "root cause")
    assert.match(failure.err.stack, /original failure/)
  } finally {
    await server.close()
    await logging.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("an unavailable logging directory preserves application operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shellby-log-"))
  try {
    const blocked = join(directory, "file")
    await writeFile(blocked, "occupied")
    const logging = await startRuntimeLogging(blocked)
    assert.doesNotThrow(() => log("info", "fallback.probe"))
    await logging.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
