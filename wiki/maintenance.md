# Wiki Maintenance

Maintain a routing layer for repository work. Preserve relationships, ownership, invariants, failure semantics, and hard-won reasoning. Link to source for inventories, schemas, numeric defaults, and code details. Each behavior has one owning page; related pages route there.

## Metadata and structure

Routable Markdown under `pages/` requires concise `summary`; optional `paths` names source whose meaningful changes could invalidate that page. Track actual knowledge owners, not every mentioned file or all of `src/`. Stable overview/research maps may omit paths. Startup overview carries only global context.

Nested directories need an `index.md` with summary front matter. The wiki-system skill's `scripts/wiki clean <repo>/wiki` generates index bodies, validates metadata, and warns about oversized pages/summaries. Fix owning metadata; do not hand-edit generated bodies. Large-page warnings are review triggers, not size targets.

## Freshness

Use the skill's bundled helper:

```sh
scripts/wiki clean <repo>/wiki
scripts/wiki audit <repo>/wiki
scripts/wiki audit mark <wiki-page> <repo>/wiki
```

`audit` fingerprints Git-visible working-tree contents under `paths`, including non-ignored untracked files. Review each flagged page against source before marking, even if no prose changes. Fingerprint equality does not prove correctness when paths omit an owner. Do not duplicate changing limits merely to make them auditable.

Commit `.wiki-system/audit-state.json`; helper owns it. Never inspect/edit it manually. `audit baseline` initializes only untracked page baselines; it must not clear review warnings. Use it after reviewed creation/migration, not as a substitute for review.

## Evidence and decisions

Preserve existing `raw/` bodies. New external evidence is copied/converted to Markdown with summary metadata; never move/delete originals. Editing existing raw evidence requires explicit user approval. `raw/index.md` is generated.

`log.md` is this wiki's decision log. Preserve chronological entries; `test/wiki-log.test.ts` checks ordering. Append only durable decisions/discoveries whose reasoning is absent from current source/history, not routine changes. No rename to `decision-log.md` needed.

Before finishing, test realistic routes from `AGENTS.md`/`index.md` to a focused page, source, and necessary related context. Check local links, remove overlap, and preserve the separate UI-wiki handoff.
