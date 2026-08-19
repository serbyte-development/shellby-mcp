import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { PeekabooClient } from "../../src/tools/computer/peekaboo.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("routes Computer Use through Peekaboo and preserves semantic errors", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-mcp-integration-"))
  const fixture = fileURLToPath(new URL("../fixtures/fake-peekaboo.mjs", import.meta.url))
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
  const running = await startMcpHttpServer({ port: 0, peekaboo })
  t.after(async () => {
    await running.close()
    await rm(root, { recursive: true, force: true })
  })
  const connected = await connectClient(running.url, "computer-use-integration-client")
  t.after(() => connected.client.close())

  const observed = await connected.client.callTool({ name: "computer_observe", arguments: { app: "Finder" } })
  assert.equal(observed.isError, undefined)
  assert.deepEqual(
    observed.content.map((block) => block.type),
    ["text", "image"]
  )
  assert.deepEqual(observed.structuredContent, { snapshot_id: "snapshot-42" })

  const inspected = await connected.client.callTool({
    name: "computer_inspect",
    arguments: { snapshot_id: "snapshot-42", max_depth: 4, max_elements: 20, max_children: 10 },
  })
  assert.deepEqual(inspected.content, [{ type: "text", text: '[B1] AXButton "Continue"' }])

  const clicked = await connected.client.callTool({
    name: "computer_click",
    arguments: { snapshot_id: "snapshot-42", element_id: "B1" },
  })
  assert.equal(clicked.isError, undefined)
  assert.deepEqual(clicked.structuredContent, {
    command: "click",
    args: ["click", "--on", "B1", "--snapshot", "snapshot-42", "--json"],
  })

  const failed = await connected.client.callTool({
    name: "computer_app",
    arguments: { action: "switch", app: "Finder" },
  })
  assert.equal(failed.isError, true)
  assert.deepEqual(failed.content, [
    {
      type: "text",
      text: "FAKE_COMMAND_FAILED: Fake Peekaboo failure for app (fixture requested failure)",
    },
  ])
})
