---
summary: "Sanitized 2026-08-20 live probe of ChatGPT Web CDP turn transport, completion events, and conversation-history rate-limit behavior."
---

# ChatGPT Web CDP Transport Probe, 2026-08-20

- Role: direct live inspection of one authenticated ChatGPT Web generation through Playwright and raw Chrome DevTools Protocol network/WebSocket events, plus a browser DOM `MutationObserver`.
- Reliability: point-in-time evidence for private ChatGPT Web behavior. Endpoint names, WebSocket schemas, topic structure, DOM selectors, and event ordering may change without notice.
- Observed: `/backend-api/f/conversation` handed the turn to a WebSocket topic; that topic carried assistant deltas and explicit completion items including `message_stream_complete`, `[DONE]`, and a turn-level `done`. The broader `conversations` topic emitted `conversation-turn-complete`.
- Rate-limit evidence: the exploratory recovery reload caused `/backend-api/conversations` HTTP 429 responses and the visible conversation-history modal while sampled `stream_status` responses remained 200. Follow-up live canaries after removing application-level polling/reloads showed that ChatGPT's own frontend script also issues `stream_status` and history requests during normal first-turn navigation; one history request returned 429 while the application itself issued neither request class.
- Secret handling: raw WebSocket frames contained authenticated tokens and account/conversation identifiers during the live probe. Those values are not stored in the wiki; only sanitized protocol shapes and behavior are retained.
