# ChatGPT CDP Transport

Verified 2026-08-20 against the exploratory authenticated CDP probe plus live subagent canaries.

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

| Signal                                                   | Observed value                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Network.webSocketFrameReceived`                         | Full turn-topic stream, assistant deltas, markers, and explicit completion events.                                                                             |
| `Network.streamResourceContent` + `Network.dataReceived` | Successfully streamed the initial `/backend-api/f/conversation` response, including the handoff and terminal `[DONE]`, but not the later WebSocket generation. |
| Playwright `response` / `requestfinished`                | Useful for normal HTTP lifecycle visibility, but insufficient alone after stream handoff.                                                                      |

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

The exploratory evidence therefore identified conversation-history/bootstrap traffic from recovery navigation as the direct observed trigger in that probe. Later live canaries after removing application-level completion polling and reloads still observed ChatGPT's own frontend bundle issuing a `stream_status` request and conversation-history requests during normal first-turn navigation. CDP initiator stacks attributed those requests to a ChatGPT CDN script, not Unhinged Agent. When the account was already near the history limit, one of those normal frontend `/backend-api/conversations?...` requests also returned 429 and caused the rate-limit gate to block the next turn.

This means Unhinged Agent can remove its own avoidable polling/reload traffic, but cannot guarantee zero upstream history traffic while driving the normal ChatGPT Web UI. The history limit is distinct from prompt submission itself.

## Current Implementation

The production completion path now follows the observed transport:

1. `Network.webSocketFrameReceived` is the primary passive structured stream.
2. The topic binds only after the exact submitted prompt is observed, then v1 assistant deltas reconstruct source text.
3. A final assistant node plus an explicit stream-completion signal resolves the structured path after a short settle grace.
4. A MutationObserver provides the only normal secondary completion path.
5. Normal completion and `subagent_result` issue no application-level `stream_status` polling and perform no refresh.
6. One catastrophic recovery may navigate a fresh tab to the saved conversation once; the submitted prompt is never retried.

The WebSocket schema remains a private implementation detail, so the DOM observer and live compatibility test remain important safeguards (`src/tools/subagent/chatgpt-subagent-browser.ts`, `test/live/subagent-live.test.ts`).

## Related

- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [Subagent Completion and Recovery](./Subagent%20Completion%20and%20Recovery.md)
- [`subagent_run` / `subagent_result`](./tools/subagent.md)
- [Build and Test](./Build%20and%20Test.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
