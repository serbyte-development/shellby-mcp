# Subagent Completion and Recovery

Verified 2026-08-20 against current source, deterministic tests, and live ChatGPT runs.

## What This Is

Canonical completion, event-delivery, result waiting, and catastrophic recovery rules for browser-backed subagent turns. The private ChatGPT transport evidence behind this design is documented in [ChatGPT CDP Transport](./ChatGPT%20CDP%20Transport.md).

## Completion Authority

Detached turns must complete autonomously without requiring `subagent_result` polling. All successful paths converge on `completeTurn()`, whose running-state guard makes the transition race-safe. The winning completion stores the answer, releases per-agent/global generation capacity, preserves the conversation reference when available, and queues exactly one `agent_finished:<agent_id>:<turn_id>` event (`src/tools/subagent/chatgpt-subagent.ts`).

Normal completion is event-driven through `observeAssistantResponse()` (`src/tools/subagent/chatgpt-subagent-browser.ts`). The primary path is raw CDP `Network.webSocketFrameReceived`: the turn topic is bound by the exact submitted user prompt, assistant v1 deltas reconstruct the source response, and completion requires both a final assistant node (`finished_successfully`, `end_turn: true`) and an explicit stream-completion signal. This preserves source Markdown and code fences.

## Secondary DOM Observation

A page-context `MutationObserver` runs alongside the WebSocket observer. It watches only the turn-relative assistant DOM and generation control. Once generation is no longer visible and the new assistant text remains stable through the settle grace, it can return rendered text as the secondary response source (`src/tools/subagent/chatgpt-subagent-browser.ts`).

Normal completion makes no `stream_status` request, runs no one-second reconciliation loop, and does not refresh or navigate the managed page. Both observers are installed before prompt submission so first turns and follow-up turns use the same observation path.

The structured response and DOM fallback each use a short settle grace. Prompt submission also uses one shared pre-submit grace for both a newly opened agent and every later turn before the final rate-limit check and send (`src/tools/subagent/chatgpt-subagent.ts`).

## Event Delivery and Result Waiting

`pendingEvents` is process-local. The global tool-registration boundary drains it after tool callbacks, so the next MCP tool response can include `**agent_finished:** agent_id=<agent_id> turn_id=<turn_id>`. The event contains no answer text and is emitted once (`src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`, `test/mcp-integration.test.ts`).

Each running turn owns one settlement promise. `subagent_result(wait_ms)` waits on that same in-process settlement state up to the requested duration and then returns the current result. It does not independently inspect ChatGPT, issue server requests, refresh the page, or duplicate completion work (`src/tools/subagent/chatgpt-subagent.ts`).

## One-Shot Recovery

A successfully submitted prompt is never automatically submitted twice. If normal WebSocket and DOM observation fail and a stable conversation identity is available, exactly one catastrophic recovery attempt may:

1. open the saved conversation URL in one fresh tab;
2. capture ChatGPT's normal `/backend-api/conversation/<id>` response during that navigation when available;
3. complete from the exact canonical response if it contains the submitted prompt and final assistant answer;
4. otherwise attach the same WebSocket + DOM observer to that fresh tab and wait for current-turn progress;
5. close the old owned page after the replacement is established.

There is no recovery reload of the existing managed page. `recoveryAttempted` prevents a second catastrophic attempt (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/chatgpt-subagent-browser.ts`).

## Lifetime

The existing 30-minute active-turn cutoff remains the lifecycle backstop. WebSocket/DOM activity updates `lastActivityAt`; a running turn that has no observable progress for 30 minutes is failed and reclaimed. No separate completion timeout or polling deadline was added (`src/tools/subagent/chatgpt-subagent.ts`).

## Maintainer Invariants

1. Never automatically submit a prompt twice.
2. Detached completion must work without result polling.
3. `completeTurn()` is the only successful lifecycle gate and completion-event source.
4. Normal completion is WebSocket-first with DOM as the only secondary observer.
5. `subagent_result` waits on local turn state and does not poll ChatGPT.
6. Normal completion does not reload or navigate the managed page.
7. Catastrophic recovery opens the saved conversation once in a fresh tab and never resubmits the prompt.
8. The existing 30-minute no-progress cutoff remains the lifecycle backstop.

## Related

- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [ChatGPT CDP Transport](./ChatGPT%20CDP%20Transport.md)
- [`subagent_run` / `subagent_result`](./tools/subagent.md)
- [Build and Test](./Build%20and%20Test.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
