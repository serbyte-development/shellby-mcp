---
summary: "Default coding workspace behavior and the dynamic reusable-skill catalog exposed through skill_list and skill_load."
paths:
  - src/tools/skills.ts
  - scripts/workspace-setup.mjs
  - test/skills.test.ts
  - test/setup-workspace.test.ts
---

# Workspace Tooling

## What This Is

This page documents the configured coding workspace and dynamic skill catalog.

## Default Workspace

`MCP_CWD` feeds `MCP_CONFIG.workspace` and defaults to `~/Desktop/agent-workspace`. `src/config.ts` expands `~` and resolves relative paths from the startup directory; server startup creates the resulting absolute directory recursively and uses it for the initial shell cwd, advertised `AGENTS.md`, and workspace-relative tools. First-time `npm run setup` creates a starter workspace `AGENTS.md` only when one does not already exist. This is a convention, not a sandbox (`src/config.ts`, `src/index.ts`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`, `test/setup-workspace.test.ts`).

## Workspace Skills

Reusable agent workflows live under `<workspace>/skills/<name>/SKILL.md`. `skill_list` scans that directory on every call and returns the directory name plus frontmatter description when present; `skill_load` validates one returned name and returns its complete instructions plus local `SKILL.md` path. Skills are therefore dynamic data rather than MCP schema entries, so adding or removing a skill does not require rebuilding the server (`src/tools/skills.ts`, `src/server/mcp-server.ts`).

The maintainer workspace catalog is intentionally not enumerated here because it is dynamic and can change without a Shellby rebuild. Directory symlinks are supported, so selected shared skills can stay single-sourced while still appearing under `<workspace>/skills` (`src/tools/skills.ts`, `test/skills.test.ts`).

Skill names accept only alphanumeric-leading names containing letters, numbers, dots, underscores, and hyphens, preventing path traversal while still allowing a named workspace entry to be a symlink. `SKILL.md` is capped at 256 KiB; broken or oversized entries are omitted from `skill_list`, while direct `skill_load` calls return explicit errors (`src/tools/skills.ts`).

## Related

- [Project Overview](./project-overview.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Persistent Shell Runtime](./persistent-shell-runtime.md)
- [apply_patch](./tools/apply-patch.md)
