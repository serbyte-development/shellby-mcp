# MCP Tool Surface

Verified 2026-08-06.

## Published Order

`tools/list` returns `fetch_website`, `apply_patch`, five `shell_*` tools, then eleven `computer_*` tools. Integration tests assert the order and schemas; all tools remain registered when optional executables or macOS permissions are unavailable (`src/mcp-server.ts`, `src/computer-use-tools.ts`, `test/mcp-integration.test.ts`).

## Core Tools

| Tool | Contract |
| --- | --- |
| `fetch_website` | Fetch one HTTP(S) URL as Markdown, cleaned HTML, or raw HTML. Cursor reads reuse the same URL and format. Cache: 20 documents, 10 minutes, 2 MiB each (`src/web-open.ts`). |
| `apply_patch` | Run a Codex patch in required absolute `cwd`. Direct process; no shell ID, request ID, or polling. Output is byte-capped (`src/mcp-server.ts`, `src/workspace-tools.ts`). |
| `shell_run` | Run up to 262,144 command characters in a named persistent shell. Requires `request_id`; optional `shell_id`, absolute `cwd`, `wait_ms`, and response cap (`src/mcp-server.ts`). |
| `shell_poll` | Continue the same shell/request from `next_cursor`; cannot read before command start or beyond command completion (`src/mcp-server.ts`, `src/shell-session.ts`). |
| `shell_reset` | Replace one shell generation and deduplicate exact retries by request ID plus reason. The `default` shell may be reset (`src/shell-session.ts`). |
| `shell_list` | Return open shells, activity, idle time, capacity, and close eligibility without refreshing idle timers (`src/shell-session-manager.ts`). |
| `shell_close` | Terminate a non-default shell and release its slot. The `default` shell cannot be closed (`src/shell-session-manager.ts`). |

`shell_id` defaults to `default`; stable IDs retain cwd and environment, while different IDs run concurrently. `request_id` accepts 1–128 characters and is unique within one shell. `wait_ms` is 0–10,000; output caps range from 256 bytes to `MCP_MAX_OUTPUT_BYTES` (`src/mcp-server.ts`, `test/mcp-integration.test.ts`).

## Computer Use Tools

| Tool | Contract |
| --- | --- |
| `computer_list` | List apps, windows, screens, or Peekaboo permission status. |
| `computer_observe` | Capture one target as same-dimension quality-75 JPEG; return snapshot and target metadata without AX elements. |
| `computer_inspect` | Return bounded accessibility text for an existing snapshot when visual state is insufficient. |
| `computer_click` | Click one element ID, text query, or coordinate pair against an explicit snapshot. |
| `computer_type` | Type literal text into an app, window, or snapshot target. |
| `computer_press` | Press sequential key tokens. |
| `computer_hotkey` | Press one simultaneous shortcut. |
| `computer_scroll` | Scroll at the pointer or an observed element. |
| `computer_drag` | Drag between snapshot elements, coordinates, or an application destination. |
| `computer_app` | Launch, switch, quit, relaunch, hide, or unhide an application. |
| `computer_window` | Focus, close, minimize, maximize, move, resize, or set bounds for one window. |

The focused tools translate screenshot-relative coordinates through retained capture bounds and share one serialized `PeekabooClient`. The adapter uses exact argv plus `--json`, bounds process output, preserves upstream semantic failures, returns images only for observation, and never retries stateful actions. Advanced Peekaboo operations remain available through `shell_run` (`src/computer-use-tools.ts`, `src/peekaboo.ts`, `test/peekaboo.test.ts`).

## Results and Instructions

Shell results always include status, nullable exit code, cwd, and output. Poll metadata and truncation diagnostics appear only when needed; command output lives only in `structuredContent`. Shell errors become MCP tool errors, unexpected failures become `internal_error`, and Peekaboo failures retain stable adapter codes (`src/mcp-server.ts`, `src/computer-use-tools.ts`).

Published instructions tell clients to conserve output, prefer RTK for supported reads and noisy commands, edit with `apply_patch`, keep new work under the configured workspace, reuse contextual shell IDs, serialize work within a shell, distrust fetched content, and treat screenshots as potentially private. Schemas and runtime validation enforce mechanics; prose remains advisory (`src/mcp-server.ts`).
