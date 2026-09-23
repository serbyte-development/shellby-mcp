---
summary: "Deferred experiments and the constraints that would justify revisiting them."
---

# Roadmap

Ideas below are uncommitted; presence here grants no implementation approval.

- **Portability:** broaden beyond macOS when a concrete host need justifies platform work. Avoid speculative abstractions.
- **Caller lineage:** revisit only after proving a shared identifier between browser calls and incoming MCP sessions. [Agent Context](../agent-context.md) records failed heuristic correlation.
- **Shell ergonomics:** consider interruption without full reset, or a simpler one-shot call with optional persistent state. Preserve retry safety and batch support. Descriptive request IDs may provide useful task orientation; evaluate before replacing them with opaque IDs.
- **Compact routine checks:** reduce turns and tokens spent constructing and reading typecheck, lint, format, test, and build commands. The September 23 audit backup contained checks in 55 of 404 shell calls, plus 11 related polls; check-only calls and their polls accounted for roughly 20,600 recorded MCP input/output tokens. This measures overhead, not guaranteed savings.
  - **Local executable option:** accept a working directory and command arguments, callable through existing shell tools, for example `check-run --cwd /path/to/repo -- npm run lint`. Support a repo-owned check sequence when useful. Return short success summaries, bounded failure diagnostics, and a path to full output; preserve exit codes and the persistent shell's state. Start with generic reporting and add tool-specific parsers only when needed.
  - **Hook option:** run a repo-configured cleanup/check sequence at a defined checkpoint and return the same compact summary. Shellby currently has no task-finished signal; establish an explicit checkpoint or reliable client lifecycle trigger before automating it. Running after every edit risks repeated checks against incomplete changes.
  - Keep command selection and scope repo-owned. Complete formatting and other file writes before dependent checks. Measure reduced calls/output and avoid rerunning broad suites unnecessarily before expanding either approach. Both options remain exploratory.
- **Authenticated fetching:** test a small headed/CDP alternative when current headless acquisition fails important tasks. Establish benefit before adding shared-browser lifecycle/configuration complexity.
- **Distribution:** consider bundling only after measuring a startup/artifact/distribution problem; current build uses plain TypeScript compilation.
- **Client capabilities:** earlier resources/tasks probes did not establish useful ChatGPT support. Recheck actual client behavior before introducing either surface; modern protocol transport alone does not prove extension support.

Configuration customization and binary file-transfer tools already exist. Route implementation work to [Configuration](../operations/configuration-and-startup.md) and [Files and Images](../tools/files-and-images.md); end-to-end client transfer behavior still needs empirical validation.

[Possible Evals](./possible-evals.md) preserves comparison goals and prior benchmark blockers.
