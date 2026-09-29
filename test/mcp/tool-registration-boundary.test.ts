import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { z } from "zod"

import { runWithAgent, setAgentTaskSlug } from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"
import { ObservedMcpServer as McpServer } from "../../src/mcp/observed-server.js"
import { type CompletedToolCall, ToolCallTracker } from "../../src/mcp/tool-call-tracker.js"
import { ToolError } from "../../src/mcp/tool-error.js"
import { createToolRegistrar } from "../../src/mcp/tool-registration-boundary.js"
import { McpAuditLogger } from "../../src/server/audit/audit-log.js"
import { startMcpHttpServer } from "../../src/server/http-server.js"
import { delegatedTurnsResult } from "../../src/tools/delegation/subagent-tools.js"
import { tempDir } from "../helpers/temp.js"

test("keeps calls running through asynchronous SDK validation and correlates concurrent responses", {
  timeout: 10_000,
}, async (t) => {
  const agentObserver = createAgentObserver()
  const server = new McpServer(
    { name: "concurrent-validation", version: "1.0.0" },
    {},
    new ToolCallTracker({ agentObserver })
  )
  const client = new Client({ name: "concurrent-validation-client", version: "1.0.0" })
  t.after(() => Promise.all([client.close(), server.close()]))
  let releaseValidation!: () => void
  let validationStarted!: () => void
  const release = new Promise<void>((resolve) => {
    releaseValidation = resolve
  })
  const started = new Promise<void>((resolve) => {
    validationStarted = resolve
  })
  t.after(() => releaseValidation())
  const outputSchema = z.object({ name: z.string() }).superRefine(async ({ name }, context) => {
    if (name === "slow") {
      validationStarted()
      await release
      context.addIssue({ code: "custom", message: "Rejected after validation completed" })
    }
  })
  const validate = t.mock.method(outputSchema["~standard"], "validate")
  const register = createToolRegistrar(server, { structuredOutput: true, agentObserver })
  register(
    "concurrent",
    {
      inputSchema: z.object({ name: z.string() }),
      outputSchema,
    },
    async ({ name }) => ({ structuredContent: { name }, content: [] })
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  await runWithAgent("concurrent-validation", async () => {
    setAgentTaskSlug("concurrent-validation")
    const slow = client.callTool({ name: "concurrent", arguments: { name: "slow" } })
    await started
    const slowId = agentObserver.listAgents()[0]?.current?.id
    assert.ok(slowId)
    assert.equal(agentObserver.listAgents()[0]?.recent.length, 0)
    await client.callTool({ name: "concurrent", arguments: { name: "fast" } })
    assert.equal(agentObserver.listAgents()[0]?.current?.id, slowId)
    assert.match(agentObserver.listAgents()[0]?.recent[0]?.response ?? "", /fast/u)
    releaseValidation()
    const received = await slow
    assert.equal(received.isError, true)
    const finished = agentObserver.listAgents()[0]
    assert.equal(finished?.current, undefined)
    assert.equal(finished?.recent.length, 2)
    assert.equal(finished?.recent[0]?.id, slowId)
    assert.equal(finished?.recent[0]?.status, "failed")
    assert.match(finished?.recent[0]?.response ?? "", /Rejected after validation completed/u)
    assert.equal(validate.mock.callCount(), 2, "Only the SDK validates each output once")
  })
})

for (const stage of ["handler", "validation"] as const) {
  test(`settles a disconnected call once while ${stage} is pending`, {
    timeout: 10_000,
  }, async (t) => {
    const agentObserver = createAgentObserver()
    const server = new McpServer(
      { name: "disconnected-validation", version: "1.0.0" },
      {},
      new ToolCallTracker({ agentObserver })
    )
    const client = new Client({ name: "disconnected-validation-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    const observed = t.mock.method(agentObserver, "observeToolCall")
    let releaseValidation!: () => void
    let validationStarted!: () => void
    const release = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve
    })
    t.after(() => releaseValidation())
    const register = createToolRegistrar(server, { structuredOutput: true, agentObserver })
    register(
      "disconnect",
      {
        outputSchema: z.object({ answer: z.string() }).superRefine(async () => {
          if (stage === "validation") {
            validationStarted()
            await release
          }
        }),
      },
      async () => {
        if (stage === "handler") {
          validationStarted()
          await release
        }
        return { structuredContent: { answer: "Finished after disconnection" }, content: [] }
      }
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await runWithAgent("disconnected-validation", async () => {
      setAgentTaskSlug("disconnected-validation")
      const disconnected = assert.rejects(client.callTool({ name: "disconnect" }), /closed/iu)
      await started
      assert.ok(agentObserver.listAgents()[0]?.current)
      await server.close()
      await disconnected
      const snapshot = agentObserver.listAgents()[0]
      assert.equal(snapshot?.current, undefined)
      assert.equal(snapshot?.recent[0]?.status, "failed")
      assert.equal(snapshot?.recent[0]?.response, undefined)
      assert.equal(
        observed.mock.calls.filter(({ arguments: [call] }) => call.status === "failed").length,
        1
      )
      releaseValidation()
      await setImmediate()
      assert.equal(
        observed.mock.calls.filter(({ arguments: [call] }) => call.status === "failed").length,
        1
      )
      assert.equal(
        observed.mock.calls.filter(({ arguments: [call] }) => call.status === "completed").length,
        0
      )
    })
  })
}

for (const mode of ["auto", "legacy"] as const) {
  test(`audit and dashboard share SDK rejections before and after dispatch in ${mode} mode`, {
    timeout: 10_000,
  }, async (t) => {
    const agentObserver = createAgentObserver()
    const auditLogger = new McpAuditLogger(join(await tempDir(t, "call-rejections-"), "audit.yaml"))
    const audited = t.mock.method(auditLogger, "recordToolCall")
    const inputHandler = t.mock.fn(async () => ({ content: [] }))
    const running = await startMcpHttpServer(
      {
        agentObserver,
        auditLogger,
        createMcpServer: (context) => {
          const server = new McpServer(
            { name: "http-validation", version: "1.0.0" },
            {},
            context?.calls
          )
          const register = createToolRegistrar(server, { structuredOutput: true, ...context })
          register("start_here", {}, async () => {
            setAgentTaskSlug("http-validation")
            return { content: [{ type: "text", text: "Ready" }] }
          })
          register(
            "invalid_output",
            { outputSchema: z.object({ answer: z.string() }) },
            async () => ({
              structuredContent: { answer: 123 },
              content: [],
            })
          )
          register("invalid_input", { inputSchema: z.object({ value: z.string() }) }, inputHandler)
          return server
        },
      },
      { host: "127.0.0.1", port: 0 }
    )
    t.after(() => running.close())
    const client = new Client(
      { name: "http-validation-client", version: "1.0.0" },
      { versionNegotiation: { mode } }
    )
    t.after(() => client.close())
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: { headers: { "x-openai-session": `http-validation-${mode}` } },
      })
    )
    await client.callTool({ name: "start_here" })
    for (const name of ["invalid_output", "invalid_input", "unknown_tool"]) {
      const received = await client.callTool({ name, arguments: { value: 42 } }).catch((error) => {
        // Legacy MCP rejects unknown tools at the protocol level instead of returning a tool error.
        assert.equal(name, "unknown_tool")
        assert.match(error.message, /Tool unknown_tool not found/u)
        return { isError: true, content: [{ type: "text" as const, text: error.message }] }
      })
      assert.equal(received.isError, true)
      assert.ok(Array.isArray(received.content))
      const expected = received.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n\n")
      const dashboard = await fetch(`http://${running.host}:${running.port}/ui/api/agents`)
      const body = (await dashboard.json()) as {
        agents: Array<{
          current?: unknown
          recent: Array<{ id: string; status: string; response?: string }>
        }>
      }
      const call = audited.mock.calls.at(-1)?.arguments[0]
      assert.equal(body.agents[0]?.current, undefined)
      assert.equal(body.agents[0]?.recent[0]?.status, "failed")
      assert.equal(body.agents[0]?.recent[0]?.response, expected)
      assert.equal(body.agents[0]?.recent[0]?.id, call?.id)
      assert.equal(call?.tool, name)
      // The modern wire envelope also contains resultType, which Client strips on receipt.
      const recorded = call?.response as { content: unknown; isError: boolean }
      assert.deepEqual(recorded.content, received.content)
      assert.equal(recorded.isError, received.isError)
    }
    assert.equal(inputHandler.mock.callCount(), 0)
    assert.equal(audited.mock.callCount(), 4)
  })
}

for (const structuredOutput of [false, true]) {
  test(`captures SDK output validation failures with structuredOutput=${structuredOutput}`, async (t) => {
    const agentObserver = createAgentObserver()
    const audits: CompletedToolCall[] = []
    const server = new McpServer(
      { name: "validated-response", version: "1.0.0" },
      {},
      new ToolCallTracker({
        agentObserver,
        auditLogger: {
          recordToolsList() {},
          recordToolCall(call) {
            audits.push(call)
          },
        },
      })
    )
    const client = new Client({ name: "validated-response-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    const observed = t.mock.method(agentObserver, "observeToolCall")
    const register = createToolRegistrar(server, {
      structuredOutput,
      agentObserver,
    })
    const callback = t.mock.fn(async ({ missing }: { missing: boolean }) => ({
      ...(missing ? {} : { structuredContent: { answer: 123 } }),
      content: [{ type: "text" as const, text: "This rejected answer must not appear as output." }],
    }))
    register(
      "validated",
      {
        nativeContent: true,
        inputSchema: z.object({ missing: z.boolean() }),
        outputSchema: z.object({ answer: z.string() }),
      },
      callback
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await runWithAgent(`validated-response-${structuredOutput}`, async () => {
      setAgentTaskSlug("validated-response")
      for (const missing of [false, true]) {
        const received = await client.callTool({ name: "validated", arguments: { missing } })
        assert.equal(received.isError, true)
        assert.ok(Array.isArray(received.content))
        const expected = received.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n\n")
        assert.match(expected, /Output validation error/u)
        const observed = agentObserver.listAgents()[0]?.recent[0]
        assert.equal(observed?.status, "failed")
        assert.equal(observed?.response, expected)
        assert.deepEqual(audits.at(-1)?.response, received)
      }
    })
    assert.equal(callback.mock.callCount(), 2)
    assert.equal(
      observed.mock.calls.filter(({ arguments: [call] }) => call.status === "completed").length,
      0,
      "Never publish success before SDK validation"
    )
    assert.equal(
      observed.mock.calls.filter(({ arguments: [call] }) => call.status === "failed").length,
      2
    )
    assert.equal(audits.length, 2)
  })
}

for (const structuredOutput of [false, true]) {
  test(`captures the returned response and steering with structuredOutput=${structuredOutput}`, async (t) => {
    const agentObserver = createAgentObserver()
    const server = new McpServer(
      { name: "response-capture", version: "1.0.0" },
      {},
      new ToolCallTracker({ agentObserver })
    )
    const client = new Client({ name: "response-capture-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    const register = createToolRegistrar(server, { structuredOutput, agentObserver })
    register("capture", { inputSchema: z.object({ fail: z.boolean() }) }, async ({ fail }) => {
      const agent = agentObserver.listAgents()[0]
      assert.ok(agent)
      agentObserver.queueInstruction(agent.id, "Captured steering instruction")
      if (fail) throw new ToolError("EXPECTED", "Captured failure")
      return { structuredContent: { answer: "Captured answer" }, content: [] }
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await runWithAgent(`response-capture-${structuredOutput}`, async () => {
      setAgentTaskSlug("response-capture")
      for (const fail of [false, true]) {
        const result = await client.callTool({ name: "capture", arguments: { fail } })
        const captured = agentObserver.listAgents()[0]?.recent[0]
        assert.equal(captured?.status, fail ? "failed" : "completed")
        assert.ok(captured?.response)
        assert.match(captured.response, fail ? /EXPECTED: Captured failure/u : /Captured answer/u)
        assert.match(captured.response, /Human instruction: Captured steering instruction/u)
        assert.ok(Array.isArray(result.content))
        for (const block of result.content) {
          if (block.type === "text") assert.ok(captured.response.includes(block.text))
        }
      }
    })
  })
}

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
    const agentObserver = createAgentObserver()
    const audits: CompletedToolCall[] = []
    const server = new McpServer(
      { name: "failure-boundary", version: "1.0.0" },
      {},
      new ToolCallTracker({
        agentObserver,
        auditLogger: {
          recordToolsList() {},
          recordToolCall(call) {
            audits.push(call)
          },
        },
      })
    )
    const client = new Client({ name: "failure-client", version: "1.0.0" })
    t.after(() => Promise.all([client.close(), server.close()]))
    const observed = t.mock.method(agentObserver, "observeToolCall")
    let noticeDrains = 0
    const register = createToolRegistrar(server, {
      structuredOutput,
      agentObserver,
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
        assert.ok(Array.isArray(result.content))
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
      assert.deepEqual(success.content, [
        { type: "text", text: "Done\n\n**Notice:** fixture notice" },
      ])
      assert.equal(
        observed.mock.calls.filter(({ arguments: [call] }) => call.status === "failed").length,
        6
      )
      assert.equal(
        observed.mock.calls.filter(({ arguments: [call] }) => call.status === "completed").length,
        1
      )
      assert.equal(audits.length, 7)
      assert.equal(noticeDrains, 7)
      const agent = agentObserver.listAgents()[0]
      assert.equal(agent?.current, undefined)
      assert.equal(agent?.recent.filter((call) => call.status === "failed").length, 6)
      assert.equal(agent?.recent.filter((call) => call.status === "completed").length, 1)
      assert.ok(audits.every((audit) => audit?.toolResult && audit.response))
      assert.ok(audits[1]?.error instanceof ToolError)
      assert.equal((audits[1].error.cause as Error).message, "private cause")
    })
  })
}
