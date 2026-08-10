# Source Manifest

## Ingested Sources

### `README.md`

- Role: public project overview, installation, remote/local connection model, tool inventory, and concise configuration reference.
- Reliability: maintained public-facing documentation; current code and tests still outrank it on implementation details.
- Verified against code: 2026-08-10.
- Feeds: [[pages/Architecture Map]], [[pages/MCP Tool Surface]], [[pages/Persistent Shell Runtime]], [[pages/Workspace Tooling]], [[pages/Configuration and Startup]], and [[pages/Open Questions and Risks]].

#### Staleness / conflict notes

- Rewritten on 2026-08-10 after the MCP v2/auth migration. It now describes the ngrok ChatGPT-source trust boundary, bound OpenAI subject, current PM2 commands, browser subagents, and modular MCP v2 packages at a public-user level (`src/auth/auth.ts`, `src/server/http-server.ts`, `package.json`, `ecosystem.config.cjs`).
- Removed the maintainer-specific ngrok domain from the README and executable tunnel configuration. ngrok now assigns the user's public URL unless optional `NGROK_URL` supplies their own fixed domain (`README.md`, `package.json`, `ecosystem.config.cjs`).

### Maintainer workstation app-bundle survey, 2026-07-20

- Role: direct inspection of executable files and CLI behavior inside installed macOS application bundles, plus inspection of the local standalone Codex web-search experiment.
- Reliability: point-in-time host evidence. Bundle contents and private interfaces can change with application updates.
- Stored as: [[raw/Host App Binary Survey 2026-07-20]].
- Feeds: [[pages/Workspace Tooling]].
- Secret handling: no tokens or credential values were captured; only executable paths, environment variable names, command surfaces, and authentication boundaries were recorded.

### ChatGPT and local capability survey, 2026-08-01

- Role: direct inspection of current ChatGPT/Codex command surfaces, MCP initialization and `tools/list`, generated experimental app-server schemas, installed application CLI presence, and macOS-native commands.
- Reliability: point-in-time host evidence. Child MCP schemas, experimental protocols, app-bundle locations, and private interfaces can change on application updates.
- Stored as: [[raw/ChatGPT and Local Capability Survey 2026-08-01]].
- Feeds: [[pages/Architecture Map]] and [[pages/Open Questions and Risks]].
- Secret handling: no tokens, credential values, messages, screenshots, accessibility trees, recordings, history artifacts, or account data were read or stored.
- Staleness note: its ChatGPT Computer Use child-MCP inventory remains historical evidence, but that child is not used by the current server. Direct Peekaboo integration supersedes the survey's Computer Use implementation direction (`src/index.ts`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

### Peekaboo CLI documentation and installed help, 2026-08-01

- Role: supported CLI contracts for installation, permissions, observation, app/window actions, and JSON output.
- Sources: `https://peekaboo.sh/cli-command-reference.html`, `https://peekaboo.sh/permissions.html`, `https://peekaboo.sh/commands/see.html`, and local `peekaboo --help` / subcommand help.
- Reliability: public upstream documentation plus point-in-time installed CLI help; flags and JSON shapes can change with Peekaboo upgrades.
- Feeds: [[pages/Architecture Map]], [[pages/MCP Tool Surface]], [[pages/Configuration and Startup]], and [[pages/Open Questions and Risks]].
- Secret handling: permission status may expose local host/process metadata, so no raw status output or screenshots are stored in the wiki.

## Verification Evidence

These are current implementation evidence, not copied raw notes:

- Startup and configuration: `src/index.ts`, `package.json`, `tsconfig.json`.
- HTTP boundary: `src/server/http-server.ts`, `test/mcp-integration.test.ts`.
- Tool contracts and model instructions: `src/server/mcp-server.ts`, `test/mcp-integration.test.ts`.
- Peekaboo invocation, snapshots, coordinate mapping, and focused Computer Use schemas: `src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`, `test/peekaboo.test.ts`, `test/mcp-integration.test.ts`.
- Shell, transcript, idempotency, and reset behavior: `src/tools/shell/session.ts`, `test/shell-session.test.ts`.
- Named-shell lifecycle: `src/tools/shell/session-manager.ts`, `test/shell-session-manager.test.ts`.
- Workspace path resolution: `src/config.ts`, `test/config.test.ts`.
- First-class `apply_patch` runtime and vendored binary: `src/tools/apply-patch/apply-patch.ts`, `vendor/apply-patch/`, `test/mcp-integration.test.ts`.
- Webpage extraction and cached pagination: `src/tools/web/web-open.ts`, `test/web-open.test.ts`, `test/mcp-integration.test.ts`.
- Tunnel helper: `ngrok-traffic-policy.yml`, `package.json`.
- Change tripwire: current implementation through commit `d00978c` (`Refresh wiki and align subagent polling`).

### OpenAI ChatGPT MCP identity metadata, 2026-08-09

- Role: OpenAI developer documentation plus direct inspection of live ChatGPT-to-MCP requests for identity metadata available to remote servers.
- Reliability: OpenAI documentation defines the intended semantics; live request shape is point-in-time behavior and may change.
- Observed: `X-OpenAI-Subject` and `X-OpenAI-Session` were present as HTTP headers; `openai/subject`, `openai/session`, and `openai/organization` were present in MCP tool-call `_meta`. Subject stayed stable across sampled conversations while session changed. Actual identifier values were not stored in the wiki.
- OpenAI semantics: subject is an anonymized user ID for rate limiting and identification; session is an anonymized conversation ID; organization is an anonymized organization ID when available.
- Feeds: [[pages/HTTP Transport]].
