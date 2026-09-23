import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { runWithAgent, setAgentTaskSlug } from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"
import { ToolError } from "../../src/mcp/tool-error.js"
import { createToolRegistrar } from "../../src/mcp/tool-registration-boundary.js"
import type { McpAuditCall } from "../../src/server/audit/audit-request.js"
import { delegatedTurnsResult } from "../../src/tools/delegation/turn-results.js"

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
    assert.match(JSON.stringify(thrown.content), /fixture notice/u)
    assert.equal(notices, 3)
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

for (const structuredOutput of [false, true]) {
  test(`finalizes failures once and preserves partial results with structuredOutput=${structuredOutput}`, async (t) => {
    const server = new McpServer({ name: "failure-boundary", version: "1.0.0" })
    const client = new Client({ name: "failure-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    const agentObserver = createAgentObserver()
    const finished = t.mock.method(agentObserver, "finishTool")
    const failed = t.mock.method(agentObserver, "failTool")
    const audits: Array<Parameters<McpAuditCall["finish"]>[0]> = []
    let noticeDrains = 0
    const register = createToolRegistrar(server, {
      structuredOutput,
      agentObserver,
      auditRequest: {
        claimTool: () => ({
          finish: (input) => {
            audits.push(input)
          },
        }),
        finishTransport: () => {},
      },
      drainPendingEvents: () => {
        noticeDrains += 1
        return ["fixture notice"]
      },
    })
    let calls = 0
    register(
      "typed_failure",
      {
        nativeContent: true,
        outputSchema: z.object({ success: z.string() }),
      },
      async () => {
        calls += 1
        throw new ToolError("UNAVAILABLE", "Try again later.", {
          cause: new Error("private cause"),
        })
      }
    )
    register("unexpected_failure", {}, async () => {
      throw new Error("unexpected failure", { cause: new Error("private cause") })
    })
    register("non_error_rejection", {}, () => Promise.reject("string rejection"))
    const turns = [
      { turn_id: "done", status: "completed", response: "Useful answer" },
      { turn_id: "failed", status: "failed", error: "Turn failed" },
    ]
    register("subagent_result", {}, async () => delegatedTurnsResult(turns))
    const patch = {
      status: "partial",
      exit_code: 1,
      changed: "added file.ts",
      failed: "other.ts",
      output: "Patch failed",
    }
    register("apply_patch", {}, async () => ({
      isError: true,
      structuredContent: patch,
      content: [],
    }))
    register("success", {}, async () => ({ content: [{ type: "text", text: "Done" }] }))

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await runWithAgent(`boundary-failures-${structuredOutput}`, async () => {
      const rejected = await client.callTool({ name: "typed_failure" })
      assert.equal(calls, 0)
      assert.equal(rejected.isError, true)
      assert.match(JSON.stringify(rejected.content), /INITIALIZATION_REQUIRED: /u)
      assert.equal(agentObserver.listAgents()[0]?.recent[0]?.status, "failed")
      assert.equal(audits.length, 1)

      setAgentTaskSlug("failure-tests")
      for (const [name, expected] of [
        ["typed_failure", "UNAVAILABLE: Try again later."],
        ["unexpected_failure", "internal_error: unexpected failure"],
        ["non_error_rejection", "internal_error: string rejection"],
      ] as const) {
        const result = await client.callTool({ name })
        assert.equal(result.isError, true)
        assert.deepEqual(result.content, [
          { type: "text", text: `${expected}\n\n**Notice:** fixture notice` },
        ])
        assert.deepEqual(
          result.structuredContent,
          structuredOutput ? { error_code: expected.split(":")[0] } : undefined
        )
        assert.doesNotMatch(JSON.stringify(result), /private cause|stack/u)
      }
      assert.equal(calls, 1)

      const batch = await client.callTool({ name: "subagent_result" })
      const partial = await client.callTool({ name: "apply_patch" })
      assert.equal(batch.isError, true)
      assert.equal(partial.isError, true)
      if (structuredOutput) {
        assert.deepEqual(batch.structuredContent, { turns })
        assert.deepEqual(partial.structuredContent, patch)
      } else {
        assert.equal(batch.structuredContent, undefined)
        assert.equal(partial.structuredContent, undefined)
        assert.match(JSON.stringify(batch.content), /Useful answer/u)
        assert.match(JSON.stringify(batch.content), /Turn failed/u)
        assert.match(JSON.stringify(partial.content), /added file\.ts/u)
        assert.match(JSON.stringify(partial.content), /other\.ts/u)
      }

      const success = await client.callTool({ name: "success" })
      assert.notEqual(success.isError, true)
      assert.equal(failed.mock.callCount(), 6)
      assert.equal(finished.mock.callCount(), 1)
      assert.equal(audits.length, 7)
      assert.equal(noticeDrains, 7)
      const agent = agentObserver.listAgents()[0]
      assert.equal(agent?.current, undefined)
      assert.equal(agent?.recent.filter((call) => call.status === "failed").length, 6)
      assert.equal(agent?.recent.filter((call) => call.status === "completed").length, 1)
      assert.ok(audits.every((audit) => audit?.toolResult && audit.modelResult))
    })
  })
}
