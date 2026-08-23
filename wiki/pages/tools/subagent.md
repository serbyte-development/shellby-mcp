# `subagent_run` / `subagent_result`

Verified 2026-08-23.

## What This Is

Caller-facing contract for detached browser-backed ChatGPT delegation. Public tool descriptions and schemas are defined in `src/tools/subagent/subagent-tools.ts`. Browser implementation lives in [Browser ChatGPT Subagents](../Browser%20ChatGPT%20Subagents.md); completion lives in [Subagent Completion](../Subagent%20Completion.md).

## `subagent_run`

One call accepts one to three distinct agents. Each entry provides:

- `agent_id`: persistent in-process conversation identity; reuse it for multi-turn context.
- `prompt`: task for that turn.
- `oververbosity`: optional 1-5 value applied only when that `agent_id` creates its first conversation.

A new agent starts from the configured ChatGPT project URL when present. Reused agents continue in or restore the same ChatGPT conversation. At most three generations run process-wide. Three-entry batches retain the existing staggered submission delays.

## `subagent_result`

Pass one to three returned `turn_id` values. Results are retrieved concurrently from local turn state:

- `running`: may include `activity` and `activity_age_ms`;
- `completed`: includes `response`;
- `failed`: includes `error`.

`wait_ms` waits on the local settlement promise only. It never polls or reloads ChatGPT.

Activity remains one of `Working`, `Searching the web`, `Using tools`, or `Generating response`.

## Lifetime and Failures

Agent state and turn records are process-local. A full MCP restart loses the local `agent_id` conversation mapping.

After 30 idle minutes, only the managed background page closes; the saved conversation identity and prior results remain. A later call restores that conversation. Submitted turns also have a 30-minute no-progress cutoff and one recovery attempt that reopens and reads the saved conversation once but never resubmits the prompt or waits on a second observer. If recovery cannot prove the submitted turn finished, that agent is marked `uncertain` and rejects later prompts with `AGENT_BUSY`; use a new `agent_id` instead of risking an overlapping upstream turn.

Important failures include `BROWSER_UNAVAILABLE`, `CHATGPT_NOT_AUTHENTICATED`, `AGENT_BUSY`, `SUBAGENT_CAPACITY_REACHED`, `AGENT_TARGET_LOST`, `AGENT_IDLE_EXPIRED`, `UNKNOWN_TURN`, `REQUEST_ABORTED`, and `CHATGPT_UI_CHANGED`.

Detached completion queues one `agent_finished` event for delivery on the next MCP tool response; retrieve the answer with `subagent_result`.

## Related

- [Browser ChatGPT Subagents](../Browser%20ChatGPT%20Subagents.md)
- [Subagent Completion](../Subagent%20Completion.md)
- [MCP Tool Surface](../MCP%20Tool%20Surface.md)
