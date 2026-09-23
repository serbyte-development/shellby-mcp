---
summary: "Workspace path ownership, skill discovery, dynamic loading, and setup-copy boundaries."
paths:
  - src/tools/skills/
  - src/agent/load-deduper.ts
  - src/config.ts
  - scripts/workspace-setup.ts
---

# Workspace Tooling

[config.ts](../../src/config.ts) resolves `workspace`: expand `~`, otherwise resolve relative paths from repository root. It becomes initial shell cwd and the base for relative file/image paths. It does not confine filesystem access. [Configuration and Startup](./operations/configuration-and-startup.md) owns bootstrap and prerequisites.

## Skill owner

[skill-catalog.ts](../../src/tools/skills/skill-catalog.ts) discovers `<workspace>/skills/<name>/SKILL.md`, validates names and byte limits, follows directory symlinks, and reads frontmatter descriptions. Validation stays inside the catalog so direct callers are safe too. Leading underscores are supported; path traversal is rejected.

Frontmatter uses the existing YAML parser with its JSON schema. Only nonempty string descriptions enter the catalog. Malformed YAML or non-string descriptions omit that metadata while keeping the skill discoverable and its complete instructions loadable.

[skill-tools.ts](../../src/tools/skills/skill-tools.ts) adapts the catalog to `skill_list` and `skill_use`. Lists omit missing/oversized entries; direct loads return explicit errors. `skill_use` returns local path plus complete instructions. Catalog changes need no rebuild because skills are data, not generated MCP schema entries.

Recent same-agent/same-skill loads share the [load deduper](../../src/agent/load-deduper.ts); failed loads remain retryable. Shared behavior with `start_here` is documented in [MCP Tool Surface](./mcp-tool-surface.md).

## Bootstrap boundary

[workspace-setup.ts](../../scripts/workspace-setup.ts) creates starter workspace instructions and copies the repository's `create-skill` only when absent. After first copy, those files are workspace-owned; rerunning setup preserves customization. Repository-level `skills/` does not enter the runtime catalog unless explicitly copied or linked into the workspace.

Tests: [catalog](../../test/tools/skills/skill-catalog.test.ts), [bootstrap preservation](../../test/setup-workspace.test.ts). Do not enumerate a maintainer's dynamic local skill catalog in the wiki.
