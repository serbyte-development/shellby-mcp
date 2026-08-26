# ChatGPT and Local Capability Survey 2026-08-01

## Scope

Point-in-time inspection of structured MCP servers, agent protocols, reusable utilities, installed application CLIs, and macOS-native command surfaces available on the maintainer workstation.

No GUI action, message read, message send, recording, computer-history read, account mutation, login change, plugin installation, or remote-control operation was performed. Inspection was limited to executable presence, `--help`, generated schemas, MCP initialization, and `tools/list`.

## ChatGPT/Codex Executables

Verified present:

- `/Applications/ChatGPT.app/Contents/Resources/codex`
- `/Applications/ChatGPT.app/Contents/Resources/codex_chronicle`
- `/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host`
- `/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/bin/computer-use-client-launcher`
- `/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/latex/bin/tectonic`
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/cli.js`

The current Codex help advertises `exec`, `review`, authentication commands, MCP management, `mcp-server`, experimental `app-server`, remote control, desktop-app launch, completion, update, doctor, sandbox, debug, patch application, session resume/archive/delete/unarchive/fork, cloud tasks, experimental `exec-server`, and feature inspection. `--search` enables the native Responses `web_search` tool for the model.

## MCP Tool Discovery

The repository's installed `@modelcontextprotocol/sdk` client initialized each child over stdio and called `tools/list`.

### Computer Use

Command:

```text
computer-use-client-launcher mcp
```

Tools:

```text
list_apps
get_app_state
click
perform_secondary_action
set_value
select_text
scroll
drag
press_key
type_text
```

`get_app_state` advertises a screenshot and accessibility tree. Interaction tools accept accessibility indexes or screen coordinates depending on the action.

### Messages

Command:

```text
computer-use-client-launcher messages mcp
```

Tools:

```text
find_chats
read_messages
search_messages
send_message
```

The descriptions advertise stable chat GUIDs, participant/date filtering, text search, local attachments, direct chats, and exact-participant group chats.

### Record & Replay Event Stream

Command:

```text
computer-use-client-launcher event-stream mcp
```

Tools:

```text
event_stream_start
event_stream_status
event_stream_stop
```

The start tool advertises recording user actions for up to 30 minutes. Status and stop return metadata and event paths.

### Computer History

Command:

```text
computer-use-client-launcher computer-history mcp
```

Tools:

```text
computer_history_pause
computer_history_resume
computer_history_status
computer_history_get_settings
computer_history_update_settings
```

The update tool explicitly requires reading and preserving unchanged settings first.

### Codex MCP

Command:

```text
codex mcp-server
```

Tools:

```text
codex
codex-reply
```

The first starts a configured Codex session. The second continues a conversation by thread ID and prompt.

## Codex App Server

`codex app-server --help` verified:

- Default stdio transport.
- Unix socket, explicit Unix path, WebSocket, and disabled transports.
- Capability-token and signed-bearer-token WebSocket authentication modes.
- TypeScript binding and JSON Schema generation.
- Optional connection to a remote Code Mode host.

An experimental JSON Schema bundle was generated to a temporary directory and removed after inspection. It contained request, response, and notification types for thread and turn lifecycle, reviews, commands, processes, filesystem operations, MCP servers, models, configuration, skills, plugins, permissions, environments, hooks, account state, usage, rate limits, remote control, realtime input/output, and approvals.

## Other ChatGPT Components

- `codex sandbox` supports named permission profiles, working-directory selection, readable-root additions, direct-network disablement, Unix-socket allowlists, managed configuration, and sandbox-denial logging.
- `codex-code-mode-host` supports stdio and WebSocket listeners.
- `codex_chronicle` describes itself as capturing sparse screen-memory frames and accepts a storage root plus an optional connector flag.
- The bundle contains Playwright, Pixelmatch, Tesseract.js, PDF.js, a Tectonic LaTeX compiler, and site-building/packaging scripts.

## Other Installed Application Surfaces

Verified present during this survey:

- Craft Agents document-tool directory at `/Applications/Craft Agents.app/Contents/Resources/app/dist/resources/bin`.
- LM Studio CLI at `/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms`.
- Screen Studio utility directory at `/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin`.
- VS Code CLI at `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`.
- Screaming Frog launcher at `/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher`.

Prior inspection recorded Craft PDF/DOCX/XLSX/PPTX/image/iCal/Markdown/diff tools, LM Studio model control, Screen Studio FFmpeg/Whisper/window/media helpers, VS Code `rg` and indexed `tgrep`, Screaming Frog headless crawling, Docker, GIMP, browsers, BBEdit, and Cursor. See [Host App Binary Survey 2026-07-20](./host-app-binary-survey-2026-07-20.md).

## macOS-Native Surfaces

Verified available:

```text
/usr/bin/shortcuts
/usr/bin/mdfind
/usr/bin/mdls
/System/Cryptexes/App/usr/bin/safaridriver
/usr/bin/sips
/usr/bin/textutil
/usr/bin/qlmanage
/usr/sbin/screencapture
```

These support Shortcut execution, Spotlight search and metadata, Safari WebDriver, image conversion, document conversion, Quick Look rendering, screenshots, and screen recording. Small Swift CLIs could also expose Vision, PDFKit, ScreenCaptureKit, Accessibility, Speech, NaturalLanguage, AVFoundation, CoreImage, and CoreGraphics without depending on private application internals.

## Reliability and Secret Handling

- This is host evidence, not a promise of stable public interfaces.
- Private or experimental paths may change on any application update.
- No credential values, tokens, message contents, screenshots, accessibility trees, history artifacts, or account data were captured.
- The standalone `web_search` experiment reuses Codex authentication through a custom Rust client and should be treated as an extracted internal client, not an officially supported CLI.
