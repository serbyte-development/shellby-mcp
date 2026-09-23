---
summary: "Process composition, request flow, and state ownership across subsystem boundaries."
paths:
  - src/index.ts
  - src/mcp/server-factory.ts
---

# Architecture Map

`ChatGPT → ngrok → HTTP/auth → agent context → MCP dispatch → capability service`

[src/index.ts](../../src/index.ts) composes enabled services once and disposes them on startup failure or shutdown. [server-factory.ts](../../src/mcp/server-factory.ts) binds those services and snapshots tool enablement/output mode. HTTP creates short-lived MCP servers from that factory; capability state must outlive those instances.

| Change boundary | Owner and focused context |
| --- | --- |
| Public settings, bootstrap, managed processes | [Configuration and Startup](./operations/configuration-and-startup.md) → shared TOML loader and startup scripts |
| HTTP, remote owner, protocol lifetime | [HTTP Transport](./http-transport.md) → `src/server/http-server.ts`, `src/auth/` |
| Tool composition and initialization | [MCP Tool Surface](./mcp-tool-surface.md) → factory, `start_here`, review prompts |
| Dispatch, schemas, result notices | [Registration Boundary](./mcp-tool-registration-boundary.md) → `src/mcp/` |
| Caller identity, dashboard steering | [Agent Context](./agent-context.md) → `src/agent/`; frontend → [UI wiki](../../ui/wiki/AGENTS.md) |
| Persistent processes and output | [Shell Runtime](./persistent-shell-runtime.md) → `src/tools/shell/` |
| Browser conversations and detached turns | [Delegation Runtime](./subagents/browser-chatgpt-subagents.md) → `src/tools/delegation/` |
| Capability contracts | [Tools](./tools/index.md), [Computer Use](./computer-use.md), [Workspace Skills](./workspace-tooling.md) |
| Audit retention and token accounting | [Audit Logging](./operations/audit-logging.md) → `src/server/audit/` |

State lifetimes differ deliberately:

- Shared process state: named shells, fetched documents, screenshot targets. Shell IDs are shared across MCP callers.
- Caller-scoped process state: initialization/task identity, dashboard instructions, delegated turns/results/events. Session IDs do not establish parent/child lineage.
- Durable machine state: bound remote subject, managed Chrome profile, and delegated conversation mappings under `state_dir`. Saved conversations survive restart; old turn results do not.

Keep capability mechanics in their owners. HTTP knows the factory, auth, audit, and optional observer; it does not construct concrete tool services. [Runtime Recovery](./operations/runtime-recovery.md) explains restart consequences.
