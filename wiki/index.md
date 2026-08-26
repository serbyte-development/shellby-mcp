# Shellby MCP Wiki

Start with [Project Overview](pages/project-overview.md), then open only the pages relevant to the subsystem or operation you are changing.

## Core

- [Project Overview](pages/project-overview.md) — purpose, audience, current status, primary workflows, boundaries, conventions, and deeper entry points.
- [Architecture Map](pages/architecture-map.md) — system layers and end-to-end request lifecycle.
- [Configuration and Startup](pages/configuration-and-startup.md) — supported environment inputs, workspace initialization, managed startup, shutdown, and recovery.
- [Build and Test](pages/build-and-test.md) — build boundary, validation commands, CI, coverage, and gaps.
- [Open Questions and Risks](pages/open-questions-and-risks.md) — unresolved operational and architectural risks.
- [Roadmap](pages/roadmap.md) — uncommitted experiments and deferred architectural work.

## Runtime and Capabilities

- [HTTP Transport](pages/http-transport.md) — MCP v2 routing, ngrok trust boundary, remote ownership, and connection lifecycle.
- [Audit Logging](pages/audit-logging.md) — canonical `agent-commands.yaml` retention, truncation, token accounting, and sensitivity behavior.
- [MCP Tool Surface](pages/mcp-tool-surface.md) — published shell, webpage, skill, patch, subagent, and Computer Use contracts.
- [Tool Naming and Schema Design](pages/tool-naming-and-schema-design.md) — model-facing conventions for tool names, routing descriptions, schemas, parameters, and outputs.
- [Persistent Shell Runtime](pages/persistent-shell-runtime.md) — shell protocol, output bounds, retries, concurrency, and recovery.
- [Workspace Tooling](pages/workspace-tooling.md) — configured workspace and dynamic skill catalog.
- [Computer Use](pages/computer-use.md) — Peekaboo execution path, cursor-host ownership, target/snapshot rules, background delivery, and coordinate semantics.
- [Browser ChatGPT Subagents](pages/browser-chatgpt-subagents.md) — CDP-backed orchestration, durable conversation identity, prompt submission, and browser ownership.
- [Subagent Completion](pages/subagent-completion.md) — CDP turn completion, event delivery, recovery, and local result settlement.
- [ChatGPT CDP Transport](pages/chatgpt-cdp-transport.md) — observed ChatGPT turn transport, CDP completion signals, and rate-limit findings.
- [iOS Shell](pages/ios-shell.md) — deferred experimental iPhone command bridge retained in source but not registered with MCP.

## Tool Reference

- [`apply_patch`](pages/tools/apply-patch.md) — grammar, execution/atomicity, partial failures, result summaries, native quirks, limits, and tests.
- [`shell_run` / `shell_poll`](pages/tools/shell-run.md) — caller-facing persistent shell, batch, polling, output, and lifetime contract.
- [`subagent_run` / `subagent_result`](pages/tools/subagent.md) — caller-facing delegation, capacity, retrieval, activity, and failure contract.

## Possible Work

- [Possible Evals](pages/possible-evals.md) — candidate real-work benchmarks for comparing ChatGPT Web plus Shellby MCP with Codex.

## Supporting Files

- [Secret Handling](pages/secret-handling.md) — credential, audit-log, and local-state rules.
- [Source Manifest](raw/source-manifest.md) — supporting sources, reliability, downstream pages, and conflict notes.
- [Maintenance Log](log.md) — append-only wiki change history.
