# Source Manifest

## Ingested Sources

### `README.md`

- Role: original project overview, runtime behavior, configuration reference, and user-facing setup notes.
- Reliability: useful design intent, but explicitly treated as potentially stale.
- Verified against code: 2026-08-01.
- Feeds: [[pages/Architecture Map]], [[pages/MCP Tool Surface]], [[pages/Persistent Shell Runtime]], [[pages/Transcript Polling and Idempotency]], [[pages/Workspace Tooling]], [[pages/Configuration and Startup]], and [[pages/Open Questions and Risks]].

#### Staleness / conflict notes

- Resolved in `README.md` on 2026-07-19: generated-tool paths are prompt conventions; startup does not create or validate the catalog structure (`src/mcp-server.ts`, `src/index.ts`).
- Resolved in `README.md` on 2026-07-19: transcript retention and cursors use JavaScript UTF-16 code-unit offsets, while response caps use UTF-8 bytes (`src/shell-session.ts`).
- Resolved in `README.md` on 2026-07-19: changing `PORT` also requires changing the checked-in tunnel script and ngrok Host rewrite (`src/index.ts`, `package.json`, `ngrok-traffic-policy.yml`).
- Resolved in `README.md` on 2026-07-19: process-group termination is best effort when signaling is denied (`src/shell-session.ts`).
- Resolved in `README.md` on 2026-07-19: an existing executable workspace `apply_patch` is reused without confirming its type or target (`src/workspace-tools.ts`).
- The fixed ngrok domain and ChatGPT settings/menu instructions describe a particular external setup. They are not server architecture, are not verified by this repository, and were not promoted into maintained pages except where the local tunnel script constrains development (`package.json`, `ngrok-traffic-policy.yml`).
- The README is current about the seven MCP tools, named shell manager, output polling and truncation, request deduplication, process-group reset, native `apply_patch`, webpage extraction, RTK guidance, and command-only logging; those claims are backed by `src/` and `test/`.

### Maintainer workstation app-bundle survey, 2026-07-20

- Role: direct inspection of executable files and CLI behavior inside installed macOS application bundles, plus inspection of the local standalone Codex web-search experiment.
- Reliability: point-in-time host evidence. Bundle contents and private interfaces can change with application updates.
- Stored as: [[raw/Host App Binary Survey 2026-07-20]].
- Feeds: [[pages/Host Application Binary Reuse]] and [[pages/Workspace Tooling]].
- Secret handling: no tokens or credential values were captured; only executable paths, environment variable names, command surfaces, and authentication boundaries were recorded.

### ChatGPT and local capability survey, 2026-08-01

- Role: direct inspection of current ChatGPT/Codex command surfaces, MCP initialization and `tools/list`, generated experimental app-server schemas, installed application CLI presence, and macOS-native commands.
- Reliability: point-in-time host evidence. Child MCP schemas, experimental protocols, app-bundle locations, and private interfaces can change on application updates.
- Stored as: [[raw/ChatGPT and Local Capability Survey 2026-08-01]].
- Feeds: [[pages/Bundled MCP and Agent Surfaces]], [[pages/Host Application Binary Reuse]], [[pages/Possible Features]], and [[pages/Open Questions and Risks]].
- Secret handling: no tokens, credential values, messages, screenshots, accessibility trees, recordings, history artifacts, or account data were read or stored.

## Verification Evidence

These are current implementation evidence, not copied raw notes:

- Startup and configuration: `src/index.ts`, `package.json`, `tsconfig.json`.
- HTTP boundary: `src/http-server.ts`, `test/mcp-integration.test.ts`.
- Tool contracts and model instructions: `src/mcp-server.ts`, `test/mcp-integration.test.ts`.
- Shell, transcript, idempotency, and reset behavior: `src/shell-session.ts`, `test/shell-session.test.ts`.
- Named-shell lifecycle: `src/shell-session-manager.ts`, `test/shell-session-manager.test.ts`.
- Workspace `apply_patch` integration: `src/workspace-tools.ts`, `test/workspace-tools.test.ts`.
- Webpage extraction and cached pagination: `src/web-open.ts`, `test/web-open.test.ts`, `test/mcp-integration.test.ts`.
- Tunnel helper: `ngrok-traffic-policy.yml`, `package.json`.
- Change tripwire: recent Git history through commit `9e289d8`.
