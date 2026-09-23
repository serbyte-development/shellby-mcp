---
summary: "Add or enable tools; startup prompt discovery, initialization, and review feedback."
paths:
  - src/index.ts
  - src/mcp/server-factory.ts
  - src/config.ts
  - src/public-config.cts
  - src/tools/start-here/
  - src/agent/load-deduper.ts
  - src/tools/review/review-tool.ts
---

# MCP Tool Surface

## Adding or changing a tool

Schemas, descriptions, and handlers belong beside the capability in `src/tools/`. [server-factory.ts](../../src/mcp/server-factory.ts) owns registration and enabled groups; [src/index.ts](../../src/index.ts) constructs shared services. Enabled groups requiring a missing service fail composition. `start_here` is always registered.

For a new configurable group, coordinate [public-config.cts](../../src/public-config.cts), [config.ts](../../src/config.ts), composition, and registration. Factory construction snapshots server identity, enabled groups, and output mode; these require restart to change. Avoid per-request service construction.

Use `npm run schemas -- <tool-name>` for the actual configured contract. [Tool Design](./tool-naming-and-schema-design.md) owns model-facing conventions; [Registration Boundary](./mcp-tool-registration-boundary.md) owns validation, projection, and notices. [Tools index](./tools/index.md) routes capability semantics; root index also routes Computer Use and workspace skills.

## Startup instructions

[start-here.ts](../../src/tools/start-here/start-here.ts) discovers modes from lowercase kebab-case Markdown filenames in bundled `src/tools/start-here/prompts/` and local `.shellby/prompts/`. Local files override bundled names; new names add modes. Reserved `shared.md` loads before the selected mode.

Discovery happens on MCP server registration; contents load at call time. Changes can appear on later `tools/list` calls without restarting, although a caching client may need refresh. Startup does not interpolate workspace or read its `AGENTS.md` automatically.

For callers with `X-OpenAI-Session`, successful loading sets `AgentIdentity.taskSlug` from `task_id`, unlocking ordinary tools. Failed loading leaves the caller gated. Headerless callers are ungated. Task IDs are nonempty strings; kebab-case is not enforced. [Agent Context](./agent-context.md) owns identity lifetime.

[load-deduper.ts](../../src/agent/load-deduper.ts) shares recent same-agent/same-key loads for `start_here` and `skill_use`; repeat calls return reuse guidance. Failures remain retryable; headerless callers are not deduplicated.

## Review feedback

[review-tool.ts](../../src/tools/review/review-tool.ts) owns `submit_review`, the process-local usage trigger, and `.shellby/reviews.jsonl`. Factory shares one tracker across requests. This records optional product feedback; it is independent of runtime correctness and authorization.

Review `created_at` and audit headings use the [shared Pacific timestamp formatter](../../src/time.ts).

Validate registration, profiles, and startup through [Build and Test](./operations/build-and-test.md), especially `test/integrations/mcp-runtime.ts` and `session-initialization.ts`.
