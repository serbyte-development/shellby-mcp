# ChatGPT CDP Transport

Verified 2026-08-20 against one live authenticated ChatGPT turn observed through Playwright and raw Chrome DevTools Protocol (CDP).

## What This Is

Point-in-time documentation of the upstream ChatGPT Web transport and browser signals observed while a subagent turn was generated. These are private ChatGPT implementation details, not stable APIs. Current Unhinged Agent completion behavior remains canonical in [Subagent Completion and Recovery](./Subagent%20Completion%20and%20Recovery.md).

## Observed Turn Transport

A submitted turn did not stay on one HTTP response. The browser first posted to `/backend-api/f/conversation`; that response contained a handoff describing a per-turn topic and ways to resume it. The actual assistant generation then continued over ChatGPT's authenticated WebSocket connection.

The WebSocket subscribed to a topic shaped like `conversation-turn-<turn-id>` and delivered ordered stream items containing the conversation ID, turn ID, parent stream-item relationship, and encoded SSE-style payload. The stream included the assistant message creation and subsequent text patches, preserving source text such as Markdown and fenced code.

Observed completion-related items included:

- `final_channel_token` and `last_token` message markers;
- `message_stream_complete`;
- `data: [DONE]`;
- a turn-topic payload with `type: "done"` and the conversation/turn identity;
- a separate `conversation-turn-complete` event on ChatGPT's broader `conversations` WebSocket topic.

This explains the historical unreliability of treating Playwright `page.on("response")` as the sole completion source: the initial HTTP response can finish after handing the live turn to WebSocket, so later assistant deltas are not additional Playwright HTTP `Response` events (`src/tools/subagent/chatgpt-subagent-browser.ts`, `wiki/log.md`).

## CDP Signal Coverage

Raw CDP exposed several useful passive signals without issuing additional ChatGPT requests:

| Signal | Observed value |
| --- | --- |
| `Network.webSocketFrameReceived` | Full turn-topic stream, assistant deltas, markers, and explicit completion events. |
| `Network.streamResourceContent` + `Network.dataReceived` | Successfully streamed the initial `/backend-api/f/conversation` response, including the handoff and terminal `[DONE]`, but not the later WebSocket generation. |
| Playwright `response` / `requestfinished` | Useful for normal HTTP lifecycle visibility, but insufficient alone after stream handoff. |

The WebSocket stream was the richest signal in the probe because it contained both exact assistant text and explicit lifecycle completion.

## DOM Observation

A page-context `MutationObserver` also worked as a passive signal. During the same turn it observed:

1. the temporary `Thinking` assistant state;
2. replacement with the visible assistant response;
3. progressive response text changes as tokens rendered;
4. the generating/stop control eventually disappearing.

The DOM therefore provides a useful independent fallback and activity signal, but rendered text is semantically lossy compared with the structured stream. In the probe, the fenced code block remained understandable but its rendered text did not preserve the exact source Markdown representation.

## Conversation-History Rate Limit

The same probe captured the exact rate-limit path behind ChatGPT's conversation-history modal. Normal `stream_status` checks returned HTTP 200 throughout the sampled turn, including the final `COMPLETE` response. After completion, the current recovery path reloaded the managed conversation page to recover canonical conversation JSON (`src/tools/subagent/chatgpt-subagent.ts`, `src/tools/subagent/chatgpt-subagent-browser.ts`).

That reload caused ChatGPT to issue a fresh burst of page/bootstrap requests, including multiple conversation/sidebar history requests. Two `/backend-api/conversations?...` requests then returned HTTP 429 with `{"detail":"Too many requests"}`. The managed tab subsequently displayed `[data-testid="modal-conversation-history-rate-limit"]` with ChatGPT's "Too many requests" conversation-access warning.

The live evidence therefore points to conversation-history/bootstrap traffic from recovery navigation as the direct observed trigger in this probe. One-second `stream_status` polling is still avoidable account traffic, but it was not the endpoint that returned 429 in this capture.

## Implementation Direction

This is observed upstream behavior, not yet the production completion algorithm. The promising direction is:

1. parse `Network.webSocketFrameReceived` turn-topic messages as the primary passive structured stream;
2. bind frames to the submitted turn using conversation/turn identity and reconstruct the final assistant node/text;
3. use explicit WebSocket completion events to drive `completeTurn()` without normal `stream_status` polling;
4. retain MutationObserver/UI signals as an independent fallback;
5. keep any server polling as a sparse failure watchdog rather than the normal lifecycle;
6. avoid successful-turn recovery reloads when the passive stream already supplied the final answer.

No production change should assume the observed private WebSocket schema is stable without a live compatibility test and a fallback path.

## Related

- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [Subagent Completion and Recovery](./Subagent%20Completion%20and%20Recovery.md)
- [`subagent_run` / `subagent_result`](./tools/subagent.md)
- [Build and Test](./Build%20and%20Test.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
