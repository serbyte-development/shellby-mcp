---
summary: "Shell retry identity, batch isolation, streaming/polling, output loss, and state lifetime."
paths:
  - src/tools/shell/shell-tools.ts
  - src/tools/shell/shell-contracts.ts
  - src/tools/shell/session.ts
  - src/tools/shell/session-manager.ts
  - src/tools/shell/parallel-session.ts
  - src/tools/shell/parallel-runner.ts
  - src/tools/shell/rtk.ts
  - src/mcp/tool-output.ts
---

# shell_run / shell_poll

Schemas: [shell-contracts.ts](../../../src/tools/shell/shell-contracts.ts). MCP projection: [shell-tools.ts](../../../src/tools/shell/shell-tools.ts). Defaults/ceilings: [MCP_CONFIG.shell](../../../src/config.ts); inspect `npm run schemas -- shell_run shell_poll` rather than copying numeric limits.

## Execution and retries

Provide exactly one of `command` or `commands`. A live shell retains cwd, exported environment, functions, and aliases across single commands. One foreground operation occupies a shell; different shell IDs run independently. Shell IDs are shared across callers, not access controls.

`request_id` is scoped to a live shell's retained records. Retry identity hashes the supplied cwd plus single command or ordered batch, including child cwd fields. Same ID/identity reuses the record; changed identity returns `request_conflict`. Wait/output limits can change on retry. This protection disappears when records are pruned or the shell is destroyed.

Batch children inherit captured cwd/exported environment, run independently under a per-shell scheduler, and cannot mutate parent/sibling shell state. Relative child cwd resolves from batch cwd. Extra children queue; one failure does not cancel siblings. Batch exit code is zero only if all succeed. Child timeouts/concurrency belong to [parallel-runner.ts](../../../src/tools/shell/parallel-runner.ts); ordinary commands have no hard runtime deadline.

## Streaming and continuation

Execution status and output pagination are independent. Run/retry/poll waits until completion, abort/reset, or yield expiry; a full output page does not shorten that wait. Yield expiry leaves work running. Single-command responses include output already flushed by the child; the parser withholds only possible protocol-marker fragments. Continue with the same shell/request IDs and returned `next_cursor`.

- `next_cursor`: more output may arrive or retained output remains. Completed work can still need pagination.
- `output_truncated` on `shell_run`: more retained output exists. `shell_poll` uses `next_cursor` without repeating this flag.
- `dropped_output_bytes`: permanent capture loss.
- Expired poll cursor: MCP `cursor_expired` error, not a normal output page.

Batch summaries stay in input order; grouped output follows child completion order. `run=N` joins summaries to output. Compact rendering may omit completion status when an exit code already conveys it. [tool-output.ts](../../../src/mcp/tool-output.ts) owns formatting.

## Lifetime

Idle/LRU hibernation preserves only cwd/exported environment in process memory. Functions, aliases, command records, transcripts, and processes disappear. `shell_poll` cannot revive them. `shell_close` discards a named shell and its cache; `shell_reset` cancels work and starts clean. Protected `default` cannot be closed or automatically evicted. Restart loses all shell state.

Optional RTK rewriting occurs after request identity is established; failures fall back to original command. [Shell Runtime](../persistent-shell-runtime.md) owns process protocol, restoration, and rewriting mechanics. Validate through shell unit suites and [MCP shell cases](../../../test/integrations/shell.ts).
