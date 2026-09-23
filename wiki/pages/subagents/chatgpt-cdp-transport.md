---
summary: "Private HTTP/WebSocket acquisition and diagnostic probes for ChatGPT transport drift."
paths:
  - src/tools/delegation/response-observer.ts
  - src/tools/delegation/turn-protocol.ts
  - scripts/chatgpt/cdp-probe.mjs
  - scripts/chatgpt/summarize-cdp-probe.mjs
---

# ChatGPT CDP Transport

Private transport compatibility is empirical. Historical captures establish observed behavior, not a stable upstream API or current availability. [Completion](./subagent-completion.md) owns binding, liveness, settlement, and recovery policy.

[response-observer.ts](../../../src/tools/delegation/response-observer.ts) watches POST `/backend-api/f/conversation` through `Network.streamResourceContent`/`Network.dataReceived`, with a `Network.getResponseBody` fallback at loading completion. `Network.webSocketFrameReceived` feeds `conversation-turn-*` envelopes into the same parser implementation. Streams preserve structured Markdown and assistant patches; normal completion needs no DOM scraping or `stream_status` polling.

Historical long-thinking traffic included `safety_review_update` and SSE comment pings without assistant text. Keep transport liveness separate from coarse activity labels. Earlier probes also associated extra history/reload traffic with conversation-history rate limits; bounded recovery is deliberate. ChatGPT's frontend may still issue its own requests.

## Investigating drift

[cdp-probe.mjs](../../../scripts/chatgpt/cdp-probe.mjs) attaches to configured authenticated Chrome without launching, closing, reloading, or navigating it. Start before reproducing:

```sh
npm run probe:chatgpt-cdp -- --capture-bodies
```

Stop with Ctrl-C. Default traces go under ignored `test/live/artifacts/`. Summarize one trace:

```sh
npm run probe:chatgpt-cdp:summary -- test/live/artifacts/<trace>.jsonl
```

[summarize-cdp-probe.mjs](../../../scripts/chatgpt/summarize-cdp-probe.mjs) reports event counts, candidate traffic gaps, and captured DOM streaming states. Determine whether Chrome stopped receiving data or Shellby ignored arriving data before changing the parser.

Header/query redaction does not sanitize conversation bodies. Keep traces private; ingest only deliberately sanitized evidence. Historical example: [2026-08-20 probe](../../raw/chatgpt-cdp-transport-probe-2026-08-20.md). Validation: [protocol tests](../../../test/tools/delegation/turn-protocol.test.ts) and the separately enabled [live canary](../operations/build-and-test.md).
