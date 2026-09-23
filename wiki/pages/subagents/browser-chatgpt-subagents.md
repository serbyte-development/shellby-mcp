---
summary: "Delegation ownership, capacity, persistence, page restoration, and at-most-once submission."
paths:
  - src/tools/delegation/chatgpt-service.ts
  - src/tools/delegation/lifecycle.ts
  - src/tools/delegation/chatgpt-browser.ts
  - src/tools/delegation/store.ts
  - src/config.ts
  - src/public-config.cts
---

# Browser ChatGPT Subagents

Public adapters: [subagent contract](../tools/subagent.md), [clones](../tools/clones.md). Caller identity: [Agent Context](../agent-context.md).

| Owner | Responsibility |
| --- | --- |
| [chatgpt-service.ts](../../../src/tools/delegation/chatgpt-service.ts) | Attach to Chrome; orchestrate pages, submission, observation, pacing, recovery |
| [lifecycle.ts](../../../src/tools/delegation/lifecycle.ts) | Agent/turn mutations, conversation identity, admission/locks, settlement/events, result retention, persistence, idle decisions |
| [chatgpt-browser.ts](../../../src/tools/delegation/chatgpt-browser.ts) | Background page creation, composer interaction, branching, navigation/history capture |
| [store.ts](../../../src/tools/delegation/store.ts) | SQLite mappings and explicit available/unavailable state |

## State and admission

Each canonical `AgentIdentity` owns agent IDs, active-operation locks, turn records, and pending notices; headerless callers share an unscoped bucket. Subagents/clones share that namespace and the public `chatgpt.max_delegated_agents` cap. Admission counts saved IDs, live IDs, and in-flight creations; it is not a process-wide concurrency semaphore. Existing IDs remain reusable after the cap is reached or lowered. Reserve before browser work.

Service consumes live read-only agent/turn views. Lifecycle operations own page association, conversation URL reconciliation/persistence, activity, and settlement. Service still owns browser effects and disposal of observations returned by settlement. Late activity cannot change a settled turn or its agent status.

`<state_dir>/subagents.sqlite` persists `(parent session ID, agent ID) → conversation URL, turn count, kind`. Pages, results, activity, uncertain state, and notices remain process-local. Temporary agents skip mapping lookup/save but still undergo capacity checks. Persistence failure blocks new submissions before browser work while leaving unrelated MCP tools available. A post-submit write failure does not invalidate an already-sent turn; later admissions fail closed.

## Submission and restoration

A new saved agent opens the configured project URL; later turns use its stable conversation URL. Restore a missing page or navigate a mismatched page before submission. Temporary chats can continue only while their page survives. Clones follow their branched URL.

Install the CDP observer before entering/submitting the prompt. Preserve interaction/inter-turn delays, pre-submit grace, and rate-limit checks; click Send at most once for a requested turn. Successful submission detaches generation from the originating request and returns a local turn ID.

First ordinary subagent prompt appends brevity and no-subagent instructions, also restricting `computer_*` when enabled. Later turns and clones omit this injection. Browser/account/UI details stay behind the service; public error projection belongs to the adapters.

## Idle cleanup

Idle cleanup closes pages after the lifecycle TTL while retaining saved identity. Local results follow the separate [retention policy](./subagent-completion.md#results-and-events). Commit temporary expiration only after page close succeeds or the page is confirmed closed; failed close remains retryable. Saved agents reopen their conversation on reuse, including after process restart. Temporary expiration returns `TEMP_AGENT_EXPIRED`; changing the memory flag cannot revive it.

[Completion](./subagent-completion.md) owns active-turn recovery, uncertainty, and notice semantics. [Runtime Recovery](../operations/runtime-recovery.md) owns intentional state resets. Tests: [service/lifecycle](../../../test/tools/delegation/chatgpt-service.test.ts), [capacity](../../../test/tools/delegation/delegated-agent-limit.test.ts), [store](../../../test/tools/delegation/store.test.ts).
