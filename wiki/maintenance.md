# Wiki Maintenance

Wiki pages and raw-source metadata are agent-authored. Generated indexes are derived routing artifacts.

## Front Matter Metadata

- `summary` is required for routable pages and should stay concise. `wiki clean` warns above 240 characters.
- `paths` is optional and names repository files or directories the page helps explain.
- `read_more` is optional and names useful wiki-root-relative pages to open next.
- Update front matter when a page's knowledge scope changes.

When creating a nested knowledge directory, add an `index.md` with only a `summary` in front matter. `wiki clean` generates and maintains the index body.

## Page Structure

- Keep one cohesive subject per page.
- Keep indexes small enough to route cheaply.
- Split large knowledge areas into meaningful nested directories when useful.
- Keep supporting evidence under `raw/`.

## Raw Sources

- Add front matter containing only a concise `summary` when ingesting Markdown evidence.
- Preserve the raw source body after capture.
- `wiki clean` generates `raw/index.md` from raw Markdown summaries.
- Non-Markdown evidence may live under `raw/` unchanged.

## Context Log

`log.md` records only durable historical context that cannot be cheaply reconstructed from Git, the current wiki, or raw evidence. Most changes should not add an entry.

## Cleanup

After adding, moving, renaming, deleting, or materially changing wiki pages or raw Markdown sources, run the `wiki-system` skill's `scripts/wiki clean <project-root>/wiki` helper and fix reported errors plus useful warnings.
