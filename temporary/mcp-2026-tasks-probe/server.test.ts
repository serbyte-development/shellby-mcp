import assert from "node:assert/strict"
import test from "node:test"

import { FULL_SUCCESS_MARKER, MODERN_ONLY_MARKER, PROBE_TOOL, PROTOCOL_VERSION, TASKS_EXTENSION, startProbeServer } from "./server.js"

test("modern-only server advertises 2026-07-28 and the current Tasks extension", async (t) => {
  const running = await startProbeServer({ port: 0 })
  t.after(() => running.close())

  const discover = await postMcp(running.url, 1, "server/discover", {}, {})
  assert.equal(discover.status, 200)
  const result = resultRecord(await discover.json())
  assert.deepEqual(result.supportedVersions, [PROTOCOL_VERSION])
  assert.deepEqual((result.capabilities as Record<string, unknown>).extensions, {
    [TASKS_EXTENSION]: {},
  })

  const legacy = await fetch(running.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1.0.0" },
      },
    }),
  })
  assert.equal(legacy.status, 400)
})

test("probe distinguishes modern MCP support from Tasks extension support and completes one task poll", async (t) => {
  const running = await startProbeServer({ port: 0 })
  t.after(() => running.close())

  const tools = await postMcp(running.url, 1, "tools/list", {}, {})
  const toolsResult = resultRecord(await tools.json())
  const toolList = toolsResult.tools as Array<Record<string, unknown>>
  assert.ok(toolList.some((tool) => tool.name === PROBE_TOOL))

  const synchronous = await postMcp(running.url, 2, "tools/call", { name: PROBE_TOOL, arguments: {} }, {}, { "mcp-name": PROBE_TOOL })
  assert.equal(synchronous.status, 200)
  const synchronousResult = resultRecord(await synchronous.json())
  assert.equal(synchronousResult.resultType, "complete")
  assert.equal(textFromToolResult(synchronousResult), MODERN_ONLY_MARKER)

  const extensionCaps = {
    extensions: {
      [TASKS_EXTENSION]: {},
    },
  }
  const created = await postMcp(running.url, 3, "tools/call", { name: PROBE_TOOL, arguments: {} }, extensionCaps, { "mcp-name": PROBE_TOOL })
  assert.equal(created.status, 200)
  const createdResult = resultRecord(await created.json())
  assert.equal(createdResult.resultType, "task")
  assert.equal(createdResult.status, "working")
  assert.equal(typeof createdResult.taskId, "string")

  const taskId = createdResult.taskId as string
  const completed = await postMcp(running.url, 4, "tasks/get", { taskId }, extensionCaps, { "mcp-name": taskId })
  assert.equal(completed.status, 200)
  const completedResult = resultRecord(await completed.json())
  assert.equal(completedResult.resultType, "complete")
  assert.equal(completedResult.status, "completed")
  assert.equal(textFromToolResult(completedResult.result as Record<string, unknown>), FULL_SUCCESS_MARKER)
})

test("Tasks extension requires current routing headers and does not expose obsolete tasks/result", async (t) => {
  const running = await startProbeServer({ port: 0 })
  t.after(() => running.close())
  const extensionCaps = { extensions: { [TASKS_EXTENSION]: {} } }

  const created = await postMcp(running.url, 1, "tools/call", { name: PROBE_TOOL, arguments: {} }, extensionCaps, { "mcp-name": PROBE_TOOL })
  const taskId = resultRecord(await created.json()).taskId as string

  const missingName = await postMcp(running.url, 2, "tasks/get", { taskId }, extensionCaps)
  assert.equal(missingName.status, 400)
  assert.equal(errorRecord(await missingName.json()).code, -32020)

  const obsolete = await postMcp(running.url, 3, "tasks/result", { taskId }, extensionCaps, {
    "mcp-name": taskId,
  })
  assert.notEqual(obsolete.status, 200)
})

async function postMcp(
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "temporary-probe-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    }),
  })
}

function resultRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value))
  assert.ok(isRecord(value.result))
  return value.result
}

function errorRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value))
  assert.ok(isRecord(value.error))
  return value.error
}

function textFromToolResult(value: Record<string, unknown>): string | undefined {
  const content = value.content
  if (!Array.isArray(content) || !isRecord(content[0]) || content[0].type !== "text") return undefined
  return typeof content[0].text === "string" ? content[0].text : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
