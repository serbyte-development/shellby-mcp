---
summary: "Choose lifecycle, CDP or authenticated tests; reuse conversations and preserve live evidence."
paths:
  - package.json
  - test/tools/delegation/subagent-lifecycle.test.ts
  - test/tools/delegation/subagents.test.ts
  - test/live/subagent-live.test.ts
  - test/live/subagent-live-harness.ts
  - test/live/subagent-live-harness.test.ts
  - test/live/delegation-cdp.test.ts
---

# Subagent Testing

Choose evidence by failure boundary:

| Question | Evidence |
| --- | --- |
| State ownership, cancellation, late completion, retention, capacity | Public API tests: [lifecycle](../../../test/tools/delegation/subagent-lifecycle.test.ts), [submission/restoration](../../../test/tools/delegation/subagents.test.ts), [capacity](../../../test/tools/delegation/delegated-agent-limit.test.ts) |
| Request correlation and private payload decoding | [Observer](../../../test/tools/delegation/response-observer.test.ts) and [protocol](../../../test/tools/delegation/turn-protocol.test.ts) fixtures |
| Actual CDP/tab/stream mechanics | `npm run test:cdp`: [disposable Chrome with local fixtures](../../../test/live/delegation-cdp.test.ts); no authenticated ChatGPT |
| Current authenticated UI, transport and saved context | [Live lifecycle](../../../test/live/subagent-live.test.ts) through the MCP boundary |

## Authenticated lifecycle

`npm run test:live:subagent` reuses the ignored saved conversation fixture; missing identity fails rather than silently creating a chat. Requires logged-in managed Chrome without competing delegation. The [harness](../../../test/live/subagent-live-harness.ts) uses disposable local state and an isolated MCP server, closes owned tabs, and preserves saved conversations. It never restarts production MCP/PM2.

The sequence checks a real 4.5-minute tool wait, busy rejection, client reconnection, same-tab follow-up, tab reopening, and restart with only a saved URL. Assertions verify prior context, result isolation and one submission per step. A long wall-clock duration alone is insufficient: reopened authenticated history must prove the timer invocation and result.

The harness also compares saved final-answer time with the first completed MCP poll, accounting for server-clock uncertainty. Generation duration alone cannot establish result-delivery latency. Timing extraction/calibration has [focused tests](../../../test/live/subagent-live-harness.test.ts); thresholds remain in the harness.

`test:live:subagent:fork` adds a new branch, then checks its follow-up, reopening, restart and isolation from the source. `test:live:subagent:fresh` creates a source and fork. Reserve these modes for startup/fork changes: repeated conversation creation has triggered account limits in real use.

Stage, submission and polling evidence lands in ignored `test/live/artifacts/subagent-live-last.json`. Expected `AGENT_BUSY` and post-restart `UNKNOWN_TURN` checks are intentional. Artifacts may contain prompts/answers; follow [Secret Handling](../operations/secret-handling.md).

Live success validates that run, not future private-API compatibility or production PM2/TCC recovery. Unproven recovery and identity exhaustion remain [runtime limitations](./subagent-completion.md#bounded-recovery). Investigate transport drift with [CDP probes](./chatgpt-cdp-transport.md); general checks live in [Build and Test](../operations/build-and-test.md).
