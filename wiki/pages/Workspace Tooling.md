# Workspace Tooling

Verified 2026-08-08.

## Default Workspace

`MCP_CWD` defaults to `~/Desktop/chatgpt-workspace`. Startup expands `~`, resolves relative configuration from the startup directory, creates the resulting absolute directory recursively, and uses it consistently for the initial shell cwd and workspace tools. This is a convention, not a sandbox: shell commands retain the local user's filesystem permissions (`src/index.ts`, `src/workspace-tools.ts`, `src/mcp-server.ts`).

## `apply_patch`

`prepareApplyPatch` creates `<workspace>/bin`, defaults to the pinned macOS arm64 executable at `vendor/apply_patch`, and permits `MCP_CODEX_BIN` as an explicit override. It checks the selected target, creates `<workspace>/bin/apply_patch` as a symlink when absent, and retargets an existing symlink when configuration changes. The bin directory is prepended to the persistent shell's `PATH` after login startup (`vendor/apply_patch`, `src/workspace-tools.ts`, `src/index.ts`, `src/shell-session.ts`).

A missing or non-executable selected binary produces a startup warning rather than failing the server. Tests cover the vendored default, symlink creation, stale-link replacement, and the missing-binary path (`test/workspace-tools.test.ts`).

The MCP registers `apply_patch` as a first-class core tool. Startup passes the prepared absolute executable path into each MCP request. The handler requires an absolute patch root, spawns the executable directly in that directory, writes the patch to stdin, and returns bounded combined failure diagnostics after the process exits. On POSIX the child owns a detached process group; request abort sends the group `SIGTERM`, waits 500 ms, escalates to `SIGKILL`, and force-settles after one further bounded grace period if process close never arrives. Windows uses direct child signaling. `apply_patch` remains independent of persistent-shell state and serialization (`src/index.ts`, `src/http-server.ts`, `src/mcp-server.ts`, `test/mcp-integration.test.ts`).

If additional platform-specific binaries are needed later, pin the Codex repository as a source submodule and build `codex-apply-patch` for each target rather than copying a partial Rust source tree into this repository (`scripts/build-apply-patch.sh`, `vendor/apply_patch.provenance.json`).

## Workspace Skills

Reusable agent workflows live under `<workspace>/skills/<name>/SKILL.md`. `skill_list` scans that directory on every call and returns the directory name plus frontmatter description when present; `skill_use` validates one returned name and returns its complete `SKILL.md` plus local path. Skills are therefore dynamic data rather than MCP schema entries, so adding or removing a skill does not require rebuilding the server (`src/skills.ts`, `src/mcp-server.ts`).

The initial workspace contains only `skills/create-wiki`, copied from the existing Codex `create-wiki` skill with its bundled assets and references. Skill directory symlinks are compatible with the catalog and may later replace copied skills when sharing directly with `.codex/skills` is desirable; the current setup intentionally uses a normal copied directory (`src/skills.ts`, `test/skills.test.ts`).

Skill names accept only alphanumeric-leading names containing letters, numbers, dots, underscores, and hyphens, preventing path traversal while still allowing a named workspace entry to be a symlink. `SKILL.md` is capped at 256 KiB; broken or oversized entries are omitted from `skill_list`, while direct `skill_use` calls return explicit errors (`src/skills.ts`).

## Generated Tool Convention

MCP instructions refer to `<workspace>/tools`, `<workspace>/TOOLS.md`, per-tool `TOOL.md` files, and `<workspace>/tools/README.md`. No source module creates, validates, catalogs, or executes this structure specially. It is currently an external prompt convention implemented through ordinary shell commands (`src/mcp-server.ts`, `src/index.ts`).
