import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { createToolRegistrar } from "../../src/mcp/tool-registration-boundary.js"

for (const structuredOutput of [false, true]) {
  test(`preserves SDK validation and callback conventions with structuredOutput=${structuredOutput}`, async (t) => {
    const server = new McpServer({ name: "boundary-test", version: "1.0.0" })
    const client = new Client({ name: "boundary-test-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    let inputCalls = 0
    let contextCalls = 0
    let notices = 0
    const originalRegisterTool = server.registerTool
    const registerTool = createToolRegistrar(server, {
      structuredOutput,
      drainPendingEvents: () => {
        notices += 1
        return ["fixture notice"]
      },
    })

    assert.equal(server.registerTool, originalRegisterTool)

    registerTool(
      "with_input",
      {
        inputSchema: z.object({ name: z.string().trim().min(1) }),
        outputSchema: z.object({ name: z.string() }),
      },
      async ({ name }, context) => {
        inputCalls += 1
        assert.notEqual(context.mcpReq.id, undefined)
        return { structuredContent: { name }, content: [] }
      }
    )
    registerTool("without_input", {}, async (context) => {
      contextCalls += 1
      assert.notEqual(context.mcpReq.id, undefined)
      return { content: [{ type: "text", text: "context received" }] }
    })
    registerTool("throwing", {}, async () => {
      throw new Error("fixture failure")
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const listed = await client.listTools()
    assert.deepEqual(
      Object.keys(
        listed.tools.find((tool) => tool.name === "with_input")?.inputSchema.properties ?? {}
      ),
      ["name"]
    )
    assert.deepEqual(
      Object.keys(
        listed.tools.find((tool) => tool.name === "without_input")?.inputSchema.properties ?? {}
      ),
      []
    )

    const loaded = await client.callTool({ name: "with_input", arguments: { name: " value " } })
    assert.notEqual(loaded.isError, true)
    assert.equal(inputCalls, 1)
    if (structuredOutput) assert.deepEqual(loaded.structuredContent, { name: "value" })
    else assert.equal(loaded.structuredContent, undefined)
    assert.match(JSON.stringify(loaded.content), /fixture notice/u)

    const contextResult = await client.callTool({ name: "without_input", arguments: {} })
    assert.notEqual(contextResult.isError, true)
    assert.equal(contextCalls, 1)
    assert.match(JSON.stringify(contextResult.content), /context received/u)

    const invalid = await client.callTool({ name: "with_input", arguments: { name: 42 } })
    assert.equal(invalid.isError, true)
    assert.equal(inputCalls, 1)
    assert.equal(notices, 2)

    const thrown = await client.callTool({ name: "throwing", arguments: {} })
    assert.equal(thrown.isError, true)
    assert.match(JSON.stringify(thrown.content), /fixture failure/u)
    assert.equal(notices, 2)
  })
}

test("native result policy is explicit and independent of tool names", async (t) => {
  const server = new McpServer({ name: "native-policy", version: "1.0.0" })
  const client = new Client({ name: "native-policy-client", version: "1.0.0" })
  t.after(() => Promise.all([client.close(), server.close()]))
  const registerTool = createToolRegistrar(server, { structuredOutput: false })
  registerTool(
    "renamed_asset",
    {
      nativeContent: true,
      outputSchema: z.object({ caption: z.string() }),
    },
    async () => ({
      structuredContent: { caption: "native metadata" },
      content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    })
  )
  registerTool(
    "computer_plain",
    {
      outputSchema: z.object({ value: z.string() }),
    },
    async () => ({ structuredContent: { value: "compact value" }, content: [] })
  )

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const listed = await client.listTools()
  assert.ok(listed.tools.find((tool) => tool.name === "renamed_asset")?.outputSchema)
  assert.equal(listed.tools.find((tool) => tool.name === "computer_plain")?.outputSchema, undefined)
  assert.doesNotMatch(JSON.stringify(listed.tools), /nativeContent/u)
  const native = await client.callTool({ name: "renamed_asset", arguments: {} })
  assert.deepEqual(native.structuredContent, { caption: "native metadata" })
  assert.deepEqual(native.content, [{ type: "image", data: "AA==", mimeType: "image/png" }])
  const compact = await client.callTool({ name: "computer_plain", arguments: {} })
  assert.equal(compact.structuredContent, undefined)
  assert.match(JSON.stringify(compact.content), /compact value/u)
})
