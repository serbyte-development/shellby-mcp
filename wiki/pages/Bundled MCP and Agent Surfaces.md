# Bundled MCP and Agent Surfaces

Verified 2026-08-01.

## What This Is

This page records structured MCP and agent-control surfaces bundled with the installed ChatGPT/Codex application. They are point-in-time research, not current Computer Use dependencies. The active Computer Use implementation calls the supported Peekaboo CLI directly through ten focused tools (`src/peekaboo.ts`, `src/computer-use-tools.ts`, `src/mcp-server.ts`).

Point-in-time host evidence, executable paths, and inspection commands are stored in [[raw/ChatGPT and Local Capability Survey 2026-08-01]].

## Child MCP Servers

ChatGPT bundles a launcher at `/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/bin/computer-use-client-launcher`. Direct MCP initialization and `tools/list` produced four distinct servers:

| Server command         | Advertised tools                                                                                                                                    | Capability boundary                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `mcp`                  | `list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `set_value`, `select_text`, `scroll`, `drag`, `press_key`, `type_text`           | Screenshot and accessibility-tree inspection plus direct GUI interaction. |
| `messages mcp`         | `find_chats`, `read_messages`, `search_messages`, `send_message`                                                                                    | Native Messages history, search, attachments, and sending.                |
| `event-stream mcp`     | `event_stream_start`, `event_stream_status`, `event_stream_stop`                                                                                    | Structured Record & Replay capture for up to 30 minutes.                  |
| `computer-history mcp` | `computer_history_pause`, `computer_history_resume`, `computer_history_status`, `computer_history_get_settings`, `computer_history_update_settings` | Computer History recorder state and settings.                             |

The repository does not launch this Computer Use child MCP. Its authenticated host-process boundary made it unsuitable as a simple standalone backend, so current code uses Peekaboo through `execFile` instead. The survey remains useful for understanding the installed ChatGPT surfaces, but no launcher path or child schema participates in startup (`src/index.ts`, `src/http-server.ts`, `src/peekaboo.ts`).

## Codex MCP Server

`/Applications/ChatGPT.app/Contents/Resources/codex mcp-server` advertises:

- `codex`: start a Codex session with configuration parameters.
- `codex-reply`: continue a prior Codex conversation by thread ID.

This is a cleaner persistent delegation boundary than repeatedly wrapping `codex exec`, but it is much narrower than the app-server protocol. A future bridge should preserve thread IDs explicitly and must not imply that Codex sessions share state with this server's named shells.

## Codex App Server

`codex app-server` is an experimental, structured control plane with stdio, Unix-socket, and WebSocket transports. The installed binary can generate TypeScript bindings and JSON Schema for its exact protocol version.

The generated schema exposes broad categories including:

- Thread lifecycle, search, naming, resume, fork, archive, delete, compaction, rollback, and background terminals.
- Turn execution, steering, interruption, reviews, item events, output deltas, plans, and context compaction.
- Command and process execution, PTY resize, stdin writes, termination, and streamed output.
- Filesystem reads, writes, copies, removals, directory operations, metadata, and watches.
- Model, provider, skills, plugin, MCP-server, configuration, permission-profile, environment, and hook management.
- Account, usage, rate-limit, login, remote-control, realtime audio/text, feedback, and marketplace operations.

This is powerful enough to support a full Codex controller, but it is too broad to proxy wholesale. The MCP should expose a small allowlisted adapter around stable tasks such as thread start/resume, turn start/interrupt, streamed result collection, model listing, and review start. Account mutation, raw process execution, arbitrary filesystem mutation, remote control, plugin installation, and rate-limit-credit operations should remain unavailable unless deliberately designed and reviewed.

## Other ChatGPT/Codex Components

| Component               | Host path or command                                                                             | Potential MCP use                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex sandbox           | `codex sandbox`                                                                                  | A safer `sandbox_run` primitive using permission profiles, readable roots, optional network denial, Unix-socket allowlists, and denial logs. |
| Code Mode host          | `/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host`                              | Internal typed-tool runtime over stdio or WebSocket. Experimental and lower priority than app-server.                                        |
| Chronicle               | `/Applications/ChatGPT.app/Contents/Resources/codex_chronicle`                                   | Sparse screen-memory capture to a selected storage root. High privacy risk.                                                                  |
| Playwright              | ChatGPT's bundled Node installation                                                              | Browser screenshots, PDFs, code generation, traces, and deterministic browser workflows.                                                     |
| Pixelmatch              | Bundled Node package                                                                             | Screenshot comparison and visual-regression results.                                                                                         |
| Tesseract.js and PDF.js | Bundled Node packages                                                                            | Local OCR, PDF text extraction, and page rendering.                                                                                          |
| Tectonic                | `/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/latex/bin/tectonic` | LaTeX-to-PDF compilation, preferably using untrusted mode.                                                                                   |
| Sites scripts           | Bundled site-building and packaging scripts                                                      | Local scaffolding or packaging only; private hosting dependencies must not be assumed reusable.                                              |

The standalone workstation `web_search` command is a different pattern. It is a custom client built from Codex Rust crates and existing Codex authentication to call the internal `alpha/search` endpoint. It is not merely another executable copied out of the ChatGPT bundle. See [[pages/Host Application Binary Reuse]].

## Recommended Integration Order

1. Keep Peekaboo's ten-tool adapter aligned with its supported CLI and test snapshot/coordinate behavior after upgrades.
2. Add `sandbox_run` before expanding unrestricted execution capabilities.
3. Add a narrow Codex app-server client for persistent threads, turns, reviews, streaming, and model inspection.
4. Add Messages read tools separately from `send_message`; sending must require explicit user intent.
5. Add event recording and computer history only after retention, visibility, pause, and deletion behavior are designed.
6. Add deterministic utility adapters for Playwright, Pixelmatch, Tectonic, OCR, and PDF extraction.

## Safety Boundaries

- **GUI writes:** clicking, typing, dragging, keypresses, and value changes can trigger destructive actions. Read state and write actions should be separately exposed and annotated.
- **Messages:** message history is private data; sending text or attachments is an external side effect and must require explicit intent.
- **Recording:** event streams, screenshots, accessibility trees, window titles, and Chronicle artifacts can capture credentials, health data, private conversations, and client information. Recording should be disabled by default and visibly active.
- **App-server breadth:** do not turn a narrow adapter into a second unrestricted shell, filesystem, account, plugin, or remote-control API.
- **Authentication inheritance:** future child tools may inherit ChatGPT/Codex login. Peekaboo instead depends on macOS capture and input permissions granted to its active local source.
- **Version drift:** ChatGPT updates can alter bundled paths and protocols, while Peekaboo upgrades can alter CLI flags or JSON. Keep each adapter independently testable.
- **Redistribution:** invoke installed application components in place. Do not package third-party binaries without confirming licensing and support boundaries.

## Related

- [[pages/Host Application Binary Reuse]]
- [[pages/MCP Tool Surface]]
- [[pages/Workspace Tooling]]
- [[pages/Possible Features]]
- [[pages/Open Questions and Risks]]
- [[raw/ChatGPT and Local Capability Survey 2026-08-01]]
