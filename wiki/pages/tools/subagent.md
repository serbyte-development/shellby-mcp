---
summary: "Subagent tool boundary: start_from, agent versus turn identity, batch outcomes, and error projection."
paths:
  - src/tools/delegation/subagent-tools.ts
  - src/tools/delegation/subagents.ts
  - src/tools/delegation/subagent-error.ts
---

# subagent_run / subagent_result

[subagent-tools.ts](../../../src/tools/delegation/subagent-tools.ts) owns schemas, wire results and error projection. [createSubagents](../../../src/tools/delegation/subagents.ts) owns execution. Inspect source or `npm run schemas -- subagent_run subagent_result` for exact arguments and limits.

`agent_id` is a caller-scoped agent name; reuse it for follow-ups in its saved conversation. A returned `turn_id` identifies one submitted turn and belongs in `subagent_result`.

For a new agent, `start_from` supplies a ChatGPT conversation URL: create a branch from that conversation, then submit the prompt into it. Without a source, start a new conversation at the configured project. Existing agents resume their own saved conversation even when `start_from` is supplied. All conversations use the same saved-identity lifecycle. Unknown per-agent fields are rejected rather than silently changing the requested operation.

`runAgents` staggers submissions and returns after every attempted startup, preserving individual outcomes. Generation continues independently; cancellation stops unsent work without cancelling submitted turns. Identity capacity is separate from batch size; see [runtime admission](../subagents/browser-chatgpt-subagents.md#identity-and-lifetime).

## Results and failures

Polling waits on local results concurrently; `wait_ms` is not a generation deadline. [Completion](../subagents/subagent-completion.md) owns retention, notices and restart consequences.

Any failed entry sets top-level `isError=true`; mixed batches still retain successful entries. Never retry an entire mixed batch blindly.

Record original errors for audit before projecting caller guidance. Browser/auth/UI errors become `SUBAGENT_UNAVAILABLE`: retry the same call once, then continue without delegation. Rate limits prohibit automatic retry. Infrastructure errors must not cause callers to rewrite the delegated task; [historical rationale](../../log.md) explains why. `AGENT_BUSY` can also mean uncertain upstream work, not merely a locally running turn.

Wire-contract tests: [MCP subagent cases](../../../test/integrations/subagent.ts). Runtime and live checks: [Subagent Testing](../subagents/testing.md).
