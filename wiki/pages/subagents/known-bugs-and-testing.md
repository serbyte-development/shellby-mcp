---
summary: "Live testing gaps and the plan to maximize coverage with a small reusable set of conversations."
paths:
  - test/live/subagent-live.test.ts
  - test/live/delegation-cdp.test.ts
---

# Known Bugs and Testing

## Current gaps

- Frequent creation of new ChatGPT conversations causes rate limits, as reported by the operator. Live tests need to conserve conversations.
- The existing [live subagent test](../../../test/live/subagent-live.test.ts) creates a temporary conversation and checks two turns. It does not yet provide a reusable set of saved conversations across runs.
- [Isolated CDP tests](../../../test/live/delegation-cdp.test.ts) exercise real Chrome against local fixtures. They establish browser mechanics, but cannot establish compatibility with the current authenticated ChatGPT UI and private transport.

## Planned live testing

Agreed direction, 2026-09-25; not implemented yet. Use the minimum practical set of persistent test conversations, retain their conversation IDs, and reuse them across runs. Each conversation should exercise as much of the lifecycle as possible in one sequence:

1. Submit a prompt; verify submission, response capture, and completed result.
2. Follow up in the same conversation; verify context retained from the preceding turn.
3. Close and reopen the managed tab; continue using the saved conversation identity.
4. Restart the isolated test harness; verify continuation when local turn counters or cached results are missing.

Give every step explicit assertions and diagnostic evidence so failures identify the last successful stage. Preserve saved conversations when cleaning up test tabs and processes. Reserve new conversation creation and forking for deliberate, infrequent scenarios that specifically require them; reuse the resulting conversations for subsequent checks.

Exact conversation count and scenario ordering remain to be designed. Optimize coverage per conversation and per submitted turn. The reusable suite should complement deterministic tests and make actual ChatGPT behavior observable without repeatedly creating chats.

See [Build and Test](../operations/build-and-test.md) for current commands and validation boundaries, and [CDP diagnostics](./chatgpt-cdp-transport.md) for transport investigation.
