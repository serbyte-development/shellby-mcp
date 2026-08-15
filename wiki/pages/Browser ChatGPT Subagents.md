# Browser ChatGPT Subagents

Verified 2026-08-15 against current source and tests.

## What This Is

Unhinged Agent exposes ChatGPT Web as a detached browser-backed delegation system. The parent model submits work with `subagent_run`, continues doing other work, learns asynchronously when a delegated turn finishes, and later retrieves the answer with `subagent_result`.

The browser implementation lives in one process-level `ChatGptSubagentModule`. MCP requests themselves are stateless, but the module keeps browser pages, agent/conversation bindings, turn state, completion events, and recovery metadata alive across requests (`src/tools/subagent/chatgpt-subagent.ts`, `src/index.ts`, `src/server/http-server.ts`, `src/server/mcp-server.ts`).

The module attaches to an already-running authenticated Chrome instance through Playwright-over-CDP. It does not launch an arbitrary user profile itself. Production browser setup/start/hide behavior belongs to `scripts/chatgpt-browser.mjs` and `scripts/start.mjs`; the CDP endpoint comes from `MCP_CONFIG.chatGpt.cdpEndpoint` and defaults to `http://127.0.0.1:9222` (`src/config.ts`).

## Core Contract: Completion Must Be Detected Autonomously

The most important invariant is not merely that `subagent_result` can eventually discover an answer. **The runtime must know when a detached turn has finished without waiting for the parent model to poll.**

When a turn completes, `completeTurn()` must perform the single running-to-completed transition, store the answer, release the per-agent and global generation slot, and queue exactly one:

```text
agent_finished:<agent_id>:<turn_id>
```

The global MCP tool-registration boundary drains queued events after a tool handler finishes and appends them to the next MCP tool response. Internal events keep the compact colon-delimited form above, while model-facing output renders the completion signal as `**agent_finished:** agent_id=<agent_id> turn_id=<turn_id>` so it stands out without overwhelming the surrounding tool result. That is how a parent model that is still running unrelated tools learns that a background subagent is ready (`src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`, `src/server/mcp-server.ts`).

`subagent_result` is therefore the explicit answer-retrieval and self-healing API, **not the only completion detector**.

```text
parent model
  -> subagent_run(...)
  <- turn_id

  -> parent continues other work

  [background turn finishes]
  [runtime calls completeTurn()]
  [runtime queues agent_finished:<agent_id>:<turn_id>]

  -> parent calls any later MCP tool
  <- normal tool result
     + **agent_finished:** agent_id=<agent_id> turn_id=<turn_id>

  -> subagent_result({ turn_ids: [...] })
  <- completed answer
```

If completion is first discovered during `subagent_result` itself, that same tool response may carry both the retrieved result and the newly queued `agent_finished` event because events are drained after the tool callback returns.

## Public Tool Flow

`subagent_run` accepts one to three independent agents. Its public contract intentionally mirrors `shell_run`: `agent_id` is the persistent-context identifier, analogous to `shell_id`, while each returned `turn_id` identifies one submitted operation. Reusing an existing `agent_id` retains the same ChatGPT conversation context while that binding remains recoverable; using a different ID creates independent concurrent context.

```ts
subagent_run({
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

1. `subagent_run` validates the batch and staggers submissions.
2. `ask()` acquires the per-agent/global generation slot.
3. The module creates or recovers the agent's owned ChatGPT page.
4. The prompt is submitted once and a `BrowserTurnState` is created.
5. First-turn stable conversation binding begins if the conversation does not yet have a permanent `/c/<id>` URL.
6. Two autonomous completion observers run in parallel: the structured network tracker and the one-second server-status watcher.
7. Whichever trusted path proves completion first calls `completeTurn()`.
8. `completeTurn()` stores the response, releases capacity, and queues `agent_finished` exactly once.
9. The parent receives that event on the next MCP tool response and calls `subagent_result` when it wants the answer.
10. `subagent_result` also acts as a reconciliation/recovery boundary if autonomous observation missed or partially lost state.

The important design property is that completion detection and answer extraction are separate concerns. The passive network conversation payload is authoritative for the stored answer because it preserves the server-returned Markdown/code text exactly. A final tracked assistant node must be `finished_successfully` and explicitly marked `end_turn: true`; an intermediate node being `is_complete` is not enough. The watcher runs every 1,000 ms and checks the tracker first on every pass, matching the original network-first polling semantics without the old 250 ms cadence. Conversation-wide `COMPLETE` is trusted only after this turn has first been observed as `IS_STREAMING`, or after the generating UI has been observed and then stopped, so a follow-up cannot inherit the previous turn's stale completion bit. `IS_STREAMING`, unknown stream status, a currently visible generating UI, or rendered text such as `Thinking` all mean keep polling. Once the current turn is positively complete, the tracker is checked again. If the expected final network node is still absent, one recovery reload of the saved conversation captures ChatGPT's canonical `/backend-api/conversation/<conversation_id>` JSON and resolves the assistant answer from that exact server payload. Rendered DOM text is used only if that canonical recovery also fails to provide the answer. The submitted prompt is never retried.

The real browser contract has two manual compatibility layers, both excluded from the normal test glob and CI. `test/live/chatgpt-fixture-live.test.ts` (`npm run test:live:fixture`) owns strict compatibility checks: it opens a permanent saved conversation in a disposable Chrome CDP target without submitting a prompt, captures `/backend-api/conversation/<id>`, deliberately reloads only that disposable fixture tab, compares the extracted active branch with the sanitized frozen fixture at `test/fixtures/chatgpt-live-fixture/conversation.json`, and verifies exact Markdown/code plus recognizable rendered DOM structure. `test/live/subagent-live.test.ts` (`npm run test:live:subagent`) deliberately does **not** duplicate those assertions. It is a minimal generative black-box canary that starts the normal MCP HTTP server and interacts only through public `subagent_run`/`subagent_result`: Turn 1 must start and return a non-empty response containing a random context key, then Turn 2 on the same `agent_id` must return a non-empty response containing that remembered key. It records a polling/failure artifact for diagnosis but does not inspect module internals, tracker state, DOM, Page identity, conversation IDs, Markdown fidelity, compact formatting, or exact event/turn naming. The test itself never reloads the managed agent page. A live-test-only five-minute process hard cap prevents a lingering Playwright/CDP handle from leaving the test runner alive indefinitely after the test body finishes (`test/live/subagent-live.test.ts`).

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

After a first-turn submission, `subagent_run` launches `waitForStableConversationLocation()` as a best-effort start-time binding task, currently capped at 30 seconds. When the stable `/c/<id>` appears, it saves `conversationId`, `conversationUrl`, and `conversationRefs` (`src/tools/subagent/chatgpt-subagent-browser.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

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

| Server status       | Current-turn evidence                              | UI stop button    | Meaning / action                                                                 |
| ------------------- | -------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `COMPLETE`          | current turn was previously `IS_STREAMING`          | absent or present | Current turn is complete; prefer network answer, then bounded recovery if needed. |
| `COMPLETE`          | generating UI was observed and has now stopped      | absent            | Current turn is complete; prefer network answer, then bounded recovery if needed. |
| `COMPLETE`          | no current-turn generation evidence                 | absent or present | Treat as potentially stale from the previous turn and keep waiting.               |
| `IS_STREAMING`      | any                                                 | absent or present | Keep waiting.                                                                    |
| unavailable/unknown | any                                                 | absent or present | Keep waiting; unknown lifecycle state never proves completion.                    |

The server endpoint is the strongest lifecycle signal, but conversation-wide `COMPLETE` is not attributed to a new follow-up until this turn has its own generation evidence. DOM text is answer fallback only after current-turn completion has already been proven; it does not independently end an unknown-state turn.

The one-second watcher itself does **not** refresh `lastActivityAt`. Polling is observation, not proof of progress. A wedged turn must not stay alive forever merely because the watcher is still making requests.

## Server COMPLETE and the Five-Second DOM Grace Period

Once the current turn has its own generation evidence, `stream_status === "COMPLETE"` proves that turn has ended, but the final DOM node may render slightly later. Without current-turn evidence, the same conversation-wide value may still belong to the previous turn and is ignored. The watcher therefore does not immediately fail or recover when the server finishes before the page catches up.

The autonomous watcher waits up to five seconds and checks for the new assistant DOM message once per second:

```text
server => COMPLETE with current-turn evidence
  -> network final present?
       yes -> completeTurn(network)
       no  -> DOM answer present?
              yes -> completeDetectedTurn()
                     -> network again
                     -> one recovery attempt
                     -> DOM only if recovery did not produce server text
              no  -> wait 1 second
                     retry DOM, up to 5 seconds total
```

The watcher itself is redundant and does not force a reload merely because the five-second DOM grace expires with no DOM answer. Explicit `subagent_result` reconciliation continues checking the turn once per second and, once current-turn completion is proven, calls the same `completeDetectedTurn()` path even when no DOM answer is available. That is the reliable boundary that can invoke the shared one-shot recovery. This keeps ordinary waiting passive while still allowing a completed turn to recover exact server text when the streaming listener missed it (`src/tools/subagent/chatgpt-subagent.ts`).

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
current-turn stream_status = lifecycle truth once attributed to this turn
stop button                 = UI-health signal
```

The stop button is still useful, but it is no longer authoritative once a server `COMPLETE` has been safely attributed to the current turn.

Before submitting a later follow-up, `ask()` checks the managed tab. If the UI still claims it is generating but the known conversation's server status is `COMPLETE`, that UI is treated as stale from the prior completed turn and submission continues on the same page without reloading it. If the server does not confirm completion, the agent remains busy. Normal submission and ordinary running-state polling never reload the page; the single reload path is reserved for a positively completed turn whose expected final network payload was not captured.

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

1. records whether the existing managed page is still the expected ChatGPT conversation;
2. calls `ensureActivePage()`; if the page was closed/lost, that opens the saved conversation once instead of creating a new conversation;
3. reattaches the passive network listener and lets any recovered exact network final complete the turn first;
4. when the original managed page is still valid and a stable conversation ID exists, reloads that same page once while `loadConversationPayload()` waits specifically for ChatGPT's successful `/backend-api/conversation/<conversation_id>` response;
5. extracts the active conversation branch and finds the assistant answer after the submitted prompt, preserving exact server `content.parts` text when found;
6. otherwise inspects the recovered page's DOM and uses it only when the page is no longer generating.

`BrowserTurnState.recoveryAttempted` and `recoveryPromise` make this one shared attempt even when multiple observers fail concurrently. A later independent observation failure becomes terminal rather than creating a recovery loop.

`completeDetectedTurn()` checks the passive tracker first. Once the current turn is positively complete and the expected final network answer is still absent, it may enter this same shared one-shot recovery before accepting DOM fallback. Browser/page observation failures also use the same recovery state. `BrowserTurnState.recoveryAttempted` plus `recoveryPromise` ensure concurrent observers share one attempt. No path resubmits the prompt or loops reloads. Normal polling and normal follow-up submission do not reload the page (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/chatgpt-subagent-browser.ts`).

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

`subagent_run` accepts up to three agents. Batch entries are submitted in order with:

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

| Error                             | Meaning                                              |
| --------------------------------- | ---------------------------------------------------- |
| `BROWSER_UNAVAILABLE`             | Configured CDP browser cannot be reached.            |
| `CHATGPT_NOT_AUTHENTICATED`       | Attached browser is not signed into ChatGPT.         |
| `AGENT_BUSY`                      | Same agent already owns an active operation or turn. |
| `SUBAGENT_CAPACITY_REACHED`       | Three generations are already active.                |
| `AGENT_TARGET_LOST`               | Managed page/conversation ownership was lost.        |
| `SUBAGENT_CONVERSATION_NOT_FOUND` | Saved conversation no longer resolves.               |
| `UNKNOWN_TURN`                    | Requested process-local turn state does not exist.   |
| `REQUEST_ABORTED`                 | Caller cancelled the MCP operation.                  |
| `CHATGPT_UI_CHANGED`              | Required ChatGPT UI assumption no longer holds.      |

The MCP wrapper catches failures per batch item. One bad `subagent_run` entry or one bad `subagent_result` turn does not discard valid sibling results.

Idle expiration uses the internal error code `AGENT_IDLE_EXPIRED` on the turn result even though that value is not part of the exported `ChatGptSubagentErrorCode` union.

## Why the Current Design Exists

The current implementation is intentionally redundant because two earlier assumptions proved unsafe.

### Old 250 ms watcher and the restored polling principle

The original implementation ran `waitForResponse()` every 250 ms. Its useful property was not the 250 ms frequency; it was that every pass checked the structured network tracker before considering rendered DOM state.

That background loop was removed in commit `e3f3dec` (`Simplify subagent polling and document compact outputs`) and `subagent_result` became the active reconciler. Passive network completion was later added back through `page.on("response")`.

The current implementation restores that network-first polling principle at a 1,000 ms cadence while retaining the newer server-status/current-turn protections. The passive `page.on("response")` listener is a fast path, not an assumption that every streamed chunk produces a new Playwright `Response`. If the listener eventually populates the final node, the next one-second pass sees it. If current-turn completion is positively established but the final network node never materializes, the one-shot canonical reload capture is available before DOM fallback.

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
11. Normal lifecycle polling is approximately once per second and checks the passive network tracker first; reload/open recovery is one-shot and never part of ordinary inter-turn behavior.

## Code Map

| Location                                           | Important symbols                                                                | Responsibility                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/tools/subagent/chatgpt-subagent.ts`           | `ChatGptSubagentModule`, `ask()`, `poll()`                                       | Main detached-turn lifecycle and service API.                                                         |
| `src/tools/subagent/chatgpt-subagent.ts`           | `createAgent()`, `ensureActivePage()`, `rememberConversation()`                  | Page ownership, replacement, and saved conversation bindings.                                         |
| `src/tools/subagent/chatgpt-subagent.ts`           | `attachTurnListeners()`                                                          | Fast structured-network completion and activity listener attachment.                                  |
| `src/tools/subagent/chatgpt-subagent.ts`           | `watchTurnCompletion()`                                                          | One-second server/UI/DOM autonomous completion watcher and five-second DOM grace behavior.            |
| `src/tools/subagent/chatgpt-subagent.ts`           | `completeTurn()`, `finishTurnOperation()`                                        | Single successful lifecycle transition, capacity release, and completion event queueing.              |
| `src/tools/subagent/chatgpt-subagent.ts`           | `reconcileRunningTurn()`                                                         | Explicit `subagent_result` self-healing observation.                                                  |
| `src/tools/subagent/chatgpt-subagent.ts`           | `failOrRecoverSubmittedTurn()`, `recoverSubmittedTurn()`                         | Shared one-shot recovery after submitted-turn observation failure.                                    |
| `src/tools/subagent/chatgpt-subagent.ts`           | `cleanupIdleAgents()`                                                            | 30-minute inactivity reclamation.                                                                     |
| `src/tools/subagent/chatgpt-subagent-browser.ts`   | `ChatGptConversationTracker`                                                     | Conversation graph normalization, activity, and structured-final detection.                           |
| `src/tools/subagent/chatgpt-subagent-browser.ts`   | `getConversationStreamStatus()`                                                  | ChatGPT server generation-state probe.                                                                |
| `src/tools/subagent/chatgpt-subagent-browser.ts`   | `isGenerating()`                                                                 | UI stop/generating health signal.                                                                     |
| `src/tools/subagent/chatgpt-subagent-browser.ts`   | `waitForStableConversationLocation()`, `captureOrValidateConversationLocation()` | Stable first-turn URL binding and conversation ownership validation.                                  |
| `src/tools/subagent/chatgpt-subagent-browser.ts`   | `loadConversationPayload()`                                                       | One-shot same-page reload capture of canonical conversation JSON during recovery.                      |
| `src/tools/subagent/chatgpt-subagent-browser.ts`   | `findNewDomAssistantMessage()`                                                    | Rendered DOM fallback after network/canonical recovery misses.                                         |
| `src/tools/subagent/chatgpt-subagent-contracts.ts` | public service/result/error types                                                | Dependency-light subagent contracts.                                                                  |
| `src/tools/subagent/subagent-tools.ts`             | `registerSubagentTools()`, `SUBAGENT_START_DELAYS_MS`                            | Public MCP schemas, staggered batching, and concurrent result fan-out.                                |
| `src/server/tool-registration-boundary.ts`         | `installToolRegistrationBoundary()`                                              | Drains pending completion events after every MCP tool callback.                                       |
| `src/server/tool-output.ts`                        | `appendToolEvents()`                                                             | Appends queued `agent_finished` strings to model-facing tool content.                                 |
| `src/server/mcp-server.ts`                         | `drainPendingEvents` wiring                                                      | Connects global MCP tool responses to the process-level subagent event queue.                         |
| `src/index.ts`                                     | process-level `ChatGptSubagentModule`                                            | Production singleton shared across stateless MCP requests.                                            |
| `scripts/chatgpt-browser.mjs`                      | managed Chrome helper                                                            | Dedicated authenticated Chrome/profile setup and lifecycle.                                           |
| `test/chatgpt-subagent.test.ts`                    | lifecycle tests                                                                  | Capacity, stale UI/server completion, watcher behavior, recovery, event uniqueness, and idle cleanup. |
| `test/chatgpt-subagent-browser.test.ts`            | browser-adapter tests                                                            | Conversation parsing, transient URL behavior, overlays, activity, and final-node matching.            |
| `test/mcp-integration.test.ts`                     | MCP integration tests                                                            | Event injection exactly once, subagent output, staggering, concurrency, and cross-request sharing.    |
| `test/live/chatgpt-fixture-live.test.ts`           | stable saved-conversation live fixture                                            | Strict real-service network/Markdown/reload compatibility without generation.                         |
| `test/live/subagent-live.test.ts`                  | two-turn public-MCP live canary                                                   | Minimal startup, Turn 1, Turn 2, and persistent-context proof with diagnostic artifact.                |

## Operational Risks

- ChatGPT DOM selectors and private endpoints are not public stable APIs. Keep those assumptions isolated in `chatgpt-subagent-browser.ts` where possible.
- `stream_status` is intentionally treated as a best available server-side lifecycle signal, not as a reason to remove the network or UI fallbacks.
- The attached browser must already be authenticated. The proven production path is a normal headed dedicated Chrome profile exposed over CDP.
- Request cancellation after a prompt was already sent cannot unsend that ChatGPT turn.
- A full MCP process restart loses process-local agent/turn/conversation bindings and pending completion events.
- The underlying ChatGPT conversation may continue to exist even when local runtime state is gone.

## Related

- [[pages/Project Overview]]
- [[pages/Architecture Map]]
- [[pages/MCP Tool Surface]]
- [[pages/Configuration and Startup]]
- [[pages/Open Questions and Risks]]
