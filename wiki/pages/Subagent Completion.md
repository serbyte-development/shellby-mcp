# Subagent Completion

Verified 2026-08-23 against current source and deterministic tests.

## Completion Authority

One authority completes normal turns: structured ChatGPT turn data observed directly through CDP. The observer accepts either `/backend-api/f/conversation` SSE (`Network.streamResourceContent` + `Network.dataReceived`) or `conversation-turn-*` WebSocket frames (`Network.webSocketFrameReceived`); both feed the same exact-prompt tracker.

The tracker binds only when a candidate stream contains the exact submitted user prompt. It then reconstructs assistant v1 text patches. Completion requires a final assistant message with `status: finished_successfully`, `end_turn: true`, recipient `all`/empty, plus an explicit stream-completion signal. Tool-call assistant messages such as `recipient: web.run` cannot complete the turn.

The same stream provides `conversation_id`; the runtime uses it to capture or construct the stable conversation URL stored on the owning agent.

There is no DOM completion observer or application-level `stream_status` polling.

## Recovery

Every submitted turn gets at most one catastrophic recovery attempt. Observer/page failure, or 30 minutes without observable progress, disposes the old observer and opens one fresh background page at the saved conversation URL. The recovery navigation reads ChatGPT's conversation payload once and completes locally only when it contains a final assistant answer after the exact submitted prompt.

Recovery never clicks Send, resubmits the prompt, or attaches a second turn observer. If that single history read has no matching final answer, or the recovery navigation fails, the turn fails immediately and releases global generation capacity, but the agent becomes `uncertain` because ChatGPT may still be processing upstream. That `agent_id` rejects later submissions with `AGENT_BUSY`; callers can use a new `agent_id` rather than risk overlapping turns in the same conversation.

This is separate from pre-submit restoration: a closed idle page or mismatched conversation URL is corrected before observation and submission, using the existing managed page when possible and one new background page otherwise.

## Detached Result Lifecycle

`subagent_run` returns after one successful submission. The observer completes the local turn asynchronously and queues exactly one `agent_finished:<agent_id>:<turn_id>` event.

`subagent_result(wait_ms)` only waits on the turn's local settlement promise. It never contacts ChatGPT, refreshes the browser, or performs reconciliation.

Completed/failed results remain available locally even after idle cleanup closes the agent's page. Idle cleanup preserves the agent conversation reference and turn count so a later turn can restore context.

## Invariants

1. Submit each requested turn at most once.
2. Same `agent_id` remains bound to the same ChatGPT conversation, even across background-page replacement.
3. Raw CDP turn data is the only normal completion authority.
4. Bind a stream only to the exact submitted prompt.
5. Tool-call messages cannot masquerade as final answers.
6. `subagent_result` reads local state only.
7. Recovery may navigate and read conversation history once, but never resubmits.
8. A turn cannot remain without observable progress for more than 30 minutes before recovery or final failure.
9. An unreconciled submitted turn leaves its agent `uncertain` and unavailable for reuse.
10. Existing interaction/inter-turn delays and rate-limit cooldown remain in force.

## Related

- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [ChatGPT CDP Transport](./ChatGPT%20CDP%20Transport.md)
- [`subagent_run` / `subagent_result`](./tools/subagent.md)
