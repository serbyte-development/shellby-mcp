# Workspace Tooling

Verified 2026-08-15.

## What This Is

This page documents the configured coding workspace, direct patch runtime, dynamic skill catalog, and prompt-only generated-tool conventions.

## Default Workspace

`MCP_CWD` defaults to `MCP_CONFIG.defaults.workspace`, currently `~/Desktop/agent-workspace`. `src/config.ts` expands `~` and resolves relative paths from the startup directory; server startup creates the resulting absolute directory recursively and uses it consistently for the initial shell cwd, advertised `AGENTS.md`, and workspace tools. First-time `npm run setup` also calls `scripts/workspace-setup.mjs`, which creates a starter workspace `AGENTS.md` only when one does not already exist. This is a convention, not a sandbox: shell commands retain the local user's filesystem permissions (`src/config.ts`, `src/index.ts`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`, `test/setup-workspace.test.ts`).

## `apply_patch`

The MCP registers `apply_patch` as a first-class core tool and resolves the checked-in macOS Universal 2 executable directly from `vendor/apply-patch/apply_patch`. There is no workspace symlink, shell `PATH` injection, or runtime binary override. Shell callers do not need `apply_patch`; agents use the MCP tool directly (`src/tools/apply-patch/apply-patch.ts`, `vendor/apply-patch/apply_patch`).

The handler requires an absolute patch root, spawns the vendored executable directly in that directory, writes the patch to stdin, and caps combined failure diagnostics internally at 1,024 `o200k_base` tokens; callers cannot raise that limit through the tool schema. On POSIX the child owns a detached process group; request abort sends the group `SIGTERM`, waits 500 ms, escalates to `SIGKILL`, and force-settles after one further bounded grace period if process close never arrives. Windows uses direct child signaling. `apply_patch` remains independent of persistent-shell state and serialization (`src/tokenizer.ts`, `src/server/http-server.ts`, `src/tools/apply-patch/apply-patch.ts`, `test/mcp-integration.test.ts`).

Direct MCP probes on 2026-08-11 against the vendored binary pinned in `vendor/apply-patch/provenance.json` verified `Add File`, `Update File`, `Delete File`, `Move to`, multiple file operations, multiple ordinary hunks, `@@ <context>` search anchors, and `*** End of File`. A single `@@` anchor can scope a later matching change within that region. Consecutive `@@` anchors are rejected as an invalid update hunk, despite the copied Codex prompt example that describes nested `@@` anchors. Hunk body lines must begin with space, `-`, or `+`; malformed envelopes and hunks return specific parser diagnostics (`vendor/apply-patch/apply_patch`).

Two parser behaviors are intentionally treated as implementation quirks rather than the MCP contract: `*** Add File` overwrites an existing path, and an absolute path inside a patch is accepted by the vendored binary and can escape `cwd`. The public tool schema and agent instructions still require patch file references to be relative. The wrapper mechanically validates only that `cwd` itself is absolute; it does not parse or sandbox patch-internal paths (`src/tools/apply-patch/apply-patch.ts`, `vendor/apply-patch/apply_patch`).

On failure, `structuredContent` returns `status: failed`, the native exit code, and up to 1,024 `o200k_base` tokens of combined stdout/stderr in `output`; `output_dropped` marks diagnostics discarded beyond that ceiling. The text `content` also includes the same bounded native diagnostic after the compact `apply_patch failed, exit=...` summary so clients that primarily surface text still receive actionable parser errors. The audit logger records a bounded failure message and up to 32,000 characters of the failed patch alongside cwd and patch size in `agent-commands.yaml`; successful patch calls omit the patch body. Wrapper/startup failures that have no structured output use the returned text error, so the reason is still logged. Actual parser failures include useful diagnostics such as missing envelope markers, missing files, unmatched context, and invalid hunk lines. Successful calls intentionally omit native output and return only compact status/exit metadata (`src/tokenizer.ts`, `src/tools/apply-patch/apply-patch.ts`, `src/server/audit-log.ts`, `test/mcp-audit-log.test.ts`, `test/mcp-integration.test.ts`).

The vendored binary, provenance, license, and notice live together under `vendor/apply-patch/`. `scripts/build-apply-patch.sh` builds the pinned Codex source for `aarch64-apple-darwin` and `x86_64-apple-darwin`, strips both slices, merges them with `lipo`, verifies both architectures are present, and records both targets in `provenance.json`. Future non-macOS support should add the minimum platform-specific artifact needed rather than copying a partial Rust source tree into this repository (`scripts/build-apply-patch.sh`, `vendor/apply-patch/provenance.json`).

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
