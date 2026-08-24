import assert from "node:assert/strict"
import test from "node:test"

import { createFakeChildMcp } from "../helpers/child-mcp.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("passes native child Computer Use schemas, results, and failures through unchanged", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({
    port: 0,
    childMcpServers: [createFakeChildMcp()],
    toolOutputStructured: "never",
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "computer-use-integration-client")
  t.after(() => connected.client.close())

  const tools = await connected.client.listTools()
  const permissions = tools.tools.find((tool) => tool.name === "permissions")
  assert.ok(permissions)
  assert.equal(permissions.description, "Fixture permissions tool")
  assert.deepEqual(permissions.annotations, { readOnlyHint: true })
  assert.deepEqual(permissions._meta, {
    fixture: "permissions",
    securitySchemes: [{ type: "noauth" }],
  })

  const observed = await connected.client.callTool({ name: "see", arguments: { value: "Finder" } })
  assert.deepEqual(
    observed.content.map((block) => block.type),
    ["text", "image"]
  )
  assert.deepEqual(observed.structuredContent, { snapshot_id: "snapshot-native", arguments: { value: "Finder" } })
  assert.deepEqual(observed._meta, { source: "fake-child" })

  const clicked = await connected.client.callTool({ name: "click", arguments: { value: "B1" } })
  assert.deepEqual(clicked.content, [{ type: "text", text: "click:ok" }])
  assert.deepEqual(clicked.structuredContent, { name: "click", arguments: { value: "B1" } })
  assert.deepEqual(clicked._meta, { source: "fake-child" })

  const failed = await connected.client.callTool({ name: "app", arguments: { action: "fail" } })
  assert.equal(failed.isError, true)
  assert.deepEqual(failed.content, [{ type: "text", text: "UPSTREAM_FAILURE: fixture requested failure" }])
  assert.deepEqual(failed._meta, { source: "fake-child" })
})
