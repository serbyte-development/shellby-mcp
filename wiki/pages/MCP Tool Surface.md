# MCP Tool Surface

Verified 2026-08-04.

## What This Is

`src/mcp-server.ts` always exposes seven core tools over a shared `ShellSessionManager` and eleven focused Computer Use tools over one shared `PeekabooClient`. Tool metadata remains stable even if the local `peekaboo` executable or macOS permissions are unavailable (`src/mcp-server.ts`, `src/http-server.ts`, `src/computer-use-tools.ts`).

## Tools

### `fetch_website`

- Is the model's first-choice tool for reading, inspecting, summarizing, or extracting content from a known HTTP or HTTPS URL.
- Returns cleaned Markdown by default, cleaned main-content HTML with `clean_html`, or complete rendered page source with `raw_html`.
- Returns the final URL, title, selected format, bounded UTF-8 content chunks, and an opaque cursor that reads the cached document without fetching the page again.
- Requires cursor continuation calls to reuse the same URL and format.
- Retains at most twenty fetched documents for ten minutes by default, with a 2 MiB ceiling per document (`src/web-open.ts`, `src/mcp-server.ts`, `test/web-open.test.ts`, `test/mcp-integration.test.ts`).
- Directs models away from `shell_run`, Python, `curl`, `wget`, and browser automation unless fetching fails or authentication or interaction is required (`src/mcp-server.ts`, `test/mcp-integration.test.ts`).

### `apply_patch`

- Accepts a named `shell_id`, Codex-format patch, optional absolute project `cwd`, and bounded response output.
- Generates its own internal request ID and drains the operation to completion, so callers do not poll it.
- Runs the prepared absolute `apply_patch` executable through the selected shell, independent of later `PATH` mutations; it therefore shares serialization and logging only with that shell.
- Separately reports output discarded by the command-capture ceiling and retained output omitted by the response cap.
- Is preferred over Python string replacement, `sed`, and manual edit heredocs (`src/mcp-server.ts`, `src/shell-session.ts`, `src/workspace-tools.ts`).

### `shell_run`

- Required inputs: `request_id` and `command`; `shell_id` is optional and defaults to `default`.
- `shell_id` accepts 1–64 characters. Stable IDs retain shell state, and different IDs can execute concurrently.
- `request_id` accepts any nonempty string up to 128 characters; six lowercase alphanumeric characters are recommended, not enforced.
- `command` accepts up to 262,144 characters.
- `wait_ms` defaults to 1,500 and is schema-limited to 0–10,000.
- `max_output_bytes` defaults from runtime configuration and is schema-limited from 256 to the configured maximum.
- Annotations mark the tool destructive, state-changing, and open-world (`src/mcp-server.ts`).

### `shell_poll`

Reads output for an existing command from `next_cursor`. It must receive the same `shell_id` as the original run. The runtime rejects cursors before that command's start, and completed reads are bounded at its terminal cursor, preventing polls from consuming earlier or later command output (`src/mcp-server.ts`, `src/shell-session.ts`, `test/shell-session.test.ts`).

### `shell_reset`

Resets the selected shell generation, including the protected `default` shell, while preserving the shell slot.

Kills the selected shell's process group, discards only that shell's state, starts a new generation, and deduplicates retries by `request_id` plus reason inside that shell. It is destructive and idempotent for an exact retry (`src/mcp-server.ts`, `src/shell-session.ts`).

### `shell_list`

Returns currently open shells with activity state, idle duration, close eligibility, total count, configured limit, and idle timeout. Listing does not refresh idle timers.

### `shell_close`

Terminates a selected non-default shell, discards its state and retained records, and releases its slot immediately. The `default` shell cannot be closed; use `shell_reset` to recover it.

## Computer Use Tools

### `computer_list`

Lists apps, an app's windows, connected screens, or Peekaboo permission status. Window listing requires `app`; app-only inclusion flags are rejected for other list kinds.

### `computer_observe`

Observes exactly one app, window ID, or display index, or the frontmost window by default. Peekaboo captures a temporary PNG, then the server encodes it as a same-dimension quality-75 JPEG before returning it with a fresh `snapshot_id` and essential target metadata. The response deliberately omits accessibility elements. Keeping image dimensions unchanged preserves screenshot-relative coordinates while reducing tunneled and model-context payloads. `--no-web-focus` keeps observation from pressing web content while collecting state (`src/computer-use-tools.ts`, `src/peekaboo.ts`, `test/mcp-integration.test.ts`).

### `computer_inspect`

Uses Peekaboo's `inspect-ui` command against an explicit observation snapshot and returns only its accessibility-tree text, without duplicating Peekaboo's structured content envelope. Depth, total elements, and children per node are independently bounded and default to 8, 100, and 25. It is the opt-in fallback when the screenshot cannot support a reliable visual action (`src/computer-use-tools.ts`, `test/mcp-integration.test.ts`).

### `computer_click`

Requires an explicit `snapshot_id` plus exactly one element ID, text query, or coordinate pair. Coordinate clicks use the capture target retained for that snapshot. Display-local coordinates are translated through the display origin and sent as global coordinates; window/app coordinates remain relative to their captured target.

### `computer_type`, `computer_press`, and `computer_hotkey`

Type literal text, press sequential key tokens, or press a simultaneous shortcut. They can target an app, window ID, or snapshot and remain separate so sequence and chord semantics are unambiguous.

### `computer_scroll`

Scrolls up, down, left, or right at the pointer or over an observed element. Element targeting requires the matching snapshot.

### `computer_drag`

Requires a snapshot and drags between element IDs, screenshot-relative coordinates, or an application destination. Coordinates are translated from the observation bounds before invoking Peekaboo.

### `computer_app`

Launches, switches to, quits, relaunches, hides, or unhides an application. Launch/relaunch wait for readiness; switch verifies focus. Force is accepted only for quit/relaunch, and files or URLs may be opened only during launch.

### `computer_window`

Focuses, closes, minimizes, maximizes, moves, resizes, or sets bounds for one app- or window-ID-anchored window. Geometry requirements are enforced by action, and exact window IDs come from `computer_list` with `kind=windows`.

The server intentionally exposes these eleven operations instead of a raw Peekaboo proxy. Advanced Peekaboo commands remain available through `shell_run`. All first-class operations share one serial queue because observation snapshots and UI actions are stateful (`src/computer-use-tools.ts`, `src/peekaboo.ts`).

## Result and Error Shape

Run and poll always return status, nullable exit code, and output. They echo `shell_id` only for non-default shells, add request ID and next cursor only when polling may be needed, `has_more` only when unread retained output exists, and cursor/truncation diagnostics only when exceptional. This server targets ChatGPT web only, so the human-readable content block deliberately remains a compact status summary while command output lives only in `structuredContent`, avoiding duplicated model context (`src/mcp-server.ts`, `README.md`).

Known `ShellSessionError` codes are converted into MCP tool errors. Unexpected errors become `internal_error`; tool handlers do not throw them through the transport (`src/mcp-server.ts`, `src/shell-session.ts`).

Every CLI call uses `execFile` with exact argv and an added `--json`; model input never passes through a shell. A zero exit with `{success:false}` is still an error, malformed/oversized/process failures become stable `PeekabooError` results, and a missing binary reports `PEEKABOO_NOT_FOUND`. Results preserve compact `data` and a short summary while omitting Peekaboo debug logs. Observation results additionally return an MCP image block. Calls are serialized, bounded, cancellation-aware, and never retried because an action may already have happened (`src/peekaboo.ts`, `src/computer-use-tools.ts`, `test/peekaboo.test.ts`).

## Published Instructions

The server tells clients to conserve output, prefer RTK when appropriate, use native `apply_patch`, keep new work under the configured workspace, reuse stable shell IDs, poll with the original shell ID, and serialize foreground commands within each shell. It also documents the supported noninteractive Codex sub-agent workflow and tells clients to use visual-first observation, call bounded `computer_inspect` only when needed, refresh after UI changes, and use raw Peekaboo through `shell_run` only for advanced operations outside the focused schemas. These instructions remain advisory except where schemas or the runtime impose limits (`src/mcp-server.ts`).

## Related

- [[pages/HTTP Transport]]
- [[pages/Persistent Shell Runtime]]
- [[pages/Transcript Polling and Idempotency]]
- [[pages/Workspace Tooling]]
- [[pages/Bundled MCP and Agent Surfaces]]
