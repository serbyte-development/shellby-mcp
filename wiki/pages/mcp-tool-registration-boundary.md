---
summary: "Explicit tool registrar, SDK validation, compact/native results, notices, and audit correlation."
paths:
  - src/mcp/server-factory.ts
  - src/mcp/tool-registration-boundary.ts
  - src/mcp/tool-schema-presentation.ts
  - src/mcp/tool-output.ts
  - src/server/audit/audit-request.ts
---

# MCP Tool Registration Boundary

## Registration contract

[server-factory.ts](../../src/mcp/server-factory.ts) creates a fresh `McpServer` and obtains a typed `ToolRegistrar` from [createToolRegistrar](../../src/mcp/tool-registration-boundary.ts). Every capability receives that function and uses `registerTool(name, config, handler)`.

The registrar owns Shellby dispatch policy and delegates registration to the unchanged SDK server. Capability modules need no server or installation-order knowledge. Register native image/resource tools with `nativeContent: true`; this local policy flag is removed before SDK registration and is independent of the tool name.

## Call flow

1. SDK resolves tool and validates input.
2. Wrapper claims audit entry by request ID/tool name and checks startup initialization.
3. Observer starts; handler receives original validated arguments and context. Inputless handlers receive context alone.
4. Wrapper completes observation, projects result, appends notices, and finishes audit.
5. SDK validates any published output schema.

HTTP auth and audit records for calls rejected before dispatch stay outside this wrapper. See [HTTP Transport](./http-transport.md) and [Audit Logging](./operations/audit-logging.md).

## Representation owners

[tool-schema-presentation.ts](../../src/mcp/tool-schema-presentation.ts) owns advertised schema projection, annotation pruning, and output-schema visibility. The registrar selects native/structured output from registration metadata and server mode. Zod/SDK runtime validation remains intact. [Tool Design](./tool-naming-and-schema-design.md) explains projection constraints.

With compact output, ordinary tools omit public output schemas and pass through [tool-output.ts](../../src/mcp/tool-output.ts). Structured mode retains structured results and output schemas. Tools declaring `nativeContent: true` preserve native content in both modes. Explicit `structuredContent.error_code` metadata survives compact error projection.

## Notices and failures

Notice order: shell file-edit guidance → delegated events → human steering → optional review prompt. Returned tool errors still collect notices. Startup rejections, thrown handlers, and SDK input-validation failures do not drain them.

Thrown handlers become text tool errors and fail observation/audit. A returned error completes the observer's callback lifecycle; audit independently classifies failure. Do not equate dashboard `completed` with successful tool work.

Audit receives both handler result and final projection, including notices, without inspecting serialized HTTP output. Capability processes and caches belong to shared services, not these wrappers.

Validate with [boundary tests](../../test/mcp/tool-registration-boundary.test.ts), [schema tests](../../test/mcp/tool-schema-presentation.test.ts), [output tests](../../test/mcp/tool-output.test.ts), and MCP integration cases for initialization/audit.
