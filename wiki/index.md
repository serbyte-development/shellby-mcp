# ChatGPT Local Shell MCP Wiki

Maintainer-oriented architecture documentation. Start with [[pages/Architecture Map]].

## Runtime Architecture

- [[pages/Architecture Map]] — system layers, dependency direction, and the request lifecycle.
- [[pages/HTTP Transport]] — Express, Streamable HTTP, host validation, and connection lifecycle.
- [[pages/MCP Tool Surface]] — schemas, annotations, instructions, and error behavior for seven core tools and eleven stable Peekaboo Computer Use tools.
- [[pages/Persistent Shell Runtime]] — process lifecycle, marker protocol, retained state, reset, and recovery.
- [[pages/Transcript Polling and Idempotency]] — output buffering, UTF-8 caps, cursors, retries, and concurrency.
- [[pages/Workspace Tooling]] — default workspace and the optional `apply_patch` integration.

## Development

- [[pages/Configuration and Startup]] — environment parsing, startup composition, shutdown, and tunnel helper.
- [[pages/Build and Test]] — compiler boundary, scripts, test architecture, and current validation gaps.
- [[pages/Open Questions and Risks]] — unresolved design risks, disconnected conventions, and staleness watch.

## Reference Research

- [[pages/Host Application Binary Reuse]] — concise boundary for the two host executable integrations used by the finished server.
- [[pages/Bundled MCP and Agent Surfaces]] — historical ChatGPT/Codex capability research that is not part of the runtime.

## Repository Conventions

- [[ops/Secret Handling]] — secret hygiene and the current zero-credential server configuration.
- [[raw/source-manifest]] — ingested evidence and known stale claims.
- [[raw/Host App Binary Survey 2026-07-20]] — maintainer-workstation evidence for reusable executables bundled in installed applications.
- [[raw/ChatGPT and Local Capability Survey 2026-08-01]] — verified child MCP schemas, Codex protocol surfaces, bundled utilities, other app CLIs, and macOS-native capabilities.
- [[log]] — append-only wiki maintenance history.
