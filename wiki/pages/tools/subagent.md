---
summary: "Subagent caller contract: identity, temporary memory, polling, capacity, and failure guidance."
paths:
  - src/tools/delegation/subagent-tools.ts
  - src/tools/delegation/contracts.ts
  - src/tools/delegation/turn-results.ts
  - src/tools/delegation/lifecycle.ts
---

# subagent_run / subagent_result

[subagent-tools.ts](../../../src/tools/delegation/subagent-tools.ts) owns public schemas and error projection. Use `npm run schemas -- subagent_run subagent_result` for current limits. [Delegation Runtime](../subagents/browser-chatgpt-subagents.md) owns browser orchestration, capacity, and persistence.

`subagent_run` submits a small batch with distinct agent IDs, staggered between entries. Reuse an ID within the same calling MCP session to continue its conversation. The configured delegated-ID cap counts saved/live/reserved IDs across subagents and clones; it is independent of batch size. Existing IDs remain reusable at capacity.

`memory` is chosen when an agent is created. False creates a temporary ChatGPT chat with live multi-turn continuity but no saved restoration. Reusing a live ID with a different flag does not change its mode. Page loss or restart loses temporary context; idle-expired IDs return `TEMP_AGENT_EXPIRED`.

## Polling and result lifetime

[subagent_result](../../../src/tools/delegation/turn-results.ts) retrieves local turn state concurrently: `running` with optional activity/age, `completed` with response, or `failed` with error. `wait_ms` waits for local settlement and does not set a generation deadline or poll ChatGPT.

Any failed polled turn sets top-level `isError=true`, including unknown IDs and polling exceptions. Mixed batches preserve successful answers. Submission failures are per-entry `status=failed`; `subagent_run` does not use the same top-level error aggregation.

Turn results are process-local. Saved conversation mappings can restore identity, not old answers or polling records. Completion notices and restart hints are defined in [Subagent Completion](../subagents/subagent-completion.md).

## Failure semantics

- `AGENT_LIMIT_REACHED` lists existing IDs/latest known turns for reuse; these hints do not guarantee result availability after restart.
- `SUBAGENT_PERSISTENCE_UNAVAILABLE` blocks admission before a new prompt is sent. Post-submit persistence failure leaves that detached turn valid.
- `AGENT_BUSY` includes uncertain upstream state after unproven recovery. Use another available ID; overlapping the same conversation would risk duplicate work.
- Browser/auth/UI availability errors become `SUBAGENT_UNAVAILABLE`: retry the same call once, then continue without delegation. Do not rewrite the task around infrastructure failure.
- Rate limits prohibit automatic retry; request cancellation does not trigger resubmission.

Keep backend diagnostics behind the adapter. [Historical rationale](../../log.md) records why leaking browser failures misdirected callers. Tests: [MCP delegation cases](../../../test/integrations/subagent.ts), plus lifecycle/protocol routes in [Build and Test](../operations/build-and-test.md).
