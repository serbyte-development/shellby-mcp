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
- Staleness note: its ChatGPT Computer Use child-MCP inventory remains historical evidence, not the current integration contract. Shellby now starts its checked-in Peekaboo binary as a restricted child MCP through the generic provider and applies its public `computer_*` overlay in the parent (`vendor/peekaboo/provenance.json`, `src/server/child-mcp.ts`, `src/tools/computer/peekaboo-mcp.ts`).

### Peekaboo CLI documentation and vendored fork build, verified 2026-08-24

- Role: supported CLI contracts for installation, permissions, observation, app/window actions, and JSON output.
- Sources: `https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md`, `https://peekaboo.sh/cli-command-reference.html`, `https://peekaboo.sh/permissions.html`, `https://peekaboo.sh/commands/see.html`, and the Serbyte fork commit recorded in `vendor/peekaboo/provenance.json`.
- Reliability: public upstream documentation plus a reproducible, checked-in fork build; flags and JSON shapes can change when the vendored binary is refreshed.
- Feeds: [Architecture Map](../pages/Architecture%20Map.md), [MCP Tool Surface](../pages/MCP%20Tool%20Surface.md), [Configuration and Startup](../pages/Configuration%20and%20Startup.md), and [Open Questions and Risks](../pages/Open%20Questions%20and%20Risks.md).
- Secret handling: permission status may expose local host/process metadata, so no raw status output or screenshots are stored in the wiki.

### OpenAI ChatGPT MCP identity metadata, 2026-08-09

- Role: OpenAI developer documentation plus direct inspection of live ChatGPT-to-MCP requests for identity metadata available to remote servers.
- Reliability: OpenAI documentation defines the intended semantics; live request shape is point-in-time behavior and may change.
- Observed: `X-OpenAI-Subject` and `X-OpenAI-Session` were present as HTTP headers; `openai/subject`, `openai/session`, and `openai/organization` were present in MCP tool-call `_meta`. Subject stayed stable across sampled conversations while session changed. Actual identifier values were not stored in the wiki.
- OpenAI semantics: subject is an anonymized user ID for rate limiting and identification; session is an anonymized conversation ID; organization is an anonymized organization ID when available.
- Feeds: [HTTP Transport](../pages/HTTP%20Transport.md).

### ChatGPT Web CDP transport probe, 2026-08-20

- Role: direct live inspection of one authenticated ChatGPT Web generation through Playwright and raw Chrome DevTools Protocol network/WebSocket events, plus a browser DOM `MutationObserver`.
- Reliability: point-in-time evidence for private ChatGPT Web behavior. Endpoint names, WebSocket schemas, topic structure, DOM selectors, and event ordering may change without notice.
- Observed: `/backend-api/f/conversation` handed the turn to a WebSocket topic; that topic carried assistant deltas and explicit completion items including `message_stream_complete`, `[DONE]`, and a turn-level `done`. The broader `conversations` topic emitted `conversation-turn-complete`.
- Rate-limit evidence: the exploratory recovery reload caused `/backend-api/conversations` HTTP 429 responses and the visible conversation-history modal while sampled `stream_status` responses remained 200. Follow-up live canaries after removing application-level polling/reloads showed that ChatGPT's own frontend script also issues `stream_status` and history requests during normal first-turn navigation; one history request returned 429 while the application itself issued neither request class.
- Feeds: [ChatGPT CDP Transport](../pages/ChatGPT%20CDP%20Transport.md), [Browser ChatGPT Subagents](../pages/Browser%20ChatGPT%20Subagents.md), and [Subagent Completion](../pages/Subagent%20Completion.md).
- Secret handling: raw WebSocket frames contained authenticated tokens and account/conversation identifiers during the live probe. Those values are not stored in the wiki; only sanitized protocol shapes and behavior are retained.
