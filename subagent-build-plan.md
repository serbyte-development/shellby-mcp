# Subagent build plan

Draft: top-level design. Names and internal boundaries may evolve.

Reorganize the existing implementation through renaming, moving, and consolidating code. Preserve current behavior and MCP tool contracts, if necessary change code and implementation to support the new organization.

1. **One deep module:** use a `createSubagents()` factory with private instance state.
2. **Tool entry points:** `subagent_run` calls `runAgents(requests)`; `subagent_result` calls `getAgentResponses(turnIds)`.
3. **Core workflows:** `sendAgentMessage` chooses `startNewConversation` or `submitFollowUpTurn` internally based on tool args; `getAgentResponse` retrieves a turn's result. Agent IDs are scoped to the calling `AgentIdentity`; response retrieval uses `turn_id`.
4. **Private implementation:** the module owns creation/follow-up selection, scheduling and delays, browser/CDP work, response tracking, persistence, recovery, and cleanup. Related state and decisions stay together.
5. **Preserve integration:** The current implementation is already working, but is just messy and not very well organized. Make changes where appropriate, but try not to break anything.

## Truthful functions

Design from readable workflows downward. A function's name and contract must accurately describe its responsibility, required inputs/preconditions, side effects, and result. Pure functions and functions with deliberate side effects can both follow this rule. Use comments where necessary to clarify the intent and behavior of the function.

For example, `submitMessageToBrowser(preparedConversation, message)` uses one defined procedure to submit the message. It relies on conversation preparation already being complete and has no responsibility for agent identity, creation versus follow-up, scheduling, persistence, or recovery. Both conversation paths can reuse it through `submitTurn`, which owns the surrounding coordination, including installing observation before submission.

- Keep shared behavior in one implementation with one owner.
- Report what actually happened, including failure or uncertainty when confirmation is unavailable. External browser behavior can fail even when the procedure is consistent.
- Keep diagnostics and tests aligned with the operation's contract. A submission problem has an obvious first place to investigate: `submitMessageToBrowser`.
- Extract functions around meaningful responsibilities; several independently testable functions can share a deep module.

## Core operation map (draft)

Top-level workflows coordinate a few meaningful operations. Several operations can belong to the same deep module; each boundary should own a complete responsibility. independently testability is a nice-to-have, not a requirement. but very nice to have.

| Workflow | High-level operations |
| --- | --- |
| `runAgents` | Schedule each `sendAgentMessage` using the existing delays and collect every submission outcome. |
| `sendAgentMessage` | `prepareAgentForSubmission` → choose `startNewConversation` or `submitFollowUpTurn` from the agent's saved conversation identity. |
| `startNewConversation` | `prepareConversationTab(new or source)` → `submitTurn(initial prompt)` |
| `submitFollowUpTurn` | `prepareConversationTab(saved)` → `submitTurn(follow-up prompt)` |
| `getAgentResponse` | Look up the caller's retained turn and read or await its result, preserving current wait and cancellation behavior. Keep this operation directly in the same owner as turn execution. |

`prepareAgentForSubmission` loads or creates the local agent record, checks capacity and availability, and reserves the agent before browser work. `sendAgentMessage` owns rollback on an unsent failure. Once submitted, the reservation remains attached to the turn until settlement; returning a turn ID does not release it.

| Operation | What its implementation hides |
| --- | --- |
| `prepareConversationTab` | Coordinate loading, optional forking, and final readiness. Return the actual target tab without sending a prompt; close unused intermediate tabs and clean up owned tabs on failure. |
| `loadPageTab` | Choose direct opening or forking from the requested target and return the resulting tab. |
| `openConversationTab` | Browser connection, background tab creation/reuse, navigation to the requested conversation or project, and authentication. Reuse an already suitable tab. |
| `forkConversation` | Open the requested source through `openConversationTab`, fork it, and return the resulting conversation tab, whether ChatGPT opens a new tab or reuses the source tab. |
| `waitForConversationReady` | Verify the expected conversation, wait for its composer, and preserve existing navigation/fork settling checks. |
| `submitTurn` | Submission pacing, observer installation before Send, prompt entry, one Send attempt, message correlation, turn registration, and starting background response collection. Both startup and follow-ups use it. |
| `collectTurnResponse` | Background activity tracking, response completion, existing recovery decisions, result retention, completion notices, and resource release. Runs independently of result polling. |
| `recoverTurn` | Existing history checks and bounded browser recovery, matched to the submitted message. Never resubmits the prompt. |

Tab preparation follows this flow (cleanup omitted from the sketch):

```ts
type ConversationTarget =
  | { kind: "new"; sourceConversationId?: string }
  | { kind: "saved"; conversationId: string }

async function prepareConversationTab(target: ConversationTarget) {
  const tab = await loadPageTab(target)
  await waitForConversationReady(tab)
  return tab
}

async function loadPageTab(target: ConversationTarget) {
  if (target.kind === "new" && target.sourceConversationId) {
    return forkConversation(target.sourceConversationId)
  }

  return openConversationTab(target)
}
```

`sourceConversationId` requests a fork for a new agent; a saved target resumes its own `conversationId`. Forking uses `openConversationTab` to load its source, so it does not recurse through `loadPageTab`.

Submission, collection, recovery, and result retrieval share one owner of agent/turn state. Tab preparation owns its browser helpers, which can be tested independently without each becoming a separate module. Response decoding can retain its own protocol tests.

Reuse and regroup the existing `beginAgentOperation`, browser `startConversation`, `submitAgentTurn`, `waitForTurnResponse`, and `pollSubagent` implementations. Preserve first-turn instructions, saved-conversation persistence, failure cleanup, and shutdown behavior while moving them.
