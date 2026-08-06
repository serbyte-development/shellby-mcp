# Workspace Tooling

Verified 2026-08-06.

## Default Workspace

`MCP_CWD` defaults to `~/Desktop/chatgpt-workspace`. Startup expands `~`, resolves relative configuration from the startup directory, creates the resulting absolute directory recursively, and uses it consistently for the initial shell cwd and workspace tools. This is a convention, not a sandbox: shell commands retain the local user's filesystem permissions (`src/index.ts`, `src/workspace-tools.ts`, `src/mcp-server.ts`).

## `apply_patch`

`prepareApplyPatch` creates `<workspace>/bin`, defaults to the pinned macOS arm64 executable at `vendor/apply_patch`, and permits `MCP_CODEX_BIN` as an explicit override. It checks the selected target, creates `<workspace>/bin/apply_patch` as a symlink when absent, and retargets an existing symlink when configuration changes. The bin directory is prepended to the persistent shell's `PATH` after login startup (`vendor/apply_patch`, `.gitattributes`, `src/workspace-tools.ts`, `src/index.ts`, `src/shell-session.ts`).

A missing or non-executable selected binary produces a startup warning rather than failing the server. Tests cover the vendored default, symlink creation, stale-link replacement, and the missing-binary path (`test/workspace-tools.test.ts`).

The MCP registers `apply_patch` as a first-class core tool. Startup passes the prepared absolute executable path into each MCP request. The handler requires an absolute patch root, spawns the executable directly in that directory, writes the patch to stdin, and returns byte-capped combined output after the process exits. It is independent of persistent-shell state and serialization. The tool publishes explicit destructive/non-idempotent annotations, and the underlying executable remains available to `shell_run` as a fallback (`src/index.ts`, `src/http-server.ts`, `src/mcp-server.ts`).

If additional platform-specific binaries are needed later, pin the Codex repository as a source submodule and build `codex-apply-patch` for each target rather than copying a partial Rust source tree into this repository (`scripts/build-apply-patch.sh`, `vendor/apply_patch.provenance.json`).

## Generated Tool Convention

MCP instructions refer to `<workspace>/tools`, `<workspace>/TOOLS.md`, per-tool `TOOL.md` files, and `<workspace>/tools/README.md`. No source module creates, validates, catalogs, or executes this structure specially. It is currently an external prompt convention implemented through ordinary shell commands (`src/mcp-server.ts`, `src/index.ts`).
