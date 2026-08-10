# Browser ChatGPT Subagents

Verified 2026-08-10.

## Current State

The reusable browser module and first-class MCP wrapper now exist. `ChatGptSubagentModule` connects to an already-debuggable Chrome instance through Playwright-over-CDP. `chatgpt_subagent` submits a caller-named agent turn and returns immediately with a readable `<agent_id>_turn_N` `turn_id`; `chatgpt_subagent_poll` retrieves running, completed, or failed state without resubmitting the prompt. Running polls include a coarse activity heartbeat so a parent agent can distinguish a long task that is still making progress from one that has gone quiet (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`).

The module is deliberately attach-only. It does not launch Chrome, select a Chrome profile, copy profile data, or attempt to repair a missing browser process. `connect()` expects the configured CDP endpoint to already expose the intended authenticated Chrome instance and fails quickly with an explicit error when that dependency is unavailable (`src/tools/subagent/chatgpt-subagent.ts`).

`src/index.ts` creates one process-level module and injects it through `src/server/http-server.ts` into every request-scoped `McpServer`, so agent state survives stateless MCP requests. `MCP_CHATGPT_CDP_ENDPOINT` selects the attach-only endpoint and defaults to `http://127.0.0.1:9222`; startup does not connect to Chrome (`src/index.ts`, `src/server/http-server.ts`).

The first successfully submitted turn for a new `agent_id` can append a Caveman response-style instruction. `oververbosity` accepts `1` through `5` and defaults to `2`. It is applied only when that `agent_id` is first created; later values do not change the existing conversation. Later turns send the caller's prompt unchanged; the module records first-turn submission on the agent state and uses the exact submitted prompt for response tracking (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`).

Live validation on 2026-08-07 proved authenticated new-chat creation, same-page multi-turn continuation, normalized conversation reads, two concurrent agents with distinct Chrome targets, and stale-tab recovery by reopening the recorded `/c/<conversation-id>` URL. The test used a dedicated copied Chrome profile derived from the active signed-in profile and a normal background Chrome window with remote debugging enabled. Headless Chrome hit a Cloudflare challenge and is not currently considered a supported launch mode.

## Architecture

ChatGPT web is exposed as a local subagent primitive. The caller supplies a required descriptive agent ID and a prompt; the module owns Chrome targeting, message submission, response tracking, and continuity.

```text
parent model
  -> chatgpt_subagent(agent_id, prompt)
  <- turn_id immediately after submission
  -> do other work
  -> chatgpt_subagent_poll(turn_id)
  -> BrowserSubagentManager
  -> one Chrome page per agent
  -> ChatGPT web conversation
  -> normalized final assistant text
```

The browser is controlled through Playwright-over-CDP rather than macOS pointer and keyboard events. This keeps the user's foreground cursor and keyboard focus independent from subagent work (`src/tools/subagent/chatgpt-subagent.ts`).

## Tab Identity and Multi-Agent Routing

The first use of a caller-chosen `agent_id` creates one Chrome page and conversation. Reusing the exact ID continues that agent. Foreground tab changes and tab reordering do not affect routing because the module holds the Playwright page target directly (`src/tools/subagent/chatgpt-subagent.ts`).

```ts
type BrowserAgentState = {
  agentId: string
  pageId: string
  hasSubmittedTurn: boolean
  conversationId?: string
  conversationUrl?: string
  lastReturnedMessageId?: string
}
```

`ChatGptSubagentModule` maintains `agentId -> BrowserAgentState` plus a process-local `turnId -> BrowserTurnState` registry. Turn IDs increment per local agent as `<agent_id>_turn_1`, `<agent_id>_turn_2`, and so on. After Send succeeds, response tracking is detached from the original MCP request and owns the agent-generation lock until the browser turn completes or fails. Same-agent overlap is rejected with `AGENT_BUSY` instead of queued, and total simultaneous generations are capped at two by default. If a managed page is closed or navigated away while idle, the next turn performs at most one recovery by opening the stored conversation URL in a replacement page and rebinding the agent; a user-navigated old tab is left alone (`src/tools/subagent/chatgpt-subagent.ts`).

Idle local agent state expires after 30 minutes. The sweeper skips active operations, closes a still-owned ChatGPT tab, detaches its tracker, and removes that agent's local turn records. It does not delete the ChatGPT conversation from the user's account. Reusing the same `agent_id` after expiry creates a new local agent and new ChatGPT conversation, with its turn counter starting again at `1` (`src/tools/subagent/chatgpt-subagent.ts`).

Successful turns record completion time. A continuation arriving too quickly performs one local await so at least 1.5 seconds separates the previous completed response from the next submission. This delay does not poll or call ChatGPT (`src/tools/subagent/chatgpt-subagent.ts`).

With page-targeted CDP calls, "go back to the tab" means selecting the recorded page ID in the automation layer, not focusing that tab in macOS.

## Conversation Tracking

Do not repeatedly scrape all rendered messages. `ChatGptConversationTracker` listens to ChatGPT conversation responses, parses JSON/SSE-like payloads, and normalizes mapping nodes into a graph keyed by message ID. The module snapshots known IDs before every send and returns only a new completed assistant response. DOM completion is retained as a fallback for payload drift or unreadable streaming bodies (`src/tools/subagent/chatgpt-subagent.ts`).

Useful fields observed in current ChatGPT traffic include message ID, author role, status, `end_turn`, `metadata.is_complete`, `turn_exchange_id`, `working_turn_id`, `recipient`, `parent`, and `children`. Intermediate tool messages can therefore be distinguished from a completed user-facing assistant message.

For each send:

1. Capture the new user message or turn ID from the outgoing/incoming network payload.
2. Merge subsequent message updates by message ID instead of appending duplicates.
3. Follow that turn or its descendants and ignore internal tool/reasoning recipients.
4. Resolve only when a new completed user-facing assistant leaf is observed.
5. Save its message ID as `lastReturnedMessageId` so later reads cannot return it again.

The DOM remains a fallback for composer interaction and response recovery; the network graph should be authoritative for continuity and duplicate suppression.

While a turn is running, changed network nodes refresh a coarse activity heartbeat. Web/search recipients map to `Searching the web`, other non-user-facing recipients map to `Using tools`, assistant output maps to `Generating response`, and other observed progress maps to `Working`. DOM response text growth also refreshes `Generating response`. Re-reading an unchanged node or merely polling the MCP does not refresh the heartbeat (`src/tools/subagent/chatgpt-subagent.ts`, `test/chatgpt-subagent.test.ts`).

## MCP Surface

The public surface is intentionally small:

```ts
chatgpt_subagent({
  prompt: string,
  agent_id: string,
  oververbosity?: 1 | 2 | 3 | 4 | 5,
}) -> {
  agent_id: string,
  turn_id: string,
  status: "running",
  submitted: true,
}

chatgpt_subagent_poll({
  turn_id: string,
  wait_ms?: number,
}) -> {
  agent_id: string,
  turn_id: string,
  status: "running" | "completed" | "failed",
  activity?: "Working" | "Searching the web" | "Using tools" | "Generating response",
  activity_age_ms?: number,
  response?: string,
  error_code?: string,
  error_message?: string,
}
```

`agent_id` is required, caller-defined, and limited to 64 characters. First use creates a conversation; later use continues it. The initial call returns after prompt submission. The parent must retain the returned `turn_id` and explicitly poll it to collect the result; there is no server-side callback or notification when a detached turn completes. `wait_ms: 0` polls immediately, and positive waits are bounded to 60 seconds. While status is `running`, `activity_age_ms` reports milliseconds since the last observable progress; a low or resetting value is a liveness signal, not an ETA. The background browser turn has no fixed response-duration timeout (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`).

The module also keeps internal `read`, `listAgents`, and `closeAgent` operations for maintenance/debugging. The published MCP surface exposes `chatgpt_subagent` and `chatgpt_subagent_poll` (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`).

## Implementation Status

- The Playwright-over-CDP module implements page creation, `agentId -> Page` routing, target-ID capture, stale-page recovery, per-agent locking, composer submission, network tracking, duplicate suppression, DOM fallback, visible-history reads, and internal agent close/list operations (`src/tools/subagent/chatgpt-subagent.ts`).
- Chrome lifecycle and profile selection stay outside the module. The intended authenticated debuggable Chrome instance is a runtime prerequisite; absence of the configured CDP endpoint is an explicit failure (`src/tools/subagent/chatgpt-subagent.ts`).
- One process-level `ChatGptSubagentModule` is injected through `src/index.ts` and `src/server/http-server.ts`; the MCP exposes asynchronous `chatgpt_subagent` and `chatgpt_subagent_poll` tools (`src/tools/subagent/subagent-tools.ts`).
- Automated coverage validates conversation mapping, final-message duplicate suppression, polling behavior, activity heartbeat semantics, page-loss handling, and continuity across stateless MCP requests using a fake shared service (`test/chatgpt-subagent.test.ts`, `test/mcp-integration.test.ts`).

## Risks / Open Questions

- ChatGPT web DOM selectors and network payload shapes are private implementation details and may change without notice; isolate both behind small adapters and fail explicitly when parsing assumptions break.
- Authentication/session expiry needs a detectable error state rather than silently opening a logged-out conversation.
- Chrome startup, profile selection, and authentication are external runtime concerns. The module intentionally refuses to infer or choose among user profiles.
- A normal user Chrome profile is convenient for authentication but increases interference risk. A dedicated persistent agent profile gives the same retained login after one manual sign-in with a cleaner isolation boundary.
- Headless Chrome triggered a Cloudflare challenge during live validation; the current proven path is a normal background Chrome process controlled entirely through CDP.
- Conversation branching requires selecting the active descendant path rather than assuming the newest timestamp is authoritative.
- Tool calls and reasoning nodes can appear as assistant-authored messages; completion detection must not treat every assistant node as the final answer.
- Parent agents can lose detached work if they submit a turn, continue unrelated work, and fail to poll the returned `turn_id`. The server retains the turn while the process lives but does not push completion back to the parent; tool guidance should bias toward retaining and polling the turn explicitly (`src/tools/subagent/subagent-tools.ts`).
- If a page is lost before its first conversation URL is captured, that unrecoverable state is discarded after the failed call so the same caller-chosen `agent_id` can be used again explicitly. The failed turn is never retried automatically (`src/tools/subagent/chatgpt-subagent.ts`).
- The process-local `agent_id` and `turn_id` registries are lost when the MCP process restarts. A browser generation already underway can therefore outlive the server process but cannot currently be polled after that restart. Persisting/reconciling agent and turn bindings remains future work if restart continuity is required.
