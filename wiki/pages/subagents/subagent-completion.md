---
summary: "Completion authority, bounded history recovery, uncertain agents, and restart/event semantics."
paths:
  - src/tools/delegation/chatgpt-service.ts
  - src/tools/delegation/lifecycle.ts
  - src/tools/delegation/response-observer.ts
  - src/tools/delegation/turn-protocol.ts
  - src/tools/delegation/chatgpt-browser.ts
---

# Subagent Completion

## Normal completion

[response-observer.ts](../../../src/tools/delegation/response-observer.ts) installs one observation before Send. HTTP conversation SSE and turn WebSocket frames use separate instances of the same [turn tracker](../../../src/tools/delegation/turn-protocol.ts); first valid completion wins. HTTP also has a completed-response-body fallback.

A tracker binds only to the submitted prompt, after NFKC/whitespace normalization. It reconstructs assistant deltas and requires nonempty final text, `finished_successfully`, `end_turn=true`, recipient `all`/empty, and explicit stream completion. Tool-call messages cannot complete a turn.

After binding, nonempty stream blocks refresh activity even without a new coarse label: SSE heartbeats and safety-review events count. Pre-binding traffic does not. [CDP Transport](./chatgpt-cdp-transport.md) owns acquisition/probe details. DOM text is not completion authority.

## Bounded recovery

[lifecycle.ts](../../../src/tools/delegation/lifecycle.ts) schedules recovery after three minutes without activity for saved agents, or the longer idle cutoff for other turns. Page/observer failure enters the same path. Recovery is attempted at most once and requires a saved conversation URL.

Current [recoverSubmittedTurn](../../../src/tools/delegation/chatgpt-service.ts) sequence:

1. Dispose old observation. If the existing page still matches the conversation, try a page-context GET to `/backend-api/conversations/<id>`.
2. If that does not prove completion, create one replacement background page and capture conversation JSON during navigation.
3. Accept history only when user-turn count matches the recorded count and a final answer follows the submitted prompt. This rejects an older identical prompt. History prompt matching is trimmed equality, stricter than live-stream normalization.

No Send, resubmission, second live observer, or repeated reconciliation loop. Unproven recovery fails locally and marks the agent `uncertain`, blocking reuse with `AGENT_BUSY`; upstream work may still be running. History with extra/inherited user turns may fail the count check. The older singular-endpoint failure in [log.md](../../log.md) is historical evidence, not a description of this current plural-endpoint fallback.

## Results and events

Result polling waits only on local settlement; it never contacts ChatGPT. Lifecycle retains the latest 100 settled results per caller for up to 24 hours, ordered by settlement. Completed and failed turns share that budget; running turns are excluded. Lookup, settlement, and idle cleanup prune results. Evicted/expired IDs return `UNKNOWN_TURN`. Settlement releases prompt text and observation references. Turn results also vanish on MCP restart even when saved conversation mappings survive.

Successful settlement queues one `agent_finished` notice for the captured launching identity. Failed turns settle without that success notice. The first event drain per caller also emits `existing_agent` hints from saved mappings. Those hints identify reusable conversations; their `latest_turn_id` does not imply an old result was restored.

[Registration Boundary](../mcp-tool-registration-boundary.md) appends/drains notices on eligible tool responses. Tests: [protocol/repeated-prompt cases](../../../test/tools/delegation/turn-protocol.test.ts), [restart hints](../../../test/tools/delegation/delegated-agent-limit.test.ts), [retention/settlement](../../../test/tools/delegation/lifecycle.test.ts), [service](../../../test/tools/delegation/chatgpt-service.test.ts). Live compatibility requires [separate validation](../operations/build-and-test.md).
