# Host Application Binary Reuse

Verified 2026-08-05.

## What This Is

This page records the two host executable integrations used by the finished server. It is an implementation boundary, not a roadmap for additional application adapters.

## Current Integrations

### ChatGPT-bundled Codex

`prepareApplyPatch` creates or reuses `<workspace>/bin/apply_patch`, normally targeting `/Applications/ChatGPT.app/Contents/Resources/codex`, and prepends the workspace bin directory to persistent shells. The first-class `apply_patch` tool executes the prepared absolute path through the selected named shell (`src/workspace-tools.ts`, `src/index.ts`, `src/mcp-server.ts`).

The integration is optional. A missing or non-executable Codex binary produces a startup warning, while the rest of the MCP remains available (`src/workspace-tools.ts`, `src/index.ts`).

### Peekaboo

`PeekabooClient` invokes the supported installed `peekaboo` CLI through `execFile`, with literal argv, one process-level serial queue, bounded JSON output, no shell interpolation, no action retries, and a bounded snapshot-target cache. Eleven focused `computer_*` schemas sit above it (`src/peekaboo.ts`, `src/computer-use-tools.ts`, `src/http-server.ts`).

The executable defaults to `PATH` lookup and may be overridden with `MCP_PEEKABOO_BIN`. Tool schemas remain registered when the executable or macOS permissions are unavailable; the attempted call returns the failure (`src/index.ts`, `src/peekaboo.ts`).

## Maintainer Rules

- Invoke installed binaries in place; do not copy them into the repository.
- Keep executable paths configurable when they are not stable public locations.
- Use exact argv rather than shell interpolation for structured adapters.
- Bound output, preserve upstream semantic errors, and avoid retrying actions that may already have happened.
- Re-test integration behavior after host-application or CLI upgrades.

## Historical Research

Point-in-time surveys of other bundled or installed capabilities remain in [[raw/Host App Binary Survey 2026-07-20]] and [[raw/ChatGPT and Local Capability Survey 2026-08-01]]. They are evidence only and are not planned MCP additions.

## Related

- [[pages/Workspace Tooling]]
- [[pages/Bundled MCP and Agent Surfaces]]
- [[pages/MCP Tool Surface]]
- [[pages/Open Questions and Risks]]
