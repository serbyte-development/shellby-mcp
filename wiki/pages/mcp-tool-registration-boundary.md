---
summary: "Tool registration, SDK validation, final-response tracking, compact/native output, and notices."
paths:
  - src/mcp/server-factory.ts
  - src/mcp/tool-registration-boundary.ts
  - src/mcp/tool-schema-presentation.ts
  - src/mcp/tool-output.ts
  - src/mcp/tool-error.ts
  - src/mcp/observed-server.ts
  - src/mcp/tool-call-tracker.ts
  - src/server/http-server.ts
---

# MCP Tool Registration Boundary

## Registration contract

[server-factory.ts](../../src/mcp/server-factory.ts) creates a fresh [ObservedMcpServer](../../src/mcp/observed-server.ts) and obtains a typed `ToolRegistrar` from [createToolRegistrar](../../src/mcp/tool-registration-boundary.ts). Every capability receives that function and uses `registerTool(name, config, handler)`.

The registrar owns Shellby dispatch policy; SDK owns registration and validation. `ObservedMcpServer` observes final transport responses without replacing SDK validation. Capability modules need no server or installation-order knowledge. Register native image/resource tools with `nativeContent: true`; this local policy flag is removed before SDK registration and is independent of the tool name.

## Call lifecycle

1. HTTP seeds one [ToolCallTracker](../../src/mcp/tool-call-tracker.ts) from raw request IDs, before SDK dispatch. This includes unknown tools and invalid inputs; remote authorization failures happen earlier.
2. SDK resolves tool and validates input. Registrar runs the handler inside the tracker's diagnostic scope and checks startup initialization. Non-HTTP dispatch can start a record here.
3. Handler receives validated arguments and context; inputless handlers receive context alone. Registrar projects results or formats errors, then appends notices.
4. SDK validates any published output schema. `ObservedMcpServer` passes the final result/error to the tracker at transport handoff, including SDK rejection after a successful handler.
5. Tracker completes observer and audit once. Cancellation or HTTP termination settles unfinished calls; late handler results cannot complete them again.

Tracker owns call IDs, timing, original diagnostics and token counts; observer and audit consume snapshots. Consumer failures are isolated from execution and each other. Transport handoff is not proof of client receipt. [HTTP Transport](./http-transport.md) owns request lifetime; [Audit Logging](./operations/audit-logging.md) owns retained data.

Cumulative usage belongs to canonical [agent identity](./agent-context.md) across request trackers. Attempts count at registration, including rejected calls; output counts at response handoff. History eviction does not reset totals. Restart does. Review prompts and dashboard totals consume the same usage owner.

## Representation owners

[tool-schema-presentation.ts](../../src/mcp/tool-schema-presentation.ts) owns advertised schema projection, annotation pruning, and output-schema visibility. The registrar selects native/structured output from registration metadata and server mode. Zod/SDK runtime validation remains intact. [Tool Design](./tool-naming-and-schema-design.md) explains projection constraints.

With compact output, ordinary tools omit public output schemas and pass through [tool-output.ts](../../src/mcp/tool-output.ts). Structured mode retains structured results and output schemas. Tools declaring `nativeContent: true` preserve returned native content in both modes. SDK output validation remains outside the registrar and depends on the published output schema.

Tool adapters throw [ToolError](../../src/mcp/tool-error.ts) with a public code, message, and optional original cause. Domain-specific translation and recovery stay with their capability. The output boundary renders errors directly as `isError` plus one `CODE: message` text; structured mode also supplies `structuredContent.error_code`. This applies to thrown errors from native tools too. Unclassified exceptions use `internal_error`. Audit receives the original exception and retains a bounded cause code/message in its failure entry.

## Notices and failures

Notice order: shell file-edit guidance → delegated events → human steering → optional review prompt. Every dispatched call collects notices, including returned failures, thrown handlers, and startup rejections. SDK input-validation failures bypass dispatch and do not drain notices.

Initialization rejection, thrown handlers, returned `isError` results and SDK rejection all fail observation and audit. Input-validation failures bypass notice collection but remain tracked on HTTP. Delegation and patch results retain useful per-item or partial-operation data; their owners classify aggregate failure. Delegation catches call `recordToolError` before replacing original errors with recovery guidance. Tracker scopes those diagnostics to the current call; concurrent polls stay isolated.

Audit receives handler metadata and final SDK output without buffering HTTP serialization. SDK-rejected successful output is replaced by the rejection in the completed record. Capability processes and caches belong to shared services, not these wrappers.

Validate with [tracker tests](../../test/mcp/tool-call-tracker.test.ts), [boundary tests](../../test/mcp/tool-registration-boundary.test.ts), [schema tests](../../test/mcp/tool-schema-presentation.test.ts), [output tests](../../test/mcp/tool-output.test.ts), and MCP integration cases for initialization/audit.
