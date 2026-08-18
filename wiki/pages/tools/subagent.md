# `subagent_run` / `subagent_result`

Verified 2026-08-18.

## What This Is

Caller-facing contract for detached browser-backed ChatGPT delegation. Browser ownership and implementation live in [Browser ChatGPT Subagents](../Browser%20ChatGPT%20Subagents.md); completion and recovery internals live in [Subagent Completion and Recovery](../Subagent%20Completion%20and%20Recovery.md).

## `subagent_run`

One call accepts one to three distinct agents. Each entry provides:

- `agent_id`: persistent conversation identity. Reuse it to retain context.
- `prompt`: task for that turn.
- `oververbosity`: optional 1-5 response verbosity, applied only when the `agent_id` creates its first conversation.

The result returns one `turn_id` per successfully submitted entry. Reusing an `agent_id` while it already has active work returns `AGENT_BUSY`. At most three generations run process-wide; excess work returns `SUBAGENT_CAPACITY_REACHED` instead of entering a hidden queue (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

Three-entry batches are submitted with the configured stagger of 0, 5, and 7 additional seconds. A failed entry does not roll back already-submitted siblings (`src/tools/subagent/subagent-tools.ts`).

## `subagent_result`

Pass one to three previously returned `turn_id` values. Results are retrieved concurrently and isolated per turn:

- `running`: may include `activity` and `activity_age_ms`.
- `completed`: includes `response`.
- `failed`: includes one `error` string.

`wait_ms` may wait up to 270 seconds while still-running turns are reconciled. Retrieval never resubmits the prompt (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

Running activity is one of `Working`, `Searching the web`, `Using tools`, or `Generating response`. `activity_age_ms` measures time since observable browser/network progress, not time since the last poll and not an ETA (`src/tools/subagent/chatgpt-subagent.ts`).

## Lifetime and Failure Consequences

Conversation bindings and turn records are process-local. Idle runtime state may be reclaimed while the saved conversation reference remains reusable within the same MCP process; a full MCP restart loses those bindings. Old reclaimed turn IDs are no longer retrievable (`src/tools/subagent/chatgpt-subagent.ts`).

Important public failures include `BROWSER_UNAVAILABLE`, `CHATGPT_NOT_AUTHENTICATED`, `AGENT_BUSY`, `SUBAGENT_CAPACITY_REACHED`, `AGENT_TARGET_LOST`, `SUBAGENT_CONVERSATION_NOT_FOUND`, `UNKNOWN_TURN`, `REQUEST_ABORTED`, and `CHATGPT_UI_CHANGED` (`src/tools/subagent/chatgpt-subagent-contracts.ts`).

Detached completion queues an `agent_finished` event that is delivered on the next MCP tool response; retrieve the answer explicitly with `subagent_result`. See [Subagent Completion and Recovery](../Subagent%20Completion%20and%20Recovery.md).

## Related

- [Browser ChatGPT Subagents](../Browser%20ChatGPT%20Subagents.md)
- [Subagent Completion and Recovery](../Subagent%20Completion%20and%20Recovery.md)
- [MCP Tool Surface](../MCP%20Tool%20Surface.md)
