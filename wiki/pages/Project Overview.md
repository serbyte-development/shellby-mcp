# Project Overview

Verified 2026-08-15.

## What This Is

Unhinged Agent is a macOS local MCP harness that lets ChatGPT Web operate a developer's computer through persistent shells, direct file editing, webpage retrieval, focused Computer Use, dynamic skills, and browser-backed parallel agents while runtime state and tool execution remain on the local machine (`README.md`, `package.json`, `src/index.ts`).

## Who It Serves and Why

The project is for software engineers who want ChatGPT Web to perform sustained repository work with local state instead of treating every MCP request as an isolated command. It deliberately exposes the current macOS user's authority and is not intended as a sandbox, hosted multi-user service, or non-technical consumer application (`README.md`, `src/config.ts`, `src/server/http-server.ts`).

The current release supports macOS arm64 and Intel x64 with Node.js 22.13.0 or newer. The repository is the distribution and maintenance boundary (`package.json`, `.github/workflows/ci.yml`).

## Primary Workflow

1. `npm run setup` verifies prerequisites, initializes the configured workspace without overwriting an existing workspace `AGENTS.md`, builds the server, checks optional Peekaboo permissions, and prepares a dedicated ChatGPT Chrome profile when available (`scripts/setup.mjs`, `scripts/workspace-setup.mjs`, `scripts/chatgpt-browser.mjs`).
2. `npm start` runs preflight and build, starts or reloads the MCP server and ngrok through the repository-local PM2 dependency, ensures the dedicated browser is running when configured, waits for `/healthz`, and prints the public `/mcp` URL (`package.json`, `scripts/start.mjs`, `ecosystem.config.cjs`).
3. The ngrok traffic policy admits ChatGPT-origin traffic on exact `/mcp` and marks it as remote. The first marked `tools/call` binds the OpenAI subject; later marked tool calls require the same subject. Direct localhost MCP clients remain intentionally unauthenticated (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`, `src/auth/auth.ts`).
4. Each HTTP request gets a stateless MCP server and transport while process-level shells, browser agents, webpage cache, Computer Use adapter, authentication state, and audit logging preserve the useful runtime boundaries (`src/index.ts`, `src/server/http-server.ts`, `src/server/mcp-server.ts`).
5. The published tool surface provides persistent and parallel shell execution, `apply_patch`, webpage fetching, local image viewing, dynamic workspace skills, browser-backed ChatGPT delegation, and eleven focused Peekaboo-backed Computer Use tools (`src/server/mcp-server.ts`, `src/tools/`).

## System Boundaries and Conventions

- Repository code, tests, and configuration are implementation authority; README and raw surveys provide supporting intent and point-in-time evidence.
- `src/config.ts` owns static defaults, environment parsing, MCP metadata, and server instructions. Capability modules under `src/tools/` own their schemas, handlers, and domain errors (`src/config.ts`, `src/server/mcp-server.ts`).
- The production listener stays on `127.0.0.1:3333`; ngrok is the trusted remote-origin boundary. There is no hosted relay, database, login UI, MCP OAuth flow, secret URL, or general multi-user authorization system (`src/config.ts`, `src/server/http-server.ts`, `ngrok-traffic-policy.yml`).
- Shells, patching, browser delegation, webpage fetching, image viewing, and Computer Use run with the local user's operating-system permissions. Limits protect runtime memory, output, and concurrency; they do not create a filesystem or process sandbox (`src/tools/shell/`, `src/tools/apply-patch/apply-patch.ts`, `src/tools/web/web-open.ts`, `src/tools/image/`, `src/tools/computer/peekaboo.ts`).
- The iOS shell bridge remains implemented but intentionally unregistered. Roadmap and evaluation pages describe possible work, not committed product behavior (`src/tools/ios/ios-shell.ts`, `src/server/mcp-server.ts`).

## Current Status

The core runtime, remote ownership boundary, managed setup/start flow, 23-tool MCP surface, dual-architecture macOS CI, and dedicated browser-agent lifecycle are implemented. The most drift-prone surfaces are ChatGPT Web's private browser behavior, Peekaboo CLI contracts and macOS permissions, ngrok deployment assumptions, and model-facing tool metadata cached by ChatGPT (`.github/workflows/ci.yml`, `src/server/mcp-server.ts`, `src/tools/subagent/`, `src/tools/computer/`, `ngrok-traffic-policy.yml`).

## Related

- [[pages/Architecture Map]]
- [[pages/Configuration and Startup]]
- [[pages/MCP Tool Surface]]
- [[pages/Build and Test]]
- [[pages/Open Questions and Risks]]
- [[pages/ROADMAP]]
