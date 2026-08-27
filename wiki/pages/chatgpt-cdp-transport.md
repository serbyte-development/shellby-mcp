---
summary: "Observed private ChatGPT Web turn transport used by Shellby's raw-CDP subagent completion tracker."
paths:
  - src/tools/subagent/chatgpt-subagent-observer.ts
  - src/tools/subagent/chatgpt-subagent-protocol.ts
  - src/tools/subagent/chatgpt-subagent.ts
---

# ChatGPT CDP Transport

## What This Is

This page records the private ChatGPT Web transport behavior Shellby's subagent completion tracker currently relies on.

## Observed Transport

Submitting in ChatGPT Web starts through `/backend-api/f/conversation`, then generation continues on ChatGPT's authenticated WebSocket. Turn traffic is published on topics shaped like `conversation-turn-<turn-id>` and contains encoded SSE-style stream items.

Observed stream data includes the submitted user message, assistant/tool messages, incremental v1 patches, `conversation_id`, `message_stream_complete`, and explicit turn completion. Source Markdown and fenced code are preserved in the structured stream.

Raw CDP also proved that `/backend-api/f/conversation` can be consumed incrementally with `Network.streamResourceContent` plus `Network.dataReceived`. The production tracker accepts that HTTP path because current ChatGPT/project sessions may choose either transport.

## Production Choice

Subagents use one CDP observer after submission. It feeds the same tracker from either HTTP SSE or WebSocket turn data:

```text
browser UI -> submit prompt
raw CDP HTTP/WS -> bind exact prompt -> reconstruct final assistant -> complete local turn
```

The DOM remains necessary for composer interaction only. It is not a completion or recovery source; the one-shot catastrophic recovery uses saved conversation JSON or another CDP observation.

## Rate-limit Finding

Earlier probes showed that extra conversation-history/reload traffic could contribute to ChatGPT's conversation-history rate limit. The runtime performs no normal conversation-history fetch, `stream_status` request, or reload. It permits one conversation navigation/history response only after a submitted turn fails or reaches 30 minutes without progress. The existing UI modal detection, cooldown, inter-turn delay, interaction delays, and pre-submit grace remain.

ChatGPT's own frontend may still issue its own bootstrap/history traffic; the runtime cannot prevent upstream client behavior.

## Private Protocol Risk

The HTTP/turn-WebSocket schemas are private and can change. Deterministic protocol tests and the manual two-turn live canary are the compatibility boundary. A schema change gets one bounded recovery attempt, then fails the turn clearly.

## Related

- [Browser ChatGPT Subagents](./browser-chatgpt-subagents.md)
- [Subagent Completion](./subagent-completion.md)
- [Build and Test](./build-and-test.md)
