# Host Application Binary Reuse

Verified 2026-08-06.

## What This Is

This page records the two host executable integrations used by the finished server. It is an implementation boundary, not a roadmap for additional application adapters.

## Current Integrations

### Vendored Codex patch executable

The private repository pins the macOS arm64 Codex multicall binary as `vendor/apply_patch` through Git LFS. The filename selects its patch mode. `prepareApplyPatch` creates or reuses `<workspace>/bin/apply_patch`, targets the vendored snapshot by default, permits `MCP_CODEX_BIN` as an override, and prepends the workspace bin directory to persistent shells. The first-class `apply_patch` tool also spawns that prepared absolute path directly, independently of persistent shells (`vendor/apply_patch`, `.gitattributes`, `src/workspace-tools.ts`, `src/index.ts`, `src/mcp-server.ts`).

The integration remains optional at runtime. A missing or non-executable selected binary produces a startup warning, while the rest of the MCP remains available (`src/workspace-tools.ts`, `src/index.ts`). Clones must materialize the LFS object before using the vendored default.

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
