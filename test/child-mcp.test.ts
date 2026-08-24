import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createFakeChildMcp } from "./helpers/child-mcp.js"

test("discovers selected child tools and forwards native results", async (t) => {
  const child = createFakeChildMcp(["echo"])
  t.after(() => child.close())
  await child.start()

  assert.deepEqual(
    child.tools.map((tool) => tool.name),
    ["echo"]
  )
  assert.deepEqual(child.tools[0]?.inputSchema.properties, {
    value: { type: "string" },
    action: { type: "string" },
  })

  const result = await child.callTool("echo", { value: "hello" }, { _meta: { trace: "forwarded" } })
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }])
  assert.deepEqual(result.structuredContent, { echo: "hello" })
  assert.deepEqual(result._meta, { request_meta: { trace: "forwarded" } })
})

test("fails startup when a configured child tool is absent", async (t) => {
  const child = createFakeChildMcp(["missing"], { FAKE_CHILD_TOOLS: "echo" })
  t.after(() => child.close())

  await assert.rejects(child.start(), /missing configured tools: missing/)
})

test("routes transformed public names to their original upstream tools", async (t) => {
  const child = createFakeChildMcp(["echo"], {}, { transformTool: (tool) => ({ ...tool, name: "public_echo" }) })
  t.after(() => child.close())
  await child.start()

  assert.deepEqual(
    child.tools.map((tool) => tool.name),
    ["public_echo"]
  )
  const result = await child.callTool("public_echo", { value: "renamed" })
  assert.deepEqual(result.structuredContent, { echo: "renamed" })
  await assert.rejects(child.callTool("echo", {}), /does not expose tool echo/)
})

test("does not retry an interrupted action and reconnects for the next call", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "child-mcp-reconnect-"))
  const logPath = join(root, "child.jsonl")
  const child = createFakeChildMcp(["echo", "crash"], { FAKE_CHILD_MCP_LOG: logPath })
  t.after(async () => {
    await child.close()
    await rm(root, { recursive: true, force: true })
  })
  await child.start()

  await assert.rejects(child.callTool("crash", {}))
  const recovered = await child.callTool("echo", { value: "after" })
  assert.deepEqual(recovered.structuredContent, { echo: "after" })

  const events = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; name?: string })
  assert.equal(events.filter((event) => event.event === "start").length, 2)
  assert.equal(events.filter((event) => event.event === "call" && event.name === "crash").length, 1)
})
