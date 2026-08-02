# MCP Tool Surface

Verified 2026-08-01.

## What This Is

`src/mcp-server.ts` always exposes seven core tools over a shared `ShellSessionManager`. When the installed ChatGPT Computer Use launcher is available and compatible, it also exposes six fixed wrappers over a shared `ComputerUseManager`.

## Tools

### `web_open`

- Renders an HTTP or HTTPS page with Cloak Browser and extracts its main content as Markdown through Defuddle.
- Returns bounded UTF-8 content chunks and an opaque cursor that reads the cached document without reopening the page.
- Retains at most twenty extracted documents for ten minutes by default, with a 2 MiB ceiling per document (`src/web-open.ts`, `src/mcp-server.ts`, `test/web-open.test.ts`, `test/mcp-integration.test.ts`).

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

### `computer_list_apps`

Forwards the child MCP's read-only `list_apps` tool. It lists running and recently used applications.

### `computer_get_app_state`

Forwards `get_app_state` and preserves its screenshot, accessibility tree, structured content, metadata, and error state. Clients are instructed to call it once per assistant turn before interacting with an app and to refresh state after UI changes.

### `computer_click`

Accepts either one accessibility `element_index` or an `x` and `y` screenshot coordinate pair. The parent schema rejects missing targets, partial coordinate pairs, and mixed element plus coordinate targeting before forwarding the call.

### `computer_type_text`

Types nonempty literal text in the selected app. It is non-idempotent and is never automatically retried after a child transport failure.

### `computer_scroll`

Scrolls a selected accessibility element up, down, left, or right by an optional positive number of pages.

### `computer_press_key`

Presses one key or key combination using the child helper's supported key syntax.

The parent intentionally does not expose a generic child-tool proxy. `perform_secondary_action`, `set_value`, `select_text`, and `drag` remain unavailable until separately reviewed and tested. All Computer Use calls share one persistent child process and one serial call queue because app state and UI actions are sequential. The bridge does not implement screenshots or macOS Accessibility itself (`src/computer-use-manager.ts`, `src/computer-use-tools.ts`).

## Result and Error Shape

Run and poll always return status, nullable exit code, and output. They echo `shell_id` only for non-default shells, add request ID and next cursor only when polling may be needed, `has_more` only when unread retained output exists, and cursor/truncation diagnostics only when exceptional. This server targets ChatGPT web only, so the human-readable content block deliberately remains a compact status summary while command output lives only in `structuredContent`, avoiding duplicated model context (`src/mcp-server.ts`, `README.md`).

Known `ShellSessionError` codes are converted into MCP tool errors. Unexpected errors become `internal_error`; tool handlers do not throw them through the transport (`src/mcp-server.ts`, `src/shell-session.ts`).

Computer Use results are forwarded as complete MCP results rather than flattened into text. A thrown child transport or startup failure becomes an MCP tool error. A child result with `isError: true` remains a child tool error. Errors `-1743` and `-10000: Sender process is not authenticated` receive an additional explanation that macOS denied or could not authenticate the host process. Mutating calls are not replayed after timeouts, cancellation, or child exit because the action may already have occurred (`src/computer-use-manager.ts`, `src/computer-use-tools.ts`).

## Published Instructions

The server tells clients to conserve output, prefer RTK when appropriate, use native `apply_patch`, keep new work under the configured workspace, reuse stable shell IDs, poll with the original shell ID, and serialize foreground commands within each shell. It also documents the supported noninteractive Codex sub-agent workflow: verify the separate CLI installation, start with `codex exec`, resume by explicit session ID, avoid `--ephemeral` when continuity is required, and avoid the full-screen TUI because the shell has no PTY. These instructions remain advisory except where schemas or the runtime impose limits (`src/mcp-server.ts`).

## Related

- [[pages/HTTP Transport]]
- [[pages/Persistent Shell Runtime]]
- [[pages/Transcript Polling and Idempotency]]
- [[pages/Workspace Tooling]]
- [[pages/Bundled MCP and Agent Surfaces]]
