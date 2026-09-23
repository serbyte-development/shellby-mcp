---
summary: "Deferred experiments and the constraints that would justify revisiting them."
---

# Roadmap

Ideas below are uncommitted; presence here grants no implementation approval.

- **Portability:** broaden beyond macOS when a concrete host need justifies platform work. Avoid speculative abstractions.
- **Caller lineage:** revisit only after proving a shared identifier between browser calls and incoming MCP sessions. [Agent Context](../agent-context.md) records failed heuristic correlation.
- **Shell ergonomics:** consider interruption without full reset, or a simpler one-shot call with optional persistent state. Preserve retry safety and batch support. Descriptive request IDs may provide useful task orientation; evaluate before replacing them with opaque IDs.
- **Authenticated fetching:** test a small headed/CDP alternative when current headless acquisition fails important tasks. Establish benefit before adding shared-browser lifecycle/configuration complexity.
- **Distribution:** consider bundling only after measuring a startup/artifact/distribution problem; current build uses plain TypeScript compilation.
- **Client capabilities:** earlier resources/tasks probes did not establish useful ChatGPT support. Recheck actual client behavior before introducing either surface; modern protocol transport alone does not prove extension support.

Configuration customization and binary file-transfer tools already exist. Route implementation work to [Configuration](../operations/configuration-and-startup.md) and [Files and Images](../tools/files-and-images.md); end-to-end client transfer behavior still needs empirical validation.

[Possible Evals](./possible-evals.md) preserves comparison goals and prior benchmark blockers.
