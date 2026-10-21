---
summary: "Message identity, activity versus completion, nondestructive history checks, and uncertain recovery."
paths:
  - src/tools/delegation/subagents.ts
  - src/tools/delegation/response-observer.ts
  - src/tools/delegation/turn-protocol.ts
  - src/tools/delegation/chatgpt-browser.ts
---

# Subagent Completion

## Normal completion

[response-observer.ts](../../../src/tools/delegation/response-observer.ts) captures the outgoing user-message ID and `parent_message_id` once at submission. Composer serialization can rewrite URLs, backticks and separators; prompt text and local turn counts are unsafe correlation keys. Streaming stays bound to the submitted user ID.

[turn-protocol.ts](../../../src/tools/delegation/turn-protocol.ts) distinguishes final assistant answers from tool calls and partial text. HTTP and WebSocket trackers race; first valid completion wins. DOM text and an idle-looking composer are not completion authority.

Fresh completed MCP tool messages also supply [parent-link evidence](../agent-context.md#observed-parent-links). Tool deltas belong to their own message and must not mutate the preceding assistant answer. Duplicate transport observations are expected; identity binding is idempotent.

After binding, observed messages, nonempty output deltas and execution-state changes refresh activity. Heartbeats, safety metadata and unchanged state do not: a stalled turn can keep its connection alive, so counting transport traffic would mask inactivity and postpone recovery. [CDP Transport](./chatgpt-cdp-transport.md) owns acquisition and probes.

## Bounded recovery

[subagents.ts](../../../src/tools/delegation/subagents.ts) separates two decisions:

- Three minutes without observed activity: check saved history, repeating at that interval while quiet. Keep the observer and original tab alive; missing/pending history is not failure. The check does not reset the activity clock.
- Page/observer failure or thirty minutes without activity: detach observation and attempt bounded recovery once, if saved identity exists. Check current history, then one replacement tab if necessary. Never resend the prompt.

`readConversationPayload` in [chatgpt-browser.ts](../../../src/tools/delegation/chatgpt-browser.ts) reads current `/api/auth/session` inside the existing page and uses its bearer token for `/backend-api/conversations/<id>`. The token stays inside the browser. Cookie-only history requests can fail despite a logged-in tab; unavailable history remains an ordinary pending result. This path differs from the older endpoint/auth approach in the [historical recovery probe](../../log.md#2026-08-15--direct-conversation-recovery-fetch-was-abandoned).

History recovery accepts the latest completed assistant reply after the submitted user message on the active branch, including manual follow-ups. An unanswered latest user message keeps the turn pending. Editing/resending can replace the original user ID; then the captured parent anchors the search before the edited prompt. A fresh chat's `client-created-root` parent means the start of its history. Forks have a real parent even when their first POST lacks a conversation ID. Unknown/missing boundaries cannot recover an answer; inherited and abandoned-branch replies are excluded. Message IDs establish order, so identical answer text remains valid.

Unconfirmed recovery fails locally and marks the agent `uncertain`; upstream work may still be running. Reuse returns `AGENT_BUSY`, and the identity still consumes [capacity](./browser-chatgpt-subagents.md#identity-and-lifetime).

## Results and events

Collection runs without result polling. Polling only waits on local settlement. Settled results have bounded retention; active turns are excluded. Expiry and process restart yield `UNKNOWN_TURN` even when saved conversation identity remains. Retention values and settlement rules live in `subagents.ts`.

Successful settlement queues one `agent_finished` notice for the launching identity. Initial `existing_agent` notices identify saved conversations, not restored results. [Registration Boundary](../mcp-tool-registration-boundary.md) drains notices once.

Validation routes: [Testing](./testing.md).
