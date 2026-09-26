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

[response-observer.ts](../../../src/tools/delegation/response-observer.ts) binds traffic to the outgoing user-message ID. Composer serialization can rewrite URLs, backticks and separators; prompt text and local turn counts are unsafe correlation keys. Streaming and history recovery use the same captured ID, including inherited fork histories.

[turn-protocol.ts](../../../src/tools/delegation/turn-protocol.ts) distinguishes final assistant answers from tool calls and partial text. HTTP and WebSocket trackers race; first valid completion wins. DOM text and an idle-looking composer are not completion authority.

After binding, any nonempty turn stream traffic refreshes activity, including heartbeats and safety updates without new text or a new status label. Pre-binding traffic does not. [CDP Transport](./chatgpt-cdp-transport.md) owns acquisition and probes.

## Bounded recovery

[subagents.ts](../../../src/tools/delegation/subagents.ts) separates two decisions:

- Three minutes without observed activity: check saved history once. Keep the observer and original tab alive; missing/pending history is not failure. The check does not reset the activity clock.
- Page/observer failure or thirty minutes without activity: detach observation and attempt bounded recovery once, if saved identity exists. Check current history, then one replacement tab if necessary. Never resend the prompt.

Unconfirmed recovery fails locally and marks the agent `uncertain`; upstream work may still be running. Reuse returns `AGENT_BUSY`, and the identity still consumes [capacity](./browser-chatgpt-subagents.md#identity-and-lifetime).

## Results and events

Collection runs without result polling. Polling only waits on local settlement. Settled results have bounded retention; active turns are excluded. Expiry and process restart yield `UNKNOWN_TURN` even when saved conversation identity remains. Retention values and settlement rules live in `subagents.ts`.

Successful settlement queues one `agent_finished` notice for the launching identity. Initial `existing_agent` notices identify saved conversations, not restored results. [Registration Boundary](../mcp-tool-registration-boundary.md) drains notices once.

Validation routes: [Testing](./testing.md).
