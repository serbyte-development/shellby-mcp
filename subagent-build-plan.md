# Subagent build plan

Draft: top-level design. Names and internal boundaries may evolve.

Reorganize the existing implementation through renaming, moving, and consolidating code. Preserve current behavior and MCP tool contracts, except for the explicit startup-completion guarantee below; change implementation where needed to support the new organization.

1. **One deep module:** use a `createSubagents()` factory with private instance state.
2. **Tool entry points:** `subagent_run` calls `runAgents(requests)`; `subagent_result` calls `getAgentResponses(turnIds)`.
3. **Core workflows:** `sendAgentMessage` chooses `startNewConversation` or `submitFollowUpTurn` internally; `getAgentResponse` retrieves a turn's result. Agent IDs are scoped to the calling `AgentIdentity`; response retrieval uses `turn_id`.
4. **Private implementation:** the module owns creation/follow-up selection, scheduling and delays, browser/CDP work, response tracking, persistence, recovery, and cleanup. Related state and decisions stay together.
5. **Preserve integration:** retain shutdown, completion notices, diagnostics, and existing error semantics. Validate the reorganization with the relevant existing tests.

Recovery-policy changes and durable turn results across MCP restarts are separate follow-up work. This plan does not introduce those behavior changes.

## Truthful functions

Design from readable workflows downward. A function's name and contract must accurately describe its responsibility, required inputs/preconditions, side effects, and result. Pure functions and functions with deliberate side effects can both follow this rule.

For example, `submitMessageToBrowser(preparedConversation, message)` uses one defined procedure to submit the message. It relies on conversation preparation already being complete and has no responsibility for agent identity, creation versus follow-up, scheduling, persistence, or recovery. Both conversation paths reuse it through `submitTurn`, which owns the surrounding coordination, including installing observation before submission.

- Keep shared behavior in one implementation with one owner.
- Report what actually happened, including failure or uncertainty when confirmation is unavailable. External browser behavior can fail even when the procedure is consistent.
- Keep diagnostics and tests aligned with the operation's contract. A submission problem has an obvious first place to investigate: `submitMessageToBrowser`.
- Extract functions around meaningful responsibilities; several independently testable functions can share a deep module.

## Core operation map (draft)

Top-level workflows coordinate a few meaningful operations. Several operations can belong to the same deep module; each boundary must own a complete responsibility and be independently testable.

| Workflow | High-level operations |
| --- | --- |
| `runAgents` | Schedule each `sendAgentMessage` using the existing delays and collect every submission outcome. |
| `sendAgentMessage` | `prepareAgentForSubmission` → choose `startNewConversation` or `submitFollowUpTurn` from the agent's saved conversation identity. |
| `startNewConversation` | `prepareConversationTab(new or source)` → `submitTurn(initial prompt)` → `waitForConversationId` → `saveAgentConversation` → return startup success. |
| `submitFollowUpTurn` | `prepareConversationTab(saved)` → `submitTurn(follow-up prompt)` |
| `getAgentResponse` | Look up the caller's retained turn and read or await its result, preserving current wait and cancellation behavior. Keep this operation directly in the same owner as turn execution. |

`prepareAgentForSubmission` loads or creates the local agent record, checks capacity and availability, and reserves the agent before browser work. `sendAgentMessage` owns rollback on an unsent failure. After submission, the reservation covers both the active turn and unfinished startup identity binding. Returning a turn ID alone does not release it.

| Operation | What its implementation hides |
| --- | --- |
| `prepareConversationTab` | Coordinate loading, optional forking, and final readiness. Return the actual target tab without sending a prompt; close unused intermediate tabs and clean up owned tabs on failure. |
| `loadPageTab` | Browser connection, background tab creation/reuse, navigation to the requested conversation or project, and authentication. Reuse an already suitable tab. |
| `forkConversation` | Fork the loaded source and return the resulting conversation tab, whether ChatGPT opens a new tab or reuses the source tab. |
| `waitForConversationReady` | Verify the intended tab, wait for its composer, and preserve existing navigation/fork settling checks. New/fork tabs may still have temporary identity; durable identity is resolved after submission. |
| `submitTurn` | Submission pacing, response/identity observation installed before Send, prompt entry, one Send attempt, message correlation, turn registration, and starting background response collection. Both startup and follow-ups use it. |
| `waitForConversationId` | Resolve the durable ID from the submitted turn's captured traffic or its target tab's URL. Share draft-ID decoding/filtering across both sources; ignore `WEB:`/`local-chatgpt:` placeholders and the fork source's ID. Preserve early identity events and use a bounded wait. |
| `saveAgentConversation` | Bind the resolved ID/URL to the caller's agent and persist that mapping through the existing store. Own this state update in one place. |
| `collectTurnResponse` | Background activity tracking, response completion, existing recovery decisions, result retention, completion notices, and resource release. Runs independently of result polling. |
| `recoverTurn` | Existing history checks and bounded browser recovery, matched to the submitted message. Never resubmits the prompt. |

Tab preparation follows this flow (cleanup omitted from the sketch):

```ts
let tab = await loadPageTab(target)
if (needsFork) tab = await forkConversation(tab)
await waitForConversationReady(tab)
return tab
```

`needsFork` is derived only for a new agent with a requested source. Existing agents resume their saved conversation. Fork once, then prepare the returned tab; no recursive creation or second fork.

## Conversation identity and startup completion

`startNewConversation` owns this sequence for both fresh chats and forks. Fresh chats may pass through `WEB:`; forks may pass through `local-chatgpt:` and then `WEB:` before acquiring a durable ID. These are temporary browser identities, never saved agent mappings.

- **Submission observed:** register the turn as running and collect its response immediately. A durable conversation ID may still be pending.
- **Identity resolved:** `waitForConversationId` supplies the durable ID; `saveAgentConversation` binds and saves it. Only then does new-conversation startup report success.
- **Response settled early:** retain its actual result while finishing identity capture. Do not change a completed turn back to running or release the agent for another startup before identity binding has been resolved.

After Send, an identity timeout or persistence failure must preserve the submitted turn, its ID, and ongoing response/identity tracking. Report the incomplete startup with that turn ID; do not apply unsent rollback, discard the live tab, or resend. A late stable ID must still be saved.

Current code captures identity through `onConversationId`, page URL checks, and completion callbacks. Centralizing that responsibility reuses existing behavior; waiting for the saved mapping before startup success strengthens the current return contract and needs explicit regression coverage. Test delayed IDs for fresh/forked chats, early response completion, and post-submit failure without a second Send.

Submission, collection, recovery, and result retrieval share one owner of agent/turn state. Tab preparation owns its browser helpers, which can be tested independently without each becoming a separate module. Response decoding can retain its own protocol tests.

Reuse and regroup the existing `beginAgentOperation`, browser `startConversation`, `submitAgentTurn`, `waitForTurnResponse`, and `pollSubagent` implementations. Preserve first-turn instructions, saved-conversation persistence, failure cleanup, and shutdown behavior while moving them.
