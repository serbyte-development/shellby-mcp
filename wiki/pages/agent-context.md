---
summary: "Caller identity, task labels, dashboard observation/steering, and why lineage is not inferred."
paths:
  - src/agent/context.ts
  - src/agent/observer.ts
  - src/agent/dashboard-routes.ts
  - src/agent/tool-call-presentation.ts
  - src/mcp/tool-registration-boundary.ts
  - src/server/http-server.ts
---

# Agent Context

[context.ts](../../src/agent/context.ts) maps each opaque `X-OpenAI-Session` to one canonical process-local `AgentIdentity`: session ID, readable `agent-N` alias, and optional task slug. AsyncLocalStorage carries that identity through a request. Successful `start_here` sets the task slug; aliases and initialization disappear on restart. Headerless requests have no identity.

[HTTP Transport](./http-transport.md) owns authorization. [MCP Tool Surface](./mcp-tool-surface.md) owns startup gating. Audit, review, instruction deduplication, delegation, and steering share the canonical identity; do not invent parallel session registries.

## Dashboard ownership

When enabled, one [observer](../../src/agent/observer.ts) tracks concurrent calls, bounded recent history, and queued instructions. [tool-call-presentation.ts](../../src/agent/tool-call-presentation.ts) owns displayed summaries. The [registrar](./mcp-tool-registration-boundary.md) marks returned `isError` results, thrown exceptions, and initialization rejections as `failed`. SDK validation outside dispatch remains outside observation.

[dashboard-routes.ts](../../src/agent/dashboard-routes.ts) owns snapshot/SSE, steering queue/cancellation, and static `/ui`/`/ui/editor` serving. Steering targets observed `agent-N` identities and drains in submission order on a later tool response. It cannot interrupt upstream generation or a pending tool. State disappears on restart. Frontend contracts and presentation belong to the [UI wiki](../../ui/wiki/AGENTS.md).

## No inferred lineage

Browser-backed agents do not expose a proven identifier join to incoming MCP sessions. An earlier experiment matched CDP tool calls to MCP requests by tool name/time window; repeated calls and races produced false self/parent associations. Argument matching would remain heuristic. Reconsider lineage only after proving a deterministic identifier on both sides.

Delegated turns capture their launching identity; [completion/events](./subagents/subagent-completion.md) route back to that owner without classifying later callers as children.

Tests: [context](../../test/agent/context.test.ts), [observer](../../test/agent/observer.test.ts), and [startup integration](../../test/integrations/session-initialization.ts).
