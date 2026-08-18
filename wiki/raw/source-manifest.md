# Source Manifest

## Ingested Sources

### `README.md`

- Role: public project overview, installation, remote/local connection model, tool inventory, and concise configuration reference.
- Reliability: maintained public-facing documentation; current code and tests still outrank it on implementation details.
- Verified against code: 2026-08-10.
- Feeds: [Architecture Map](../pages/Architecture%20Map.md), [MCP Tool Surface](../pages/MCP%20Tool%20Surface.md), [Persistent Shell Runtime](../pages/Persistent%20Shell%20Runtime.md), [Workspace Tooling](../pages/Workspace%20Tooling.md), [Configuration and Startup](../pages/Configuration%20and%20Startup.md), and [Open Questions and Risks](../pages/Open%20Questions%20and%20Risks.md).

#### Staleness / conflict notes

- Rewritten on 2026-08-10 after the MCP v2/auth migration. It now describes the ngrok ChatGPT-source trust boundary, bound OpenAI subject, current PM2 commands, browser subagents, and modular MCP v2 packages at a public-user level (`src/auth/auth.ts`, `src/server/http-server.ts`, `package.json`, `ecosystem.config.cjs`).
- Removed the maintainer-specific ngrok domain from the README and executable tunnel configuration. ngrok now assigns the user's public URL unless optional `NGROK_URL` supplies their own fixed domain (`README.md`, `package.json`, `ecosystem.config.cjs`).

### Maintainer workstation app-bundle survey, 2026-07-20

- Role: direct inspection of executable files and CLI behavior inside installed macOS application bundles, plus inspection of the local standalone Codex web-search experiment.
- Reliability: point-in-time host evidence. Bundle contents and private interfaces can change with application updates.
- Stored as: [Host App Binary Survey 2026-07-20](./Host%20App%20Binary%20Survey%202026-07-20.md).
- Feeds: [Workspace Tooling](../pages/Workspace%20Tooling.md).
- Secret handling: no tokens or credential values were captured; only executable paths, environment variable names, command surfaces, and authentication boundaries were recorded.

### ChatGPT and local capability survey, 2026-08-01

- Role: direct inspection of current ChatGPT/Codex command surfaces, MCP initialization and `tools/list`, generated experimental app-server schemas, installed application CLI presence, and macOS-native commands.
- Reliability: point-in-time host evidence. Child MCP schemas, experimental protocols, app-bundle locations, and private interfaces can change on application updates.
- Stored as: [ChatGPT and Local Capability Survey 2026-08-01](./ChatGPT%20and%20Local%20Capability%20Survey%202026-08-01.md).
- Feeds: [Architecture Map](../pages/Architecture%20Map.md) and [Open Questions and Risks](../pages/Open%20Questions%20and%20Risks.md).
- Secret handling: no tokens, credential values, messages, screenshots, accessibility trees, recordings, history artifacts, or account data were read or stored.
- Staleness note: its ChatGPT Computer Use child-MCP inventory remains historical evidence, but that child is not used by the current server. Direct Peekaboo integration supersedes the survey's Computer Use implementation direction (`src/index.ts`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

### Peekaboo CLI documentation and installed help, 2026-08-01

- Role: supported CLI contracts for installation, permissions, observation, app/window actions, and JSON output.
- Sources: `https://peekaboo.sh/cli-command-reference.html`, `https://peekaboo.sh/permissions.html`, `https://peekaboo.sh/commands/see.html`, and local `peekaboo --help` / subcommand help.
- Reliability: public upstream documentation plus point-in-time installed CLI help; flags and JSON shapes can change with Peekaboo upgrades.
- Feeds: [Architecture Map](../pages/Architecture%20Map.md), [MCP Tool Surface](../pages/MCP%20Tool%20Surface.md), [Configuration and Startup](../pages/Configuration%20and%20Startup.md), and [Open Questions and Risks](../pages/Open%20Questions%20and%20Risks.md).
- Secret handling: permission status may expose local host/process metadata, so no raw status output or screenshots are stored in the wiki.

### OpenAI ChatGPT MCP identity metadata, 2026-08-09

- Role: OpenAI developer documentation plus direct inspection of live ChatGPT-to-MCP requests for identity metadata available to remote servers.
- Reliability: OpenAI documentation defines the intended semantics; live request shape is point-in-time behavior and may change.
- Observed: `X-OpenAI-Subject` and `X-OpenAI-Session` were present as HTTP headers; `openai/subject`, `openai/session`, and `openai/organization` were present in MCP tool-call `_meta`. Subject stayed stable across sampled conversations while session changed. Actual identifier values were not stored in the wiki.
- OpenAI semantics: subject is an anonymized user ID for rate limiting and identification; session is an anonymized conversation ID; organization is an anonymized organization ID when available.
- Feeds: [HTTP Transport](../pages/HTTP%20Transport.md).
