# ChatGPT Local Shell MCP Wiki Maintainer

This vault follows the LLM wiki pattern from Andrej Karpathy's "LLM Wiki" gist (`https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`): raw sources are read-only evidence, the wiki is maintained markdown, and this file is the schema for future agents.

This committed vault preserves the current architecture and maintenance contracts for ChatGPT Local Shell MCP. It follows the LLM-wiki split between read-only evidence in `raw/`, maintained synthesis in `pages/`, repository conventions in `ops/`, and an append-only `log.md`; `_private/` is gitignored.

## Rules

- Read `index.md`, the relevant page, and the exact current source before changing code.
- Current code and tests outrank README and raw notes. Record source conflicts in `raw/source-manifest.md`.
- Cite repository-relative paths for implementation facts.
- Update an existing page before adding one. Keep pages short, direct, and marked `Verified YYYY-MM-DD`.
- Do not add page-level purpose sections or related-link footers; `index.md` owns description and navigation.
- Keep end-user workflows out unless they constrain an implemented server contract.
- Never store secret values anywhere in the vault, including `_private/`.
- Treat `raw/` as immutable evidence except for maintaining `raw/source-manifest.md`.

## Workflow

1. Read `index.md` and one to three relevant pages.
2. Verify drift-prone claims against source and focused tests.
3. Update synthesis, the index when its entries change, and `raw/source-manifest.md` when evidence conflicts.
4. Append `## [YYYY-MM-DD] operation | description` to `log.md`.
5. Lint for dead index entries, contradictions, missing path citations, stale risks, and secrets.
