# Unhinged Agent Wiki

This wiki is the concise source of truth for maintaining the Unhinged Agent harness; start with [Architecture Map](pages/Architecture%20Map.md), then open only the page relevant to the code you are changing.

## Pages

- [Architecture Map](pages/Architecture%20Map.md) — system layers and request lifecycle.
- [HTTP Transport](pages/HTTP%20Transport.md) — MCP v2 Express/Node transport, exact routing, ngrok trust boundary, and connection lifecycle.
- [MCP Tool Surface](pages/MCP%20Tool%20Surface.md) — core, skills, shell, webpage, patch, and Computer Use contracts.
- [Tool Naming and Schema Design](pages/Tool%20Naming%20and%20Schema%20Design.md) — ChatGPT-focused standard for tool names, routing descriptions, schemas, parameters, and outputs.
- [Persistent Shell Runtime](pages/Persistent%20Shell%20Runtime.md) — shell protocol, output bounds, retries, concurrency, and recovery.
- [iOS Shell](pages/iOS%20Shell.md) — deferred experimental iPhone command bridge retained in source but not registered with MCP.
- [Workspace Tooling](pages/Workspace%20Tooling.md) — workspace conventions, dynamic skills, and vendored `apply_patch`.
- [Configuration and Startup](pages/Configuration%20and%20Startup.md) — environment parsing, startup composition, shutdown, and tunnel helper.
- [Build and Test](pages/Build%20and%20Test.md) — validation commands, coverage, and gaps.
- [Open Questions and Risks](pages/Open%20Questions%20and%20Risks.md) — unresolved operational and architectural risks.
- [Browser ChatGPT Subagents](pages/Browser%20ChatGPT%20Subagents.md) — complete CDP-backed subagent architecture: parallel starts, passive completion events, explicit result retrieval/reconciliation, activity, idle cleanup, conversation recovery, failures, and implementation map.
- [Possible Evals](pages/Possible%20Evals.md) — candidate real-work benchmarks for comparing ChatGPT Web + Unhinged Agent against Codex.

## Supporting Files

- [Secret Handling](ops/Secret%20Handling.md) — credential and logging rules.
- [source-manifest](raw/source-manifest.md) — evidence inventory and staleness notes.
- [log](log.md) — append-only wiki maintenance history.
