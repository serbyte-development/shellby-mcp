# Browser ChatGPT Subagents

Verified 2026-08-14 against current source and tests.

## What This System Is

Unhinged Agent exposes ChatGPT Web as a detached browser-backed delegation system. The parent model submits work with `subagent_start`, continues doing other work, learns asynchronously when a delegated turn finishes, and later retrieves the answer with `subagent_result`.

The browser implementation lives in one process-level `ChatGptSubagentModule`. MCP requests themselves are stateless, but the module keeps browser pages, agent/conversation bindings, turn state, completion events, and recovery metadata alive across requests (`src/tools/subagent/chatgpt-subagent.ts`, `src/index.ts`, `src/server/http-server.ts`, `src/server/mcp-server.ts`).

The module attaches to an already-running authenticated Chrome instance through Playwright-over-CDP. It does not launch an arbitrary user profile itself. Production browser setup/start/hide behavior belongs to `scripts/chatgpt-browser.mjs` and `scripts/start.mjs`; the CDP endpoint comes from `MCP_CONFIG.chatGpt.cdpEndpoint` and defaults to `http://127.0.0.1:9222` (`src/config.ts`).

## Core Contract: Completion Must Be Detected Autonomously

The most important invariant is not merely that `subagent_result` can eventually discover an answer. **The runtime must know when a detached turn has finished without waiting for the parent model to poll.**

When a turn completes, `completeTurn()` must perform the single running-to-completed transition, store the answer, release the per-agent and global generation slot, and queue exactly one:

```text
agent_finished:<agent_id>:<turn_id>
```

The global MCP tool-registration boundary drains queued events after a tool handler finishes and appends them to the next MCP tool response. That is how a parent model that is still running unrelated tools learns that a background subagent is ready (`src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`, `src/server/mcp-server.ts`).

`subagent_result` is therefore the explicit answer-retrieval and self-healing API, **not the only completion detector**.

```text
parent model
  -> subagent_start(...)
  <- turn_id

  -> parent continues other work

  [background turn finishes]
  [runtime calls completeTurn()]
  [runtime queues agent_finished:<agent_id>:<turn_id>]

  -> parent calls any later MCP tool
  <- normal tool result
     + agent_finished:<agent_id>:<turn_id>

  -> subagent_result({ turn_ids: [...] })
  <- completed answer
```

If completion is first discovered during `subagent_result` itself, that same tool response may carry both the retrieved result and the newly queued `agent_finished` event because events are drained after the tool callback returns.

## Public Tool Flow

`subagent_start` accepts one to three independent agents. Each entry supplies a stable caller-chosen `agent_id`, a prompt, and optional first-conversation `oververbosity`. Reusing an existing `agent_id` continues the same ChatGPT conversation while that binding remains recoverable.

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
```

`subagent_result` accepts one to three `turn_id` values and retrieves them concurrently. `wait_ms` is bounded to 0-60 seconds; while waiting, each still-running turn is reconciled roughly once per second.

```ts
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

`oververbosity` defaults to `2` and is applied only when a new `agent_id` creates its first conversation. Levels below `5` append the configured Caveman response-style instruction to that first prompt. Follow-up turns send the caller's prompt unchanged (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/subagent-tools.ts`).

## End-to-End Turn Lifecycle

The normal lifecycle is:

1. `subagent_start` validates the batch and staggers submissions.
2. `ask()` acquires the per-agent/global generation slot.
3. The module creates or recovers the agent's owned ChatGPT page.
4. The prompt is submitted once and a `BrowserTurnState` is created.
5. First-turn stable conversation binding begins if the conversation does not yet have a permanent `/c/<id>` URL.
6. Two autonomous completion observers run in parallel: the structured network tracker and the one-second server/UI watcher.
7. Whichever trusted path proves completion first calls `completeTurn()`.
8. `completeTurn()` stores the response, releases capacity, and queues `agent_finished` exactly once.
9. The parent receives that event on the next MCP tool response and calls `subagent_result` when it wants the answer.
10. `subagent_result` also acts as a reconciliation/recovery boundary if autonomous observation missed or partially lost state.

The important design property is that these paths are redundant observers of one turn, not separate lifecycle owners. They all converge on the same guarded `completeTurn()` transition.

## Runtime State and Identity

The process keeps these main structures (`src/tools/subagent/chatgpt-subagent.ts`):

```text
agents: agent_id -> BrowserAgentState
conversationRefs: agent_id -> saved conversation ID/URL + turn counter
turns: turn_id -> BrowserTurnState
activeTurnsByAgent: agent_id -> currently running turn_id
activeAgentIds: agent IDs with an operation in progress
pendingEvents: queued agent_finished notifications
```

`BrowserAgentState` owns the live Playwright `Page`, `ChatGptConversationTracker`, stable conversation identity when known, completion/use timestamps, and per-agent turn counter.

`BrowserTurnState` owns one detached turn's lifecycle: `running | completed | failed`, activity heartbeat, final response/error, response baselines, and shared one-shot recovery state.

Turn IDs are sequential per agent:

```text
reviewer_turn_1
reviewer_turn_2
reviewer_turn_3
```

`conversationRefs` also stores `turnCount`, so an agent evicted from live browser state and later recovered in the same MCP process does not reuse old turn IDs.

## Browser and Page Ownership

Each live agent owns one Playwright `Page`. Routing is page-based, not foreground-input-based. Tab order, active window, mouse position, and keyboard focus are irrelevant to which subagent receives a prompt.

`createAgent()` creates a new module-owned page. If a saved `conversationRef` exists, the replacement page opens that exact saved ChatGPT conversation and verifies it is available. Otherwise it opens the base ChatGPT URL for a new conversation.

`ensureActivePage()` accepts the existing page only when it still matches the agent's expected ChatGPT target. If a previously bound page was closed or lost, it opens a replacement page from the saved conversation URL. It does **not** hijack an unrelated tab the user navigated somewhere else.

Before a prompt is submitted, `assertPreSubmitLocation()` verifies ownership again. This prevents an unrelated manually navigated tab from receiving a prompt by accident.

## First-Turn Conversation Binding

New ChatGPT conversations do not receive their permanent URL immediately. The first prompt may move through:

```text
https://chatgpt.com/
        ↓
/c/WEB:<temporary-id>
        ↓
/c/<stable-conversation-id>
```

`extractConversationId()` deliberately ignores `WEB:` temporary IDs.

After a first-turn submission, `subagent_start` launches `waitForStableConversationLocation()` as a best-effort start-time binding task, currently capped at 30 seconds. When the stable `/c/<id>` appears, it saves `conversationId`, `conversationUrl`, and `conversationRefs` (`src/tools/subagent/chatgpt-subagent-browser.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

The completion watcher does **not** own conversation identity discovery. It consumes `state.conversationId` when available. `subagent_result` reconciliation can still repair a missed first-turn binding later.

Expected first-turn routing behavior:

```text
https://chatgpt.com/                  -> still unbound; valid first-turn page
/c/WEB:<temporary-id>                -> still unbound; do not save
/c/<stable-id>                       -> bind and save
different /c/<id> after binding      -> target lost
non-ChatGPT URL                      -> target lost
```

Before the stable URL is captured there is no saved conversation URL from which a lost first-turn page can be reconstructed. This is why preserving and binding the original submitted page matters.

## Prompt Submission

`ask()` performs only enough synchronous work to safely submit the prompt and establish turn state. It does not wait for the answer.

Before submission it:

- connects to the configured CDP browser;
- resolves or creates the agent;
- enforces the minimum inter-turn delay;
- verifies page ownership;
- snapshots network message IDs and existing assistant DOM messages so later observers know what belongs to this turn;
- dismisses the known ChatGPT `#modal-beacon` overlay with `Escape` when necessary;
- locates the composer;
- enters the prompt;
- verifies page ownership again;
- submits exactly once.

The overlay retry is limited to atomic pre-submit UI interactions. Once the prompt is submitted, recovery logic never resubmits it automatically.

After submission `ask()` creates the turn, stores it in the runtime maps, attaches the network listeners, starts first-turn URL binding when needed, starts the detached completion watcher, and returns the `turn_id` immediately.

## Why Completion Uses Multiple Signals

No single ChatGPT Web signal has proven sufficient by itself.

### Structured network final: fastest path

`ChatGptConversationTracker` listens to Playwright `page.on("response")` events for conversation-shaped responses and merges ChatGPT mapping nodes by message ID.

A structured assistant node is considered final only when it satisfies the final-response rules, including assistant role, successful status, final-user recipient, non-empty text, and end-of-turn/completion metadata. The tracker also requires the submitted user prompt to be present in the new response graph before associating a final assistant node with the active turn. This prevents unrelated conversation payloads from completing the wrong turn (`src/tools/subagent/chatgpt-subagent-browser.ts`).

When a definitive structured final arrives, `attachTurnListeners()` calls `completeTurn()` immediately. This remains the lowest-latency completion path.

### Why `page.on("response")` is not enough

ChatGPT can return `/backend-api/f/conversation` as an SSE handoff and continue the actual generation on a secondary stream. That continuation is not guaranteed to surface as a normal Playwright HTTP `response` containing the final conversation graph.

The observed failure mode was:

```text
page.on("response") sees stream handoff
        ↓
final assistant payload continues elsewhere
        ↓
tracker never receives definitive final node
```

Therefore the network listener is opportunistic and fast, but it cannot be the only autonomous completion mechanism.

### Server/UI watcher: reliability path

Every active turn also runs `watchTurnCompletion()` once per second. On each normal tick it observes in parallel:

```text
server state: /backend-api/conversation/<id>/stream_status
UI state:     visible ChatGPT stop/generating control
DOM state:    new assistant message relative to the turn baseline
```

The authority rules are:

| Server status | UI stop button | New DOM answer | Meaning / action |
| --- | --- | --- | --- |
| `COMPLETE` | absent or present | present | Complete immediately. Server state wins even if UI is stale. |
| `COMPLETE` | absent or present | absent | Enter the five-second DOM grace period. |
| `IS_STREAMING` | absent or present | any | Keep waiting. Server state prevents premature completion. |
| unavailable/unknown | present | present or absent | Keep waiting; UI still says generation is active. |
| unavailable/unknown | absent | present | Use stable-DOM fallback: answer must be unchanged across watcher ticks before completing. |
| unavailable/unknown | absent | absent | Keep waiting. |

This gives the server endpoint authority over lifecycle when it is available, while preserving the UI/DOM pair as a degradation fallback if that private endpoint is temporarily unavailable.

The one-second watcher itself does **not** refresh `lastActivityAt`. Polling is observation, not proof of progress. A wedged turn must not stay alive forever merely because the watcher is still making requests.

## Server COMPLETE and the Five-Second DOM Grace Period

`stream_status === "COMPLETE"` proves generation has ended, but the final DOM node may render slightly later. The watcher therefore does not immediately fail or recover when the server finishes before the page catches up.

It waits up to five seconds and checks for the new assistant DOM message once per second:

```text
server => COMPLETE
  -> DOM answer present?
       yes -> completeTurn()
       no  -> wait 1 second
              retry, up to 5 seconds total
```

If the message still has not appeared after that grace period, the watcher reuses the existing one-shot conversation recovery path. It does not introduce a second recovery subsystem.

## The Stale ChatGPT UI Failure and Why Server State Wins

ChatGPT Web can leave the original managed tab in a stale client state after the server has already finished a turn. The observed broken state was:

```text
assistant answer fully rendered in DOM
server stream_status = COMPLETE
but original managed tab still shows "Stop answering"
and still carries streaming UI state
```

Opening the exact same conversation URL in a fresh tab showed the completed answer with no stop button. The server was finished; only the React client state in the original page was stale.

Therefore:

```text
stream_status = lifecycle truth
stop button    = UI-health signal
```

The stop button is still useful, but it is no longer authoritative when the server explicitly reports `COMPLETE`.

Before submitting a later follow-up, `ask()` checks the managed tab. If the UI still claims it is generating but the known conversation's server status is `COMPLETE`, the page is treated as stale and reloaded before the next prompt is entered. If the server does not confirm completion, the agent remains busy.

## `completeTurn()` Is the Single Completion Gate

All successful completion paths converge on `completeTurn()`:

```text
structured page.on("response") final ──┐
                                       │
server/UI completion watcher ──────────┼──> completeTurn()
                                       │
subagent_result reconciliation ────────┤
                                       │
one-shot recovery ─────────────────────┘
```

`completeTurn()` starts with:

```text
if turn.status !== "running": return
```

That guard is the race-safety mechanism. If the network listener and watcher discover completion at nearly the same time, only the first caller performs the transition. Later callers become no-ops.

The successful transition:

```text
running -> completed
store response
update completion/use timestamps
save conversation reference when available
release active turn + global generation slot
queue agent_finished:<agent_id>:<turn_id>
```

Because notification queueing now lives inside this guarded transition, completion observers cannot independently emit duplicate notifications.

## Completion Event Delivery

`pendingEvents` is process-local. `drainEvents()` removes and returns all currently queued events.

Every registered MCP tool runs through `installToolRegistrationBoundary()`. After the real tool callback finishes, the boundary calls `drainPendingEvents()` and appends those event strings to the tool's text content (`src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`).

This means the event is delivered on the **next tool response produced after completion**, regardless of which MCP tool the parent happened to call next. Integration coverage verifies that an event appears once and is absent from the following tool result (`test/mcp-integration.test.ts`).

The event intentionally contains no answer text. Its job is only to tell the parent that the detached work is ready. The answer is retrieved with `subagent_result`.

## `subagent_result`: Retrieval and Self-Healing Reconciliation

`subagent_result` does more than read cached state. For any turn still marked `running`, `poll()` calls `reconcileRunningTurn()` before returning.

Reconciliation can:

- repair a first-turn stable URL binding that start-time binding missed;
- validate or recover the managed page;
- reattach network listeners after page replacement;
- inspect the current DOM;
- check both `stream_status` and the visible generating control;
- complete a turn that autonomous observation missed;
- enter the shared one-shot recovery path after browser-observation failure.

The same authority rule applies here: explicit `IS_STREAMING` keeps the turn running even if the stop button is missing; explicit `COMPLETE` allows a rendered DOM answer to finish even if the stop button is stale.

With positive `wait_ms`, `poll()` repeats reconciliation roughly once per second until the turn becomes terminal or the requested wait window expires. It never resubmits a prompt.

## One-Shot Conversation Recovery

Recovery is deliberately limited. A successfully submitted prompt must not be duplicated just because browser observation fails.

When recovery is allowed, `recoverSubmittedTurn()`:

1. validates or recreates the agent's owned page from the saved conversation URL;
2. captures/validates the conversation location;
3. reloads the server-side conversation payload when a conversation ID is available;
4. walks the active conversation branch and looks for the latest assistant answer after the submitted prompt;
5. falls back to the recovered DOM when appropriate;
6. calls `completeTurn()` if a final answer is found.

`BrowserTurnState.recoveryAttempted` and `recoveryPromise` make this one shared attempt even when multiple observers fail concurrently. A later independent observation failure becomes terminal rather than creating a recovery loop.

The background completion watcher also uses this same recovery path after `COMPLETE` plus five seconds with no rendered DOM answer. This keeps all last-effort recovery logic centralized.

## Activity and Liveness

Running results can expose one coarse activity value:

```text
Working
Searching the web
Using tools
Generating response
```

The `ChatGptConversationTracker` updates activity only when meaningful normalized network state changes. Web/search recipients map to `Searching the web`; other internal recipients map to `Using tools`; assistant output maps to `Generating response`; other changes map to `Working`.

`activity_age_ms` is milliseconds since the last observable progress. It is not time since the last `subagent_result` call and not an ETA.

Watcher ticks, repeated reads of unchanged state, and result polling do not count as progress.

There is no fixed generation-duration timeout. A legitimately long-running turn can continue beyond 30 minutes as long as meaningful activity keeps refreshing its heartbeat.

## Parallel Starts, Per-Agent Locking, and Capacity

`subagent_start` accepts up to three agents. Batch entries are submitted in order with:

```text
agent 1: immediately
agent 2: 5 seconds later
agent 3: 7 seconds after agent 2
```

The staggering reduces simultaneous browser interaction only; already-submitted agents continue generating concurrently (`SUBAGENT_START_DELAYS_MS` in `src/tools/subagent/subagent-tools.ts`).

`beginAgentOperation()` enforces two independent constraints:

- one active operation/turn per `agent_id`;
- at most three active generations process-wide.

Same-agent overlap returns `AGENT_BUSY`. A fourth concurrent generation returns `SUBAGENT_CAPACITY_REACHED`. There is no hidden work queue.

Batch failures are isolated per entry. A failed submission does not roll back already-submitted siblings. If request cancellation occurs during a stagger delay, the unsent entry fails and later entries are not submitted; already-submitted turns continue.

## 30-Minute Idle Cleanup

`cleanupIdleAgents()` runs once per minute. The runtime safety policy is 30 minutes without meaningful activity.

For a running turn, idle age is measured from `BrowserTurnState.lastActivityAt`. For an agent without a running turn, it is measured from `BrowserAgentState.lastUsedAt`.

On eviction the module:

1. saves the known conversation ID/URL and turn counter when available;
2. marks a stale running turn failed and releases generation capacity;
3. disposes the page's response tracker;
4. removes the live agent and its local turn records;
5. removes pending completion events for those discarded turns;
6. closes the page only if it is still the module-owned expected ChatGPT page.

The ChatGPT conversation itself is not deleted. Because local turn records are removed, requesting an evicted old `turn_id` returns `UNKNOWN_TURN`.

## Conversation Recovery After Idle Eviction or Page Loss

`conversationRefs` makes live browser state disposable within the running MCP process. It stores:

```text
agent_id -> conversationId + conversationUrl + turnCount
```

After idle eviction, reusing the same `agent_id` causes `createAgent()` to reopen and verify the saved ChatGPT conversation and restore the turn counter.

`ensureActivePage()` uses the same saved URL to replace a closed/lost managed page. It never silently creates a new conversation under the old agent identity when the saved conversation is missing.

If the saved ChatGPT conversation was deleted or is unavailable, the operation fails with `SUBAGENT_CONVERSATION_NOT_FOUND`.

`conversationRefs` is process-local, not durable storage. A full MCP process restart loses these bindings even though the actual conversations remain in the ChatGPT account history.

## Failure Semantics

Important service errors are defined by `ChatGptSubagentErrorCode` in `src/tools/subagent/chatgpt-subagent-contracts.ts`:

| Error | Meaning |
| --- | --- |
| `BROWSER_UNAVAILABLE` | Configured CDP browser cannot be reached. |
| `CHATGPT_NOT_AUTHENTICATED` | Attached browser is not signed into ChatGPT. |
| `AGENT_BUSY` | Same agent already owns an active operation or turn. |
| `SUBAGENT_CAPACITY_REACHED` | Three generations are already active. |
| `AGENT_TARGET_LOST` | Managed page/conversation ownership was lost. |
| `SUBAGENT_CONVERSATION_NOT_FOUND` | Saved conversation no longer resolves. |
| `UNKNOWN_TURN` | Requested process-local turn state does not exist. |
| `REQUEST_ABORTED` | Caller cancelled the MCP operation. |
| `CHATGPT_UI_CHANGED` | Required ChatGPT UI assumption no longer holds. |

The MCP wrapper catches failures per batch item. One bad `subagent_start` entry or one bad `subagent_result` turn does not discard valid sibling results.

Idle expiration uses the internal error code `AGENT_IDLE_EXPIRED` on the turn result even though that value is not part of the exported `ChatGptSubagentErrorCode` union.

## Why the Current Design Exists

The current implementation is intentionally redundant because two earlier assumptions proved unsafe.

### Old background DOM watcher

The original implementation ran `waitForResponse()` every 250 ms. It checked the structured network tracker first, then inspected the DOM and waited for assistant text to remain stable for 750 ms after the UI stopped generating.

That background loop was removed in commit `e3f3dec` (`Simplify subagent polling and document compact outputs`) and `subagent_result` became the active reconciler. Passive network completion was later added back through `page.on("response")`.

The old loop provided autonomous completion, but its final DOM decision still depended on the stop button disappearing. It therefore would also have hung in the stale-client failure where the server was complete but the original tab kept showing `Stop answering`.

### Stream handoff + stale UI

The later failure exposed two independent weaknesses at once:

```text
network tracker may miss final after ChatGPT stream_handoff
                        +
original page may keep stale stop/streaming UI after server completion
                        =
turn appears to run forever even though answer is visible and server is done
```

The current architecture keeps the useful low-latency `page.on("response")` path, restores autonomous background completion, and changes the reliable fallback from UI inference to explicit server lifecycle state.

## Maintainer Invariants

Changes to this subsystem should preserve these invariants:

1. A submitted prompt is never automatically submitted twice.
2. A detached turn can complete and queue `agent_finished` without `subagent_result` being called.
3. `completeTurn()` is the only successful running-to-completed lifecycle gate and the only place that queues `agent_finished`.
4. Server `COMPLETE` overrides stale generating UI; server `IS_STREAMING` overrides prematurely idle UI.
5. DOM text alone is not treated as immediately final while authoritative server state says generation is active.
6. Watcher polling does not count as activity/progress.
7. First-turn stable conversation identity is bound independently of result polling whenever possible.
8. Recovery reuses the existing submitted conversation; it never resubmits the prompt.
9. A manually repurposed user tab is never hijacked back into subagent control.
10. One agent has at most one active turn and the process has at most three active generations.

## Code Map

| Location | Important symbols | Responsibility |
| --- | --- | --- |
| `src/tools/subagent/chatgpt-subagent.ts` | `ChatGptSubagentModule`, `ask()`, `poll()` | Main detached-turn lifecycle and service API. |
| `src/tools/subagent/chatgpt-subagent.ts` | `createAgent()`, `ensureActivePage()`, `rememberConversation()` | Page ownership, replacement, and saved conversation bindings. |
| `src/tools/subagent/chatgpt-subagent.ts` | `attachTurnListeners()` | Fast structured-network completion and activity listener attachment. |
| `src/tools/subagent/chatgpt-subagent.ts` | `watchTurnCompletion()` | One-second server/UI/DOM autonomous completion watcher and five-second DOM grace behavior. |
| `src/tools/subagent/chatgpt-subagent.ts` | `completeTurn()`, `finishTurnOperation()` | Single successful lifecycle transition, capacity release, and completion event queueing. |
| `src/tools/subagent/chatgpt-subagent.ts` | `reconcileRunningTurn()` | Explicit `subagent_result` self-healing observation. |
| `src/tools/subagent/chatgpt-subagent.ts` | `failOrRecoverSubmittedTurn()`, `recoverSubmittedTurn()` | Shared one-shot recovery after submitted-turn observation failure. |
| `src/tools/subagent/chatgpt-subagent.ts` | `cleanupIdleAgents()` | 30-minute inactivity reclamation. |
| `src/tools/subagent/chatgpt-subagent-browser.ts` | `ChatGptConversationTracker` | Conversation graph normalization, activity, and structured-final detection. |
| `src/tools/subagent/chatgpt-subagent-browser.ts` | `getConversationStreamStatus()` | ChatGPT server generation-state probe. |
| `src/tools/subagent/chatgpt-subagent-browser.ts` | `isGenerating()` | UI stop/generating health signal. |
| `src/tools/subagent/chatgpt-subagent-browser.ts` | `waitForStableConversationLocation()`, `captureOrValidateConversationLocation()` | Stable first-turn URL binding and conversation ownership validation. |
| `src/tools/subagent/chatgpt-subagent-browser.ts` | `findNewDomAssistantMessage()`, `loadConversationPayload()` | DOM fallback and recovery payload loading. |
| `src/tools/subagent/chatgpt-subagent-contracts.ts` | public service/result/error types | Dependency-light subagent contracts. |
| `src/tools/subagent/subagent-tools.ts` | `registerSubagentTools()`, `SUBAGENT_START_DELAYS_MS` | Public MCP schemas, staggered batching, and concurrent result fan-out. |
| `src/server/tool-registration-boundary.ts` | `installToolRegistrationBoundary()` | Drains pending completion events after every MCP tool callback. |
| `src/server/tool-output.ts` | `appendToolEvents()` | Appends queued `agent_finished` strings to model-facing tool content. |
| `src/server/mcp-server.ts` | `drainPendingEvents` wiring | Connects global MCP tool responses to the process-level subagent event queue. |
| `src/index.ts` | process-level `ChatGptSubagentModule` | Production singleton shared across stateless MCP requests. |
| `scripts/chatgpt-browser.mjs` | managed Chrome helper | Dedicated authenticated Chrome/profile setup and lifecycle. |
| `test/chatgpt-subagent.test.ts` | lifecycle tests | Capacity, stale UI/server completion, watcher behavior, recovery, event uniqueness, and idle cleanup. |
| `test/chatgpt-subagent-browser.test.ts` | browser-adapter tests | Conversation parsing, transient URL behavior, overlays, activity, and final-node matching. |
| `test/mcp-integration.test.ts` | MCP integration tests | Event injection exactly once, subagent output, staggering, concurrency, and cross-request sharing. |

## Operational Risks

- ChatGPT DOM selectors and private endpoints are not public stable APIs. Keep those assumptions isolated in `chatgpt-subagent-browser.ts` where possible.
- `stream_status` is intentionally treated as a best available server-side lifecycle signal, not as a reason to remove the network or UI fallbacks.
- The attached browser must already be authenticated. The proven production path is a normal headed dedicated Chrome profile exposed over CDP.
- Request cancellation after a prompt was already sent cannot unsend that ChatGPT turn.
- A full MCP process restart loses process-local agent/turn/conversation bindings and pending completion events.
- The underlying ChatGPT conversation may continue to exist even when local runtime state is gone.
