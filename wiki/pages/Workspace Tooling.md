# Workspace Tooling

Verified 2026-07-19.

## What This Is

Startup creates a default workspace and optionally exposes the ChatGPT-bundled Codex patch engine as a normal shell executable (`src/index.ts`, `src/workspace-tools.ts`).

## Default Workspace

`MCP_CWD` defaults to `~/Desktop/chatgpt-workspace`. Startup creates the directory recursively and uses it as the initial shell working directory. This is a convention, not a sandbox: shell commands retain the local user's filesystem permissions (`src/index.ts`, `src/mcp-server.ts`).

## `apply_patch`

`prepareApplyPatch` creates `<workspace>/bin`, checks that `MCP_CODEX_BIN` is executable, and creates `<workspace>/bin/apply_patch` as a symlink when absent. The bin directory is prepended to the persistent shell's `PATH` after login startup (`src/workspace-tools.ts`, `src/index.ts`, `src/shell-session.ts`).

A missing or non-executable Codex binary produces a startup warning rather than failing the server. Tests cover the successful symlink and missing-binary paths (`test/workspace-tools.test.ts`).

The MCP registers `apply_patch` as a first-class fourth tool. Startup passes the prepared absolute executable path into each MCP request. The handler validates an absolute `cwd`, creates a shell-safe randomized heredoc, generates an internal request ID, and drains the shared shell command to completion. The underlying executable remains available to `shell_run` as a fallback (`src/index.ts`, `src/http-server.ts`, `src/mcp-server.ts`, `src/shell-session.ts`).

## Generated Tool Convention

MCP instructions refer to `<workspace>/tools`, `<workspace>/TOOLS.md`, per-tool `TOOL.md` files, and `<workspace>/tools/README.md`. No source module creates, validates, catalogs, or executes this structure specially. It is currently an external prompt convention implemented through ordinary shell commands (`src/mcp-server.ts`, `src/index.ts`).

## Related

- [[pages/MCP Tool Surface]]
- [[pages/Host Application Binary Reuse]]
- [[pages/Bundled MCP and Agent Surfaces]]
- [[pages/Configuration and Startup]]
- [[pages/Open Questions and Risks]]
