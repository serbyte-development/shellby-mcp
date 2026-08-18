# Workspace Tooling

Verified 2026-08-18.

## What This Is

This page documents the configured coding workspace, dynamic skill catalog, and prompt-only generated-tool conventions.

## Default Workspace

`MCP_CWD` defaults to `MCP_CONFIG.defaults.workspace`, currently `~/Desktop/agent-workspace`. `src/config.ts` expands `~` and resolves relative paths from the startup directory; server startup creates the resulting absolute directory recursively and uses it consistently for the initial shell cwd, advertised `AGENTS.md`, and workspace tools. First-time `npm run setup` also calls `scripts/workspace-setup.mjs`, which creates a starter workspace `AGENTS.md` only when one does not already exist. This is a convention, not a sandbox: shell commands retain the local user's filesystem permissions (`src/config.ts`, `src/index.ts`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`, `test/setup-workspace.test.ts`).

## `apply_patch`

`apply_patch` is a first-class MCP tool backed directly by the checked-in Codex binary, independent of persistent shells. Syntax, execution order, partial-failure semantics, result format, native quirks, diagnostics, audit behavior, build provenance, and tests are centralized in [[tools/apply_patch]] (`src/tools/apply-patch/apply-patch.ts`, `vendor/apply-patch/`).

## Workspace Skills

Reusable agent workflows live under `<workspace>/skills/<name>/SKILL.md`. `skill_list` scans that directory on every call and returns the directory name plus frontmatter description when present; `skill_load` validates one returned name and returns its complete instructions plus local `SKILL.md` path. Skills are therefore dynamic data rather than MCP schema entries, so adding or removing a skill does not require rebuilding the server (`src/tools/skills.ts`, `src/server/mcp-server.ts`).

The maintainer workspace currently exposes `skills/create-skill` as a local directory and `skills/create-vscode-extension`, `skills/create-wiki`, and `skills/interview-me` as directory symlinks to their canonical entries under `~/.codex/skills`. This keeps shared skills single-sourced while still allowing the MCP catalog to expose only selected skills. Directory symlinks are an intentional supported setup (`src/tools/skills.ts`, `test/skills.test.ts`).

Skill names accept only alphanumeric-leading names containing letters, numbers, dots, underscores, and hyphens, preventing path traversal while still allowing a named workspace entry to be a symlink. `SKILL.md` is capped at 256 KiB; broken or oversized entries are omitted from `skill_list`, while direct `skill_load` calls return explicit errors (`src/tools/skills.ts`).

## Generated Tool Convention

MCP instructions refer to `<workspace>/tools`, `<workspace>/TOOLS.md`, per-tool `TOOL.md` files, and `<workspace>/tools/README.md`. No source module creates, validates, catalogs, or executes this structure specially. It is currently an external prompt convention implemented through ordinary shell commands (`src/config.ts`, `src/index.ts`).

## Related

- [[pages/Project Overview]]
- [[pages/Configuration and Startup]]
- [[pages/MCP Tool Surface]]
- [[pages/Persistent Shell Runtime]]
- [[tools/apply_patch]]
