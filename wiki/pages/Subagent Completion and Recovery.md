# Subagent Completion and Recovery

Verified 2026-08-18 against current source and tests.

## What This Is

Canonical completion, event-delivery, reconciliation, and recovery rules for browser-backed subagent turns.

## Completion Authority

Detached turns must complete autonomously without requiring `subagent_result` polling. All successful paths converge on `completeTurn()`, whose running-state guard makes the transition race-safe. The winning completion stores the answer, releases per-agent/global generation capacity, preserves the conversation reference when available, and queues exactly one `agent_finished:<agent_id>:<turn_id>` event (`src/tools/subagent/chatgpt-subagent.ts`).

Completion detection and answer extraction are separate. The preferred answer source is the structured ChatGPT conversation payload because it preserves exact server-returned text. A tracked assistant node must be successfully finished and marked `end_turn: true`; intermediate completed nodes are not final (`src/tools/subagent/chatgpt-subagent-browser.ts`).

## Signal Order

`attachTurnListeners()` provides the low-latency passive network path. Because ChatGPT can hand generation to a secondary stream that does not produce the final conversation graph as a normal Playwright `Response`, every running turn also has an approximately one-second completion watcher (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/chatgpt-subagent-browser.ts`).

The watcher checks the network tracker first, then server `stream_status`, generating UI state, and the turn-relative assistant DOM. Conversation-wide `COMPLETE` is trusted only after evidence that the current turn actually generated, such as prior `IS_STREAMING` or a generating UI that was observed and then stopped. `IS_STREAMING`, unknown server state, or active generating UI never prove completion. DOM text alone never ends a turn whose authoritative lifecycle state is still active.

Once current-turn completion is proven, server completion outranks stale generating UI. The watcher allows a short DOM grace period, but result reconciliation remains the reliable boundary if the final answer is still missing (`src/tools/subagent/chatgpt-subagent.ts`).

## Event Delivery and Reconciliation

`pendingEvents` is process-local. The global tool-registration boundary drains it after tool callbacks, so the next MCP tool response can include `**agent_finished:** agent_id=<agent_id> turn_id=<turn_id>`. The event contains no answer text and is emitted once (`src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`, `test/mcp-integration.test.ts`).

For a still-running turn, `subagent_result` calls reconciliation before returning. Reconciliation can repair a missed stable conversation binding, recover or validate the managed page, reattach network listeners, inspect lifecycle/UI/DOM state, and complete a turn autonomous observation missed. Polling never resubmits the prompt (`src/tools/subagent/chatgpt-subagent.ts`).

## One-Shot Recovery

A successfully submitted prompt is never automatically submitted twice. When browser observation fails or a positively completed turn lacks the expected network answer, one shared recovery attempt may:

1. reuse or replace the managed page with the saved conversation;
2. reattach the passive network tracker;
3. reload the known saved conversation once while capturing canonical `/backend-api/conversation/<id>` JSON;
4. prefer exact server `content.parts` text;
5. fall back to rendered DOM only after lifecycle completion is already established.

`recoveryAttempted` and `recoveryPromise` ensure concurrent observers share the same attempt. Normal polling and normal follow-up submission do not reload the page (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/chatgpt-subagent-browser.ts`).

## Maintainer Invariants

1. Never automatically submit a prompt twice.
2. Detached completion must work without result polling.
3. `completeTurn()` is the only successful lifecycle gate and completion-event source.
4. Current-turn server `COMPLETE` outranks stale generating UI; `IS_STREAMING` outranks prematurely idle UI.
5. Polling is observation, not activity progress.
6. Recovery reuses the submitted conversation and is one-shot.
7. Normal completion polling checks the passive network tracker first.

## Related

- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [`subagent_run` / `subagent_result`](./tools/subagent.md)
- [Build and Test](./Build%20and%20Test.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
