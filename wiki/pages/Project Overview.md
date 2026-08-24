# Project Overview

Verified 2026-08-18.

## What This Is

Shellby MCP is a macOS local MCP harness that lets ChatGPT Web operate a developer's computer through persistent shells, direct file editing, webpage retrieval, focused Computer Use, dynamic skills, and browser-backed parallel agents while runtime state and tool execution remain on the local machine (`README.md`, `package.json`, `src/index.ts`).

## Who It Serves and Why

The project is for software engineers who want ChatGPT Web to perform sustained repository work with local state instead of treating every MCP request as an isolated command. It deliberately exposes the current macOS user's authority and is not intended as a sandbox, hosted multi-user service, or non-technical consumer application (`README.md`, `src/config.ts`, `src/server/http-server.ts`).

The current release supports macOS arm64 and Intel x64 with Node.js 22.13.0 or newer. The repository is the distribution and maintenance boundary (`package.json`, `.github/workflows/ci.yml`).

## Project-Wide Boundaries

- Repository code, tests, and configuration are implementation authority; README and raw surveys are supporting evidence.
- Tool execution uses the current macOS user's authority. Runtime limits are resource controls, not a filesystem or process sandbox (`src/tools/`).
- The product is a local MCP harness, not a hosted relay or multi-user service. Remote transport and ownership are documented in [HTTP Transport](./HTTP%20Transport.md).
- Setup and managed process lifecycle live in [Configuration and Startup](./Configuration%20and%20Startup.md); published capabilities live in [MCP Tool Surface](./MCP%20Tool%20Surface.md); component boundaries live in [Architecture Map](./Architecture%20Map.md).
- Roadmap and evaluation pages are explicitly noncommittal. Deferred experiments remain documentation or Git history rather than dormant production code.

## Current Status

The core local runtime, managed startup, remote ownership boundary, tool surface, macOS CI, and browser-agent lifecycle are implemented. Drift-prone external boundaries are tracked in [Open Questions and Risks](./Open%20Questions%20and%20Risks.md).

## Related

- [Architecture Map](./Architecture%20Map.md)
- [Configuration and Startup](./Configuration%20and%20Startup.md)
- [MCP Tool Surface](./MCP%20Tool%20Surface.md)
- [Build and Test](./Build%20and%20Test.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
- [ROADMAP](./ROADMAP.md)
