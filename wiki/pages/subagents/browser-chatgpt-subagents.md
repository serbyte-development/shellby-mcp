---
summary: "Subagent ownership, identity capacity, tab lifetime, submission safety, and startup diagnostics."
paths:
  - src/tools/delegation/subagents.ts
  - src/tools/delegation/conversation-tab.ts
  - src/tools/delegation/chatgpt-browser.ts
  - src/tools/delegation/diagnostics.ts
  - src/tools/delegation/store.ts
  - src/public-config.cts
---

# Subagent Runtime

Caller contract: [subagent tools](../tools/subagent.md). Caller identity: [Agent Context](../agent-context.md).

| Owner | Responsibility |
| --- | --- |
| [subagents.ts](../../../src/tools/delegation/subagents.ts) | One `createSubagents()` instance owns agent/turn state and complete submission, collection, recovery and cleanup workflows |
| [conversation-tab.ts](../../../src/tools/delegation/conversation-tab.ts) | Prepare new, forked or saved tabs; own readiness and intermediate-tab cleanup |
| [chatgpt-browser.ts](../../../src/tools/delegation/chatgpt-browser.ts) | CDP/tab and composer mechanics; no agent lifecycle |
| [store.ts](../../../src/tools/delegation/store.ts) | Durable conversation mappings; explicit persistence failure |

## Identity and lifetime

Agent IDs belong to the calling `AgentIdentity`; headerless calls share one scope. Capacity counts saved, live and reserved identities, including idle or uncertain agents. Closing a tab or finishing a turn does not free an identity slot. Existing IDs remain reusable at capacity when idle; uncertain IDs stay blocked. There is no automatic retirement policy.

Reserve before browser work. Unsent first-start failures release the new identity and owned tab; failed follow-ups retain established identity. A submitted turn keeps its reservation until settlement, independently of the originating MCP request or polling. Returning a turn ID must not unlock the agent.

SQLite preserves caller/agent → conversation mappings and optional observed child session IDs. [Agent Context](../agent-context.md#observed-parent-links) owns parent-link evidence/restoration. Tabs, active turns and results are process-local. Idle tab cleanup retains saved identity; later submissions reopen it. Persistence failure blocks new work, but a write failure after Send must not invalidate submitted work. [Hard restart](../operations/runtime-recovery.md) deliberately clears saved mappings.

Keep mutable records inside the factory. The MCP adapter translates contracts and audits failures; it does not schedule browser work or manage lifecycle state. [Architecture](../architecture-map.md) explains why the factory outlives individual MCP servers.

## Submission invariants

New and forked conversations share submission and recovery. Preparation never sends; it returns the actual target tab, including same-tab or popup forks, and cleans up unused owned tabs. Managed Chrome is attach-only; [startup](../operations/configuration-and-startup.md) owns launching it.

`submitTurn` installs observation before prompt entry. Its private `submitMessageToBrowser` owns settling delays, target rechecks, account-limit checks and one Send attempt. Composer visibility alone does not establish client readiness.

A click/navigation error can occur after ChatGPT accepted the message. The observer resolves pending request metadata before classifying that error; never retry Send merely because the action threw. [Completion](./subagent-completion.md) owns message correlation and settlement.

`WEB:` and `local-chatgpt:` URLs are drafts, not durable identity. Stream events and URL reconciliation feed `recordConversation`. A returned local turn ID does not guarantee that the saved conversation URL has arrived yet.

## Failure diagnostics

[diagnostics.ts](../../../src/tools/delegation/diagnostics.ts) emits bounded `[delegation]` evidence before failed-startup cleanup. Inspect through `npm run logs`; use [CDP probes](./chatgpt-cdp-transport.md) for detached-generation failures. Startup diagnostics stop when submission returns.

A blank page with only “Try again” does not establish blocking, authentication failure or a browser crash. Correlate console errors, network responses and page health before changing retries. [Testing](./testing.md) separates fixture coverage from authenticated evidence.
