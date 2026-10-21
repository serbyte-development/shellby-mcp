---
summary: "Caller identity, observed parent links, restored lineage, and dashboard observation/steering."
paths:
  - src/agent/context.ts
  - src/agent/observer.ts
  - src/agent/dashboard-routes.ts
  - src/agent/tool-call-presentation.ts
  - src/tools/start-here/start-here.ts
  - src/tools/delegation/subagents.ts
  - src/tools/delegation/turn-protocol.ts
  - src/tools/delegation/store.ts
---

# Agent Context

[context.ts](../../src/agent/context.ts) maps each opaque `X-OpenAI-Session` to one canonical `AgentIdentity`: session ID, readable `agent-N` alias, optional task slug and parent reference. AsyncLocalStorage carries identity through a request. Successful `start_here` sets the task slug. Aliases and initialization are process-local; saved parent links can repopulate the registry after restart. Headerless requests have no identity.

[HTTP Transport](./http-transport.md) owns authorization. [MCP Tool Surface](./mcp-tool-surface.md) owns startup gating. Audit, review, instruction deduplication, delegation, and steering share the canonical identity; do not invent parallel session registries.

## Dashboard ownership

When enabled, one [observer](../../src/agent/observer.ts) projects [call lifecycle events](./mcp-tool-registration-boundary.md#call-lifecycle) into concurrent activity, bounded recent history and queued instructions. [tool-call-presentation.ts](../../src/agent/tool-call-presentation.ts) owns bounded input/response previews. Snapshots include canonical `parentId` and cumulative tool usage; neither is inferred from retained history. Parent-link subscriptions publish newly resolved relationships to connected dashboards.

[dashboard-routes.ts](../../src/agent/dashboard-routes.ts) owns `/api/*` snapshot/SSE and steering routes, plus static `/` and `/editor` serving. Legacy `/ui/*` routes redirect with HTTP 308, preserving methods and bodies. Steering targets observed `agent-N` identities and drains in submission order on a later dispatched tool response. It cannot interrupt upstream generation or a pending tool. Observer state disappears on restart. Frontend grouping and presentation belong to the [UI wiki](../../ui/wiki/AGENTS.md); exposure belongs to [HTTP Transport](./http-transport.md).

## Observed parent links

[start-here.ts](../../src/tools/start-here/start-here.ts) prefixes successful identified startup responses with a JSON identity header. The browser [turn tracker](../../src/tools/delegation/turn-protocol.ts) reports fresh completed MCP tool results from the submitted turn. [subagents.ts](../../src/tools/delegation/subagents.ts) resolves that header against the canonical registry and binds the child to the launching identity. Prompt text, inherited history and tool-name/timing guesses are not evidence. [Historical rationale](../log.md#2026-10-21--parent-links-use-observed-startup-identity) preserves the rejected heuristic.

`bindAgentParent` rejects self-links, conflicting parents and cycles; repeated identical evidence is harmless. [store.ts](../../src/tools/delegation/store.ts) persists the optional child session ID with its conversation and restores parent links on open. Children that never expose a startup response remain unlinked. Saved lineage does not restore initialization, call history or turn results. [Completion events](./subagents/subagent-completion.md) still route to the captured launching identity.

Tests: [context](../../test/agent/context.test.ts), [observer](../../test/agent/observer.test.ts), [startup integration](../../test/integrations/session-initialization.ts), [fresh/forked lineage](../../test/tools/delegation/subagents.test.ts), and [persistence](../../test/tools/delegation/store.test.ts).
