# Unhinged Agent Wiki

Start with [Project Overview](pages/Project%20Overview.md), then open only the pages relevant to the subsystem or operation you are changing.

## Core

- [Project Overview](pages/Project%20Overview.md) — purpose, audience, current status, primary workflows, boundaries, conventions, and deeper entry points.
- [Architecture Map](pages/Architecture%20Map.md) — system layers and end-to-end request lifecycle.
- [Configuration and Startup](pages/Configuration%20and%20Startup.md) — environment parsing, workspace initialization, managed startup, shutdown, and recovery.
- [Build and Test](pages/Build%20and%20Test.md) — build boundary, validation commands, CI, coverage, and gaps.
- [Open Questions and Risks](pages/Open%20Questions%20and%20Risks.md) — unresolved operational and architectural risks.
- [Roadmap](pages/ROADMAP.md) — uncommitted experiments and deferred architectural work.

## Runtime and Capabilities

- [HTTP Transport](pages/HTTP%20Transport.md) — MCP v2 routing, ngrok trust boundary, remote ownership, audit logging, and connection lifecycle.
- [MCP Tool Surface](pages/MCP%20Tool%20Surface.md) — published shell, webpage, skill, patch, subagent, and Computer Use contracts.
- [Tool Naming and Schema Design](pages/Tool%20Naming%20and%20Schema%20Design.md) — model-facing conventions for tool names, routing descriptions, schemas, parameters, and outputs.
- [Persistent Shell Runtime](pages/Persistent%20Shell%20Runtime.md) — shell protocol, output bounds, retries, concurrency, and recovery.
- [Workspace Tooling](pages/Workspace%20Tooling.md) — workspace conventions, dynamic skills, and vendored `apply_patch`.
- [Browser ChatGPT Subagents](pages/Browser%20ChatGPT%20Subagents.md) — CDP-backed delegation, completion events, result reconciliation, recovery, and browser ownership.
- [iOS Shell](pages/iOS%20Shell.md) — deferred experimental iPhone command bridge retained in source but not registered with MCP.

## Active and Possible Work

- [Tool Output Markdown Build Plan](pages/Tool%20Output%20Markdown%20Build%20Plan.md) — active implementation plan for compact model-facing tool results; remove after its final facts are folded into maintained pages.
- [Possible Evals](pages/Possible%20Evals.md) — candidate real-work benchmarks for comparing ChatGPT Web plus Unhinged Agent with Codex.

## Supporting Files

- [Secret Handling](ops/Secret%20Handling.md) — credential, audit-log, and local-state rules.
- [Source Manifest](raw/source-manifest.md) — supporting sources, reliability, downstream pages, and conflict notes.
- [Maintenance Log](log.md) — append-only wiki change history.
