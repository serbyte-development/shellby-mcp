# Browser ChatGPT Subagents

Verified 2026-08-20 against current source, deterministic tests, and live ChatGPT runs.

## What This Is

Implementation overview for the process-level browser runtime behind `subagent_run` and `subagent_result`. Caller behavior is canonical in [`subagent_run` / `subagent_result`](./tools/subagent.md); completion and recovery rules are canonical in [Subagent Completion and Recovery](./Subagent%20Completion%20and%20Recovery.md).

Point-in-time upstream ChatGPT HTTP/WebSocket behavior observed through raw CDP is documented separately in [ChatGPT CDP Transport](./ChatGPT%20CDP%20Transport.md). Production now consumes the observed turn-topic WebSocket frames while retaining a DOM observer as its secondary completion path.

The runtime attaches through Playwright-over-CDP to an already-running authenticated Chrome instance. Production browser setup/start/hide behavior belongs to `scripts/chatgpt-browser.mjs` and `scripts/start.mjs`; the CDP endpoint comes from `MCP_CONFIG.chatGpt.cdpEndpoint` (`src/config.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

## Runtime State

One process-level `ChatGptSubagentModule` is shared across otherwise stateless MCP requests. Its main state is (`src/tools/subagent/chatgpt-subagent.ts`):

```text
agents: agent_id -> live browser/page state
conversationRefs: agent_id -> saved conversation ID/URL + turn counter
turns: turn_id -> detached turn state
activeTurnsByAgent: agent_id -> active turn_id
pendingEvents: completion notifications
```

`agent_id` is the persistent conversation identity. `turn_id` identifies one submitted operation and remains sequential per agent while the in-process conversation reference survives. Conversation refs are process-local, not durable storage.

## Browser and Page Ownership

Each live agent owns one module-created Playwright `Page`. Routing is page-based, so foreground window focus, tab order, mouse position, and keyboard focus do not determine which subagent receives work (`src/tools/subagent/chatgpt-subagent.ts`).

`createAgent()` opens either the base ChatGPT URL for a new agent or the exact saved conversation for a recoverable agent. `ensureActivePage()` keeps using the current page only while it still matches the expected ChatGPT target; if the page is closed or lost, it can reopen the saved conversation. It never hijacks an unrelated tab that a user navigated elsewhere (`src/tools/subagent/chatgpt-subagent.ts`).

Before prompt submission, `assertPreSubmitLocation()` verifies ownership again. A missing saved conversation fails rather than silently creating a replacement conversation under the old `agent_id` (`src/tools/subagent/chatgpt-subagent.ts`).

## Conversation Binding

New ChatGPT conversations may move through a temporary `WEB:` URL before receiving a stable `/c/<id>` URL. Temporary IDs are deliberately ignored. After first-turn submission, `waitForStableConversationLocation()` records the stable conversation ID/URL when it becomes available (`src/tools/subagent/chatgpt-subagent-browser.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

Before a stable URL exists, the submitted page is the only recoverable identity for that first turn. Preserving page ownership during initial binding is therefore an implementation invariant.

## Prompt Submission

`ask()` performs only the synchronous work needed to submit safely and create detached turn state. It connects to CDP, resolves the agent page, verifies ownership, snapshots turn-relative DOM state, installs the WebSocket + DOM response observation, handles the known composer overlay when necessary, enters the prompt, verifies ownership again, waits the shared submission grace, performs the final rate-limit check, and submits exactly once (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/chatgpt-subagent-browser.ts`). The same path and grace apply to a new agent's first message and later turns.

After submission it records the turn, starts stable-conversation binding when needed, and lets the already-installed observers settle the detached turn. `subagent_result` only waits on that shared local turn state. No post-submission recovery path is allowed to resubmit the prompt. Completion details live in [Subagent Completion and Recovery](./Subagent%20Completion%20and%20Recovery.md).

## Runtime Reclamation

Idle live browser state can be reclaimed without deleting the underlying ChatGPT conversation. When possible, the module preserves the conversation reference and turn counter, disposes browser tracking, removes local turn state/events, and closes only the page it still owns. Reusing that `agent_id` can reopen the saved conversation within the same MCP process (`src/tools/subagent/chatgpt-subagent.ts`).

A full MCP restart loses process-local agent, turn, pending-event, and conversation-reference state even though ChatGPT account history may still contain the conversations. Caller-visible lifetime and failure consequences are documented in [`subagent_run` / `subagent_result`](./tools/subagent.md).

## Code Map

| Location                                           | Responsibility                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/tools/subagent/chatgpt-subagent.ts`           | Agent/turn state, page ownership, submission, lifecycle, completion integration, reclamation. |
| `src/tools/subagent/chatgpt-subagent-browser.ts`   | ChatGPT page interaction, conversation parsing, server/UI observation, stable URL capture.    |
| `src/tools/subagent/chatgpt-subagent-contracts.ts` | Dependency-light service/result/error contracts.                                              |
| `src/tools/subagent/subagent-tools.ts`             | Public MCP schemas, batching, staggering, result fan-out.                                     |
| `src/server/tool-registration-boundary.ts`         | Global completion-event delivery boundary.                                                    |
| `scripts/chatgpt-browser.mjs`                      | Dedicated authenticated Chrome profile setup and lifecycle.                                   |

Test ownership and live compatibility coverage are maintained in [Build and Test](./Build%20and%20Test.md).

## Operational Risks

- ChatGPT DOM selectors and private endpoints are not stable public APIs; browser-specific assumptions should stay isolated in `chatgpt-subagent-browser.ts`.
- The attached browser session is authenticated authority. Request cancellation after submission cannot unsend the ChatGPT turn.
- Browser state and conversation bindings are process-local even when the underlying ChatGPT conversation persists remotely.

## Related

- [`subagent_run` / `subagent_result`](./tools/subagent.md)
- [Subagent Completion and Recovery](./Subagent%20Completion%20and%20Recovery.md)
- [ChatGPT CDP Transport](./ChatGPT%20CDP%20Transport.md)
- [MCP Tool Surface](./MCP%20Tool%20Surface.md)
- [Configuration and Startup](./Configuration%20and%20Startup.md)
- [Build and Test](./Build%20and%20Test.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
