# Shellby MCP Wiki Maintainer

This vault follows the LLM wiki pattern from Andrej Karpathy's "LLM Wiki" gist (`https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`): raw sources are read-only evidence, the wiki is maintained Markdown, and this file is the schema for future agents.

The vault lives at `wiki/`.

## Purpose

- Preserve the architecture, runtime contracts, operational knowledge, risks, and decisions needed to maintain the Shellby MCP local MCP harness.
- Start with [Project Overview](./pages/Project%20Overview.md) for the project's purpose, audience, status, workflows, boundaries, constraints, and deeper wiki entry points.
- Keep current implementation synthesis in the vault so future agents can verify rather than rediscover how the harness works.
- Keep end-user setup details only when they constrain an implemented server or operational contract.

## Layers

- `raw/`: supporting source documents and `source-manifest.md`. Treat source material as read-only evidence.
- `pages/`: maintained synthesis. Update existing pages when project facts change. Canonical per-tool references live under `pages/tools/`.
- `templates/`: templates for future wiki pages and source notes.
- `index.md`: the content map and primary entry point. Update it when pages are added, removed, or renamed.
- `log.md`: the append-only maintenance log using `## [YYYY-MM-DD] operation | description` entries.
- `_private/`: optional gitignored local notes. Never store secret values there or anywhere else in the vault.

## Wiki Rules

- Start with `index.md`, then open only the one to three pages relevant to the current question or task.
- Read the exact current source before changing code or documenting implementation behavior.
- Use current code and tests for implementation truth and approved business or upstream sources for external facts.
- Cite repository-relative paths for implementation claims.
- If evidence conflicts, preserve the current fact in the maintained page and record the conflict with the supporting source in `raw/source-manifest.md`.
- Update an existing page before adding one. Keep every page extremely concise and marked `Verified YYYY-MM-DD`.
- Give each page one cohesive subject or question. Keep one natural home for each fact and link to it instead of repeating the explanation elsewhere.
- Treat `Project Overview.md` as orientation, not a compressed copy of the wiki. Architecture, routes, data, operations, tool contracts, and subsystem internals belong on dedicated pages.
- Give every maintained page a short `What This Is` section and a `Related` section with standard relative Markdown links.
- Resolve relative links from the file that contains them. Use `%20` for spaces in link destinations.
- Keep roadmap and experimental work explicitly labeled as uncommitted or disabled rather than current behavior.
- After tool schemas, descriptions, or server instructions change, remember that ChatGPT may retain previously imported metadata until the MCP app is updated on the ChatGPT website. A local rebuild or restart alone does not prove that client has refreshed metadata.
- Never store secret values anywhere in the vault, including `_private/`.
- Do not update the wiki during unrelated work. Update it when the user requests maintenance or the current task changes documented facts.

## Ingest Workflow

1. Record the supporting source in `raw/source-manifest.md`.
2. Read the approved source fully and preserve its actual claims and context.
3. Verify drift-prone claims against current repository evidence.
4. Update existing pages before creating a new one.
5. Add backlinks and update `index.md` when pages change.
6. Append a `log.md` entry with the source, pages touched, corrections, and unresolved questions.

## Query Workflow

1. Read `index.md`.
2. Open the one to three most relevant pages.
3. Answer from the wiki when it is current enough.
4. Verify drift-prone claims against the repository or relevant service before presenting them as current.
5. When verification exposes a material stale or missing fact, fold it into the maintained page and append a `log.md` entry if wiki maintenance is in scope.

## Lint Workflow

Periodically check for:

- Dead `index.md` entries and orphan pages.
- Broken relative Markdown links or leftover Obsidian wikilinks.
- Fake/template destinations that intentionally resolve to nonexistent pages.
- Missing `What This Is`, `Verified`, `Related`, citations, or backlinks.
- Contradictions between maintained pages and current source.
- Missing or nonexistent repository-path citations.
- Stale risks and resolved questions not folded back into maintained pages.
- Roadmap or experimental work accidentally described as implemented or approved.
- Secret values, private identifiers, or unsafe operational output.
