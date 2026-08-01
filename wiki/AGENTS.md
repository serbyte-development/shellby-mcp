# ChatGPT Local Shell MCP Wiki Maintainer

This vault follows the LLM wiki pattern from Andrej Karpathy's "LLM Wiki" gist (`https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`): raw sources are read-only evidence, the wiki is maintained Markdown, and this file is the schema for future agents.

The vault lives at `wiki/`. Everything here is committed except `_private/`, which is gitignored.

## Purpose

- Preserve the build architecture and implementation knowledge needed to maintain ChatGPT Local Shell MCP.
- Make future code changes faster by documenting runtime boundaries, tool contracts, shell semantics, tests, and known risks.
- Keep end-user agent workflows out of scope unless they define or constrain an implemented server contract.
- Keep synthesis here instead of forcing every maintainer to re-derive it from the README and source.

## Layers

- `raw/`: source manifest and source notes. Read-only evidence pointers unless the user asks to add a source.
- `pages/`: maintained architectural synthesis. Update these when implementation facts change.
- `ops/`: repository-wide handling conventions such as secret hygiene.
- `templates/`: templates for future additions.
- `_private/`: gitignored local-only notes. Never commit and never store secret values, even here.
- `index.md`: content map. Update whenever pages are added or renamed.
- `log.md`: append-only maintenance history. Use `## [YYYY-MM-DD] operation | short description` entries.

## Wiki Rules

- Prefer Obsidian wikilinks such as `[[pages/Persistent Shell Runtime]]`.
- Put durable synthesis in `pages/`, not chatty notes.
- Cite concrete paths relative to the repository root for every implementation fact.
- Treat `README.md` as a potentially stale raw source. Verify its claims against current code before promoting them.
- If sources disagree, preserve the discrepancy in `raw/source-manifest.md` and state the current implementation in the relevant page.
- Do not store secret values, passwords, tokens, or API keys anywhere in this vault. Environment variable names and credential locations are allowed.
- Keep pages short, use a `Verified YYYY-MM-DD` line, and backlink related pages.
- Do not expand this vault into documentation for agents using the MCP. This vault is for people and agents changing the server itself.

## Ingest Workflow

1. Add the source to `raw/source-manifest.md`.
2. Read the relevant source completely when practical.
3. Verify drift-prone claims against current source and tests.
4. Update existing pages before creating a new one.
5. Add backlinks, update `index.md`, and append a `log.md` entry.

## Query Workflow

1. Read `index.md`.
2. Open the one to three most relevant pages.
3. Verify implementation details against current source before relying on them for a code change.
4. File valuable evidence-backed synthesis back into the wiki with citations, index changes, and a log entry.

## Lint Workflow

Check for:

- Missing or dead `index.md` entries.
- Orphan pages or missing backlinks.
- Contradictions between pages.
- Stale claims inherited from `README.md`.
- Facts without repository-path citations.
- Accidental secret values.
- Resolved risks that remain in [[pages/Open Questions and Risks]].
