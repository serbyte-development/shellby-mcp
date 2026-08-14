# Browser ChatGPT Subagents

Verified 2026-08-14.

## Current Architecture

ChatGPT web is exposed as a detached browser-backed delegation primitive. `subagent_start` submits 1-3 caller-named agents and returns `turn_id` values after each prompt is sent; `subagent_result` retrieves 1-3 existing turns concurrently and returns running, completed, or failed state. The actual browser work lives in one process-level `ChatGptSubagentModule`, so agent state survives the server's stateless per-request MCP transports (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`, `src/index.ts`, `src/server/http-server.ts`, `src/server/mcp-server.ts`).

The module attaches to an already-running authenticated Chrome instance through Playwright-over-CDP. It does not choose a normal user profile or launch Chrome itself. Production browser setup/start/hide behavior belongs to `scripts/chatgpt-browser.mjs` and `scripts/start.mjs`; the CDP endpoint comes from `MCP_CONFIG.chatGpt.cdpEndpoint` and defaults to `http://127.0.0.1:9222` (`src/config.ts`, `src/tools/subagent/chatgpt-subagent.ts`, `scripts/chatgpt-browser.mjs`, `scripts/start.mjs`).

```text
parent model
  -> subagent_start({ agents: [...] })
       -> agent 1 submitted immediately
       -> agent 2 submitted 5s later
       -> agent 3 submitted 7s after agent 2
  <- turn IDs for successful submissions
  -> parent continues other work
  <- any later tool response may include agent_finished:<agent_id>:<turn_id>
  -> subagent_result({ turn_ids: [...] })
       -> retrieve all requested turns concurrently
       -> reconcile any still-running turn against its real ChatGPT page
  <- running / completed / failed results
```

Chrome targeting is page-based rather than foreground-input-based. Each live agent owns a Playwright `Page`, so tab order, foreground focus, mouse position, and keyboard focus do not determine routing (`src/tools/subagent/chatgpt-subagent.ts`).

## Identity and State

`agent_id` is the stable caller-chosen conversation identity within the running MCP process. First use creates a ChatGPT conversation; later use continues it. `agent_id` is trimmed by the MCP schema, limited to 64 characters, and must be unique within one `subagent_start` batch (`src/tools/subagent/subagent-tools.ts`).

The runtime keeps four related process-local structures (`src/tools/subagent/chatgpt-subagent.ts`):

```text
agents: agent_id -> live BrowserAgentState
conversationRefs: agent_id -> saved conversation ID/URL + turn counter
turns: turn_id -> BrowserTurnState
activeTurnsByAgent: agent_id -> currently running turn_id
```

`BrowserAgentState` owns the live page, `ChatGptConversationTracker`, conversation identity, last returned message, last completion/use timestamps, and per-agent turn counter. `BrowserTurnState` owns detached turn lifecycle, activity heartbeat, completion/failure result, tracking baselines, and one-shot recovery state (`src/tools/subagent/chatgpt-subagent.ts`).

Turn IDs are readable and sequential per agent: `<agent_id>_turn_1`, `<agent_id>_turn_2`, etc. The saved conversation reference also retains `turnCount`, so a 30-minute runtime eviction followed by recovery in the same process does not reuse earlier turn IDs (`src/tools/subagent/chatgpt-subagent.ts`).

## Parallel Start and Capacity

`registerSubagentTools()` implements batching. `subagent_start` accepts 1-3 agents. It submits array entries in order with `SUBAGENT_START_DELAYS_MS = [0, 5000, 7000]`: first immediately, second five seconds later, third seven seconds after the second. The delay staggers browser activity only; already-submitted agents continue generating concurrently while later agents are being submitted (`src/tools/subagent/subagent-tools.ts`).

`ChatGptSubagentModule.beginAgentOperation()` is the authoritative concurrency guard. One agent may have only one operation at a time, so same-agent overlap returns `AGENT_BUSY`. Process-wide active generations are hard-capped at three; constructor overrides are clamped to `MAX_CONCURRENT_AGENTS = 3`, and excess work returns `SUBAGENT_CAPACITY_REACHED` rather than entering a queue (`src/tools/subagent/chatgpt-subagent.ts`).

Batch submission handles each agent independently. A submission failure is returned on that agent's structured result and does not roll back already-started siblings. If the MCP request is aborted during a stagger delay, that unsent entry fails and later entries are not submitted; already-submitted turns continue according to their own lifecycle (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

## Detached Turn State and Passive Tracking

`ask()` performs only enough synchronous work to safely submit the prompt: resolve/create the agent, ensure the managed page is valid, snapshot response baselines, locate the composer, send the prompt, create `BrowserTurnState`, and attach the passive network activity listener. Before interacting with the composer it dismisses ChatGPT's known `#modal-beacon` overlay with `Escape`; if that overlay races back and blocks a click, the blocked interaction is retried once after dismissal. The retry is limited to atomic pre-submit UI actions, so it cannot resubmit an already-sent prompt. The MCP call returns once submission succeeds; it does not wait for ChatGPT's final answer (`src/tools/subagent/chatgpt-subagent.ts`, `test/chatgpt-subagent.test.ts`).

There is no background DOM polling loop. `ChatGptConversationTracker` listens to ChatGPT conversation responses, merges mapping nodes by message ID, and refreshes coarse activity when meaningful network state changes. When that network graph contains a definitive final assistant response for the active turn, the module immediately stores the result, releases the per-agent/global generation lock, and queues `agent_finished:<agent_id>:<turn_id>`. The global MCP response boundary appends pending events to the next tool response. The event carries no answer text; the parent still retrieves the answer explicitly with `subagent_result` (`src/tools/subagent/chatgpt-subagent.ts`, `src/server/tool-schema-order.ts`, `test/chatgpt-subagent.test.ts`, `test/mcp-integration.test.ts`).

The tracker excludes intermediate tool/reasoning messages and suppresses previously returned assistant messages. A network final is eligible for the active turn only when that payload also contains the exact submitted user prompt; unrelated conversation payloads are ignored rather than risking a wrong answer. Useful normalized fields include message ID, role, status, `end_turn`, `metadata.is_complete`, parent/children relationships, `turn_exchange_id`, `working_turn_id`, recipient, and text (`src/tools/subagent/chatgpt-subagent.ts`).

When either passive network observation or `subagent_result` reconciliation finds a final response, `completeTurn()` stores the final text/message identity, updates conversation metadata and completion timestamps, releases the per-agent/global generation lock, and leaves the result in the process-local turn registry until normal idle cleanup removes that agent's runtime state (`src/tools/subagent/chatgpt-subagent.ts`).

## Result Retrieval and Reconciliation

`subagent_result` accepts 1-3 `turn_id` values and retrieves them concurrently with `Promise.all()`. Errors are caught per turn, so one invalid/stale turn does not discard valid sibling results. `wait_ms` is bounded to 0-60 seconds and applies to every requested turn in the same concurrent wait window (`src/tools/subagent/subagent-tools.ts`).

The service-level `poll()` is the authoritative active observer. While a turn is still marked running it calls `reconcileRunningTurn()` before waiting. Reconciliation first checks any final response already captured by the passive network tracker, then falls back to the current DOM and generation state. A completed or terminally failed reconciliation releases the per-agent/global generation lock (`src/tools/subagent/chatgpt-subagent.ts`).

After a turn has been successfully submitted, a browser-observation failure is not immediately terminal when a saved conversation is available. The turn gets one conversation-based recovery attempt: Shelly revalidates the saved conversation, reloads its server-side conversation payload when possible, and checks the recovered DOM. Concurrent poll failures share that same recovery attempt. A successful recovery may complete the turn immediately or leave it running for the current/next poll to reconcile again; a later observation failure becomes terminal, preventing recovery loops (`src/tools/subagent/chatgpt-subagent.ts`, `test/chatgpt-subagent.test.ts`).

This makes explicit result retrieval the active self-healing fallback:

```text
cached turn says running
  -> inspect actual ChatGPT page
     -> final response exists: mark completed now
     -> still generating: remain running
     -> page/conversation failure: mark failed
```

A positive `wait_ms` repeats this cycle roughly once per second until the turn finishes or that result window expires. Result retrieval never resubmits prompts (`src/tools/subagent/chatgpt-subagent.ts`).

## Activity and Liveness

Running results may return one coarse activity value: `Working`, `Searching the web`, `Using tools`, or `Generating response`. `activity_age_ms` is milliseconds since the last observable progress, not time since the last result check and not an ETA (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`).

Meaningful network-node changes refresh the heartbeat. Web/search recipients map to `Searching the web`; other internal recipients map to `Using tools`; assistant output maps to `Generating response`; other observed state changes map to `Working`. Re-reading unchanged state or merely calling `subagent_result` does not refresh `lastActivityAt` (`src/tools/subagent/chatgpt-subagent.ts`, `test/chatgpt-subagent.test.ts`).

There is no fixed generation-duration timeout. A legitimately long turn may run beyond 30 minutes as long as the harness continues observing meaningful progress.

## 30-Minute Idle Cleanup

The single lifecycle safety policy is 30 minutes without meaningful activity. `cleanupIdleAgents()` runs once per minute (`src/tools/subagent/chatgpt-subagent.ts`).

For a running turn, idle age is measured from `BrowserTurnState.lastActivityAt`. Therefore an active generation is not exempt merely because `status === "running"`; observable progress keeps it alive, while a wedged turn with no progress for 30 minutes is reclaimed. For an agent without a running turn, idle age is measured from `BrowserAgentState.lastUsedAt` (`src/tools/subagent/chatgpt-subagent.ts`).

On idle eviction the module:

1. saves the conversation ID/URL and turn counter in `conversationRefs` when available;
2. marks a stale running turn failed and releases the generation slot;
3. disposes the response tracker;
4. removes the live agent and all of that agent's local turn records;
5. closes the page only if it is still the module-owned ChatGPT page.

The ChatGPT conversation itself is not deleted. Because the local turn records are removed, retrieving an evicted old `turn_id` returns `UNKNOWN_TURN`. Any still-pending `agent_finished` event for an evicted turn is removed at the same time so the parent is not sent an unusable completion notification (`src/tools/subagent/chatgpt-subagent.ts`).

## Conversation Recovery

`conversationRefs` makes live browser state disposable. After idle eviction, reusing the same `agent_id` causes `createAgent()` to open a replacement page at the saved `/c/<conversation-id>` URL, verify authentication, verify that the saved conversation still exists, restore the turn counter, and continue that conversation (`src/tools/subagent/chatgpt-subagent.ts`).

`ensureActivePage()` provides the same recovery path when a live agent's managed page was closed or otherwise lost after its conversation URL was captured. The module never hijacks an unrelated user-navigated tab; it creates a replacement page and binds that page to the saved conversation (`src/tools/subagent/chatgpt-subagent.ts`).

If the saved ChatGPT conversation was deleted or is otherwise unavailable, recovery fails explicitly with `SUBAGENT_CONVERSATION_NOT_FOUND`. The module does not silently create a fresh conversation under that same `agent_id`; callers should choose a new `agent_id` when they intentionally want new context (`src/tools/subagent/chatgpt-subagent.ts`, `test/chatgpt-subagent.test.ts`).

The saved `conversationRefs` map is process-local, not durable storage. A full MCP process restart loses agent/turn/conversation bindings even though the underlying ChatGPT history may still exist. Restart-surviving recovery would require persisting those bindings separately (`src/tools/subagent/chatgpt-subagent.ts`).

## Public MCP Contract

```ts
subagent_start({
  agents: Array<{
    agent_id: string
    prompt: string
    oververbosity?: 1 | 2 | 3 | 4 | 5
  }>
}) -> {
  turns: Array<{
    agent_id: string
    turn_id?: string
    status: "running" | "failed"
    error?: string
  }>
}

subagent_result({
  turn_ids: string[]
  wait_ms?: number
}) -> {
  turns: Array<{
    turn_id: string
    status: "running" | "completed" | "failed"
    activity?: "Working" | "Searching the web" | "Using tools" | "Generating response"
    activity_age_ms?: number
    response?: string
    error?: string
  }>
}
```

`oververbosity` defaults to `2` and affects only the first turn of a new conversation. Levels below `5` append the configured Caveman response-style instruction to that first submitted prompt; continuations send the caller prompt unchanged. The public tools intentionally keep conversation/message IDs internal and return completed text only once in `turns[].response` (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`).

## Relevant Files and Functions

| Location | Important symbols | Responsibility |
| --- | --- | --- |
| `src/tools/subagent/chatgpt-subagent.ts` | `ChatGptSubagentModule`, `connect()`, `ask()`, `poll()` | Detached turn lifecycle, agent state, recovery, capacity, events, and cleanup. |
| `src/tools/subagent/chatgpt-subagent.ts` | `createAgent()`, `ensureActivePage()`, `rememberConversation()` | Agent page ownership, replacement, and saved conversation references. |
| `src/tools/subagent/chatgpt-subagent.ts` | `reconcileRunningTurn()`, `recoverSubmittedTurn()`, `completeTurn()`, `finishTurnOperation()` | Poll-time response detection, one-shot recovery, and terminal lifecycle release. |
| `src/tools/subagent/chatgpt-subagent.ts` | `beginAgentOperation()`, `endAgentOperation()` | Per-agent locking and hard global three-generation capacity accounting. |
| `src/tools/subagent/chatgpt-subagent.ts` | `attachTurnListeners()`, `cleanupIdleAgents()`, `drainEvents()` | Passive activity/final-response observation, completion-event queue, and 30-minute inactivity reclamation. |
| `src/tools/subagent/chatgpt-subagent-browser.ts` | `ChatGptConversationTracker`, conversation extraction/matching helpers | Reverse-engineered ChatGPT conversation graph, final-response filtering, and passive progress observation. |
| `src/tools/subagent/chatgpt-subagent-browser.ts` | composer/auth/page helpers | ChatGPT DOM selectors, overlay recovery, prompt submission, generation detection, and CDP/browser mechanics. |
| `src/tools/subagent/chatgpt-subagent-contracts.ts` | service/request/result/error contracts | Dependency-light shared contracts used by the lifecycle module, MCP registration, and HTTP composition. |
| `src/tools/subagent/subagent-tools.ts` | `registerSubagentTools()`, `SUBAGENT_START_DELAYS_MS` | Public Zod schemas, 1-3 batch orchestration, 0/5/7-second staggering, concurrent result fan-out, and per-item errors. |
| `src/index.ts` | process-level `ChatGptSubagentModule` construction | Production singleton plus best-effort browser re-hide hook. |
| `src/server/http-server.ts` | `StartMcpServerOptions.chatGptSubagents` | Shares one subagent service across stateless MCP requests. |
| `src/server/mcp-server.ts` | `registerSubagentTools(...)` | Registers request-scoped MCP tool handlers against the shared service. |
| `src/config.ts` | `MCP_CONFIG.chatGpt` | CDP endpoint and static ChatGPT runtime configuration. |
| `scripts/chatgpt-browser.mjs` | managed Chrome helper | Dedicated browser/profile setup, launch, foreground, and hide behavior. |
| `scripts/start.mjs` | production startup | Starts the managed ChatGPT browser when configured before normal MCP use. |
| `test/chatgpt-subagent.test.ts` | lifecycle-focused subagent tests | Capacity, recovery, deleted conversations, result reconciliation, passive completion, event queueing, and idle cleanup. |
| `test/chatgpt-subagent-browser.test.ts` | browser-adapter tests | Overlay recovery, transient routes, network activity, conversation parsing/matching, branch extraction, and duplicate/intermediate suppression. |
| `test/mcp-integration.test.ts` | subagent tool integration coverage | Published schemas, batch staggering, concurrent polling, partial failure handling, and shared service behavior across stateless requests. |

## Failure Semantics

Important service errors are defined by `ChatGptSubagentErrorCode` in `src/tools/subagent/chatgpt-subagent-contracts.ts`:

- `BROWSER_UNAVAILABLE` — configured CDP browser cannot be reached.
- `CHATGPT_NOT_AUTHENTICATED` — attached browser is not signed into ChatGPT.
- `AGENT_BUSY` — the same agent already owns an active operation/turn.
- `SUBAGENT_CAPACITY_REACHED` — three generations are already active.
- `AGENT_TARGET_LOST` — the managed page/conversation target was lost and cannot be safely reused.
- `SUBAGENT_CONVERSATION_NOT_FOUND` — a saved conversation reference no longer resolves.
- `UNKNOWN_TURN` / `UNKNOWN_AGENT` — requested process-local state is absent.
- `REQUEST_ABORTED` — caller cancelled the operation.
- `CHATGPT_UI_CHANGED` — required ChatGPT UI assumptions no longer hold.

The MCP wrapper converts start failures into that agent's `turns[]` entry and result failures into that turn's `turns[]` entry. A bad item therefore does not discard successful sibling results (`src/tools/subagent/subagent-tools.ts`).

## Operational Constraints and Risks

- ChatGPT DOM selectors and private network payload shapes can change; network tracking and DOM fallback should remain isolated and explicit when assumptions fail (`src/tools/subagent/chatgpt-subagent.ts`).
- The browser must already be authenticated. Headless Chrome previously triggered a Cloudflare challenge; the proven path is a normal headed dedicated Chrome profile controlled through CDP.
- Detached work has no server-side callback to the parent. Callers must retain successful `turn_id` values and poll them before finishing work they delegated (`src/tools/subagent/subagent-tools.ts`).
- A request aborted after one batch member was already submitted cannot unsend that ChatGPT turn. Already-submitted siblings may continue even if later staggered submissions never occur (`src/tools/subagent/subagent-tools.ts`).
- Process restart loses local turn state and saved conversation bindings. The underlying ChatGPT conversations remain account-side, but this module currently has no durable restart index that maps old `agent_id` values back to them (`src/tools/subagent/chatgpt-subagent.ts`).
