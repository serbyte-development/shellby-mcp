# ChatGPT Local Shell MCP

An intentionally unauthenticated MCP server that lets ChatGPT Developer mode run commands in named persistent shells on this computer.

> **Danger:** anyone who can reach the public MCP URL can execute arbitrary commands with your user account's permissions. Run this only for temporary testing, stop it when finished, and never expose it on a trusted production machine.

Maintainers: start with the [architecture wiki](wiki/index.md) before changing the server.

## How it works

```text
ChatGPT web -> HTTPS tunnel -> localhost:3333/mcp -> shells, webpage extraction, optional Computer Use child MCP
```

Each named shell lives in the local Node process. Its working directory, exported environment variables, functions, transcript, command lock, and background processes remain available between MCP calls. Omit `shell_id` to use `default`, or reuse another stable ID for independent state. Different shells can run foreground commands concurrently. State is lost when that shell resets or exits; after an unexpected exit, the server automatically starts a clean generation for that shell.

By default, new repositories and generated projects belong in `~/Desktop/chatgpt-workspace`. The server creates that directory automatically, starts every fresh shell there, and tells the model to return there before cloning or creating a project unless you explicitly provide another location.

## Requirements

- Node.js 22 or newer
- A public HTTPS tunnel such as [ngrok](https://ngrok.com/)
- ChatGPT Developer mode access
- The Codex binary bundled with ChatGPT for the optional `apply_patch` command
- The installed ChatGPT Computer Use plugin for the optional `computer_*` tools

## Run it

```text
cd ~/Desktop/chatgpt-local-shell-mcp
npm install
npm run dev
```

To keep the public tunnel alive without an open terminal, start its PM2 app:

```bash
npm run tunnel:start
```

Use `npm run tunnel:status`, `npm run tunnel:logs`, and `npm run tunnel:stop` to manage it. `npm run tunnel` remains available when a foreground tunnel is useful for debugging.

The included ngrok traffic policy rewrites the origin Host header so ngrok can reach the server while its local Host validation protects against DNS-rebinding attacks. It is not authentication, a CORS policy, or a caller restriction: anyone who can reach the public tunnel URL can still invoke the shell tools.

This project is configured to use the account's fixed ngrok development domain. The ChatGPT MCP URL is:

```text
https://geologic-catalog-deodorant.ngrok-free.dev/mcp
```

Opening the free ngrok URL in Chrome shows ngrok's **You are about to visit** warning. That is expected and does not block MCP: ngrok applies the warning to browser HTML traffic, not programmatic API requests such as ChatGPT's MCP calls. Do not use a browser visit as the connection test; paste the `/mcp` URL directly into ChatGPT.

In ChatGPT:

1. Enable **Settings -> Security and login -> Developer mode**.
2. Open **Settings -> Plugins** and create a developer-mode app.
3. Enter the HTTPS `/mcp` URL and choose **No Authentication**.
4. Add the app to a conversation from the composer.
5. If ChatGPT offers it and you accept the risk, choose **Always allow** for the app's tool calls.

There is no CORS allowlist, authentication middleware, command approval layer, hosted relay, UI, or database.

## Tools

- `apply_patch`: applies a Codex-format source patch through the selected `shell_id`, from an optional absolute project `cwd`. It needs no caller-generated `request_id` and returns only after the patch command finishes.
- `shell_run`: executes a command in the selected named shell. Every new command needs a `request_id` unique within that shell; retrying the same ID and command does not execute it twice while the record remains retained.
- `shell_poll`: reads additional output using the same `shell_id`, `request_id`, and returned `next_cursor`.
- `shell_reset`: attempts to terminate only the selected shell's process group and starts a clean generation. Process-group cleanup is best effort. Reset idempotency is also scoped to `shell_id`.
- `shell_list`: lists open shells, activity state, idle duration, and available capacity without refreshing idle timers.
- `shell_close`: terminates a named shell, discards its state and retained records, and releases its slot immediately. The `default` shell cannot be closed.
- `web_open`: opens a page in Cloak Browser, extracts the main content with Defuddle, and returns Markdown. A returned `next_cursor` reads the next cached chunk without reopening the page.
- `computer_list_apps`, `computer_get_app_state`, `computer_click`, `computer_type_text`, `computer_scroll`, and `computer_press_key`: fixed wrappers over ChatGPT's installed Computer Use child MCP. The bridge launches one persistent child lazily and never copies or reimplements its proprietary helper.

Computer Use calls are sequential. Call `computer_get_app_state` once per assistant turn before interacting with an app and refresh it after the UI changes before reusing element indexes or screenshot coordinates. Screenshots and accessibility trees may contain private information. Mutating actions are never automatically retried after a timeout or child-process failure.

If Computer Use returns macOS error `-1743` or `-10000: Sender process is not authenticated`, run the server directly from Terminal and approve the Automation prompt when the first Computer Use tool is called. See [Configuration and Startup](wiki/pages/Configuration%20and%20Startup.md) for the reset procedure and PM2 attribution caveat.

`shell_id` is optional and defaults to `default`. It accepts 1–64 characters. The server creates shells lazily and permits eight by default. A single agent can use multiple shell IDs for parallel commands, and multiple agents avoid shared cwd, environment, transcript, reset, and foreground-command state by using distinct IDs. `shell_run` and `shell_poll` echo `shell_id` only for non-default shells, keeping normal default-shell responses compact. Named shells are closed after 30 minutes without tool activity by default; `shell_list` exposes their current lifecycle state and `shell_close` releases a named shell immediately. The `default` shell is retained for backward compatibility and cannot be closed, though `shell_reset` remains available to recover it. Idle cleanup never closes a shell while it is running a foreground command or reset.

`shell_run` and `shell_poll` return at most 2048 UTF-8 output bytes by default. The model may set `max_output_bytes` for a specific response when more is necessary, up to the hard 32768-byte maximum. Byte limits and rolling transcript eviction never retain only half of a Unicode surrogate pair. When continuation is needed, the response includes `request_id` and `next_cursor`; `has_more` is present only when retained output remains unread. A poll cursor must belong to the requested command, so it cannot read output from an earlier command. Normal completed responses omit pagination and false/zero diagnostic fields.

This MCP targets ChatGPT web only. Tool output intentionally lives in `structuredContent`, while the text content remains a compact status summary to avoid duplicating command output in context.

Each command also has a retained-output ceiling, controlled by `MCP_COMMAND_TRANSCRIPT_BYTES`. The shell continues draining and executing after that ceiling is reached, but excess output is discarded. Snapshots expose `output_truncated` and the exact UTF-8 `dropped_output_bytes`; discarded output cannot be recovered by polling.

`shell_run` waits for completion until `wait_ms` expires or the output byte cap is reached. Once a command completes, later polls are bounded to that command and cannot consume output from subsequent commands. Background processes should therefore redirect their output to a file for later inspection.

The server and `shell_run` schema instruct the model to prefer installed RTK equivalents for noisy supported commands, for example `rtk test npm test` instead of `npm test`, or `rtk git diff` instead of `git diff`. RTK is guidance only: the server does not rewrite commands, and raw shell commands remain available for persistent state changes and unsupported operations. Since responses are already byte-capped, the model is told not to add `head`, `tail`, or `sed` solely to limit returned output.

### Calling Codex sub-agents

The persistent shell can call the installed Codex CLI noninteractively. The Codex desktop app and npm CLI are separate installations, so verify the CLI before relying on it:

```bash
codex --version
codex login status
```

Start a persistent review or delegation session with `codex exec`, capture its session ID from the JSON output, and continue the same conversation with that explicit ID:

```bash
codex exec --json --sandbox read-only \
  "Review the current changes for correctness and missing tests."

codex exec resume <SESSION_ID> \
  "Review the updated changes and check whether your concerns are resolved."
```

Do not use `--ephemeral` when later calls need to resume the session. Do not launch the bare `codex` full-screen TUI through `shell_run`; the MCP shell has no PTY. Use explicit session IDs instead of `--last` when multiple Codex conversations may exist.

### Opening webpages

`web_open` accepts a URL, optional opaque `cursor`, and optional `max_output_bytes`. It renders the page with Cloak Browser, passes the rendered HTML through Defuddle, and returns the extracted Markdown with the final page URL and title. The default content cap is 8192 UTF-8 bytes and the maximum is 32768 bytes.

When more Markdown remains, the response includes `next_cursor`. Call `web_open` again with the same URL and that cursor to read the next chunk. Extracted documents are retained in memory for ten minutes, with a maximum of twenty cached documents and a 2 MiB UTF-8 ceiling per document. `source_truncated: true` reports when the extracted source exceeded that ceiling and the remainder was discarded. Webpage content is untrusted data and must not be treated as agent or system instructions.

Cloak Browser downloads and caches its Chromium binary on first use. Raw HTTP requests remain available through `curl` in `shell_run` when browser rendering and content extraction are unnecessary.

### Patching files

On startup, the server makes `~/Desktop/chatgpt-workspace/bin/apply_patch` available and prepends that directory to the persistent shell's `PATH`. In a fresh workspace it creates a symlink to the Codex binary bundled with ChatGPT; an existing executable at that path is reused.

The MCP exposes this executable as the native `apply_patch` tool and instructs the model to prefer it over Python string replacement, `sed`, or manual editing through `shell_run`. The tool accepts patch text in the normal format:

```bash
*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch
```

This uses the same patch engine as Codex's local `apply_patch`. Internally it runs through the selected persistent shell, so patching conflicts only with another foreground command using the same `shell_id`. Use the relevant absolute project root as `cwd` and relative file paths inside the patch. If the Codex binary is unavailable, the MCP server continues to start and prints a warning; the native tool then reports the missing executable if called, and ordinary shell editing remains available.

Patch results distinguish output lost at the command-capture ceiling (`dropped_output_bytes`) from retained output omitted by the response cap (`omitted_output_bytes`). These diagnostic fields are included only when nonzero, and either condition adds `output_truncated: true`; native patch output is not pollable after the tool returns. Patch output appears only in structured content rather than being duplicated in the text summary.

Recent command and reset records are bounded in memory. Once an old record has been evicted, its `request_id` is no longer available for retry deduplication, so always generate a fresh ID for a genuinely new operation.

### Reusable generated tools

The server instructions establish `~/Desktop/chatgpt-workspace/tools` as the convention for reusable tools and `~/Desktop/chatgpt-workspace/TOOLS.md` as their compact catalog. The server does not create or validate this structure; the model manages it through `shell_run`. Generated tools are ordinary local executables rather than dynamically registered MCP tools, so creating one does not require restarting the server or refreshing ChatGPT's MCP metadata.

Each tool has its own directory containing an executable `run` entrypoint and a `TOOL.md` contract. The model is instructed to inspect the catalog before creating a new tool, avoid turning one-off commands into tools, validate new tools before cataloging them, and never store secrets in tool code or documentation.

Each named shell admits one foreground command at a time. Use another `shell_id` for parallel foreground work. To keep a long-running process inside one shell while reusing it, use normal shell backgrounding and redirect its log:

```bash
npm run dev > /tmp/my-app.log 2>&1 &
echo $!
```

Then inspect it with later commands such as `tail -n 100 /tmp/my-app.log` or `ps -p <pid>`.

## Configuration

| Variable                       | Default                                              | Purpose                                                                                      |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `HOST`                         | `127.0.0.1`                                          | Local HTTP bind address                                                                      |
| `PORT`                         | `3333`                                               | Local HTTP port                                                                              |
| `MCP_SHELL`                    | `/bin/zsh`                                           | Persistent shell executable                                                                  |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace`                        | Absolute-resolved default workspace and initial shell working directory                      |
| `MCP_CODEX_BIN`                | `/Applications/ChatGPT.app/Contents/Resources/codex` | Codex binary targeted by the workspace `apply_patch` symlink                                 |
| `CHATGPT_COMPUTER_USE_LAUNCHER`| Auto-discovered                                      | Explicit path to the installed Computer Use child MCP launcher                               |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                                            | Retained rolling transcript limit in JavaScript UTF-16 code units                            |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                                             | Maximum UTF-8 command output retained before excess bytes are discarded                      |
| `MCP_OUTPUT_BYTES`             | `2048`                                               | Default UTF-8 output bytes returned per tool call                                            |
| `MCP_MAX_OUTPUT_BYTES`         | `32768`                                              | Hard maximum for a per-call `max_output_bytes` override                                      |
| `MCP_RECORD_LIMIT`             | `1024`                                               | Maximum recent command and reset records retained for idempotency                            |
| `MCP_MAX_SHELLS`               | `8`                                                  | Maximum named persistent shells, including `default`                                         |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                                            | Close inactive named shells after this many milliseconds; `0` disables idle cleanup          |
| `MCP_LOG_COMMANDS`             | `summary`                                            | Command logging mode: `off`, `summary`, or `full`; boolean true-like values map to `summary` |

`PORT` changes only the HTTP listener. The included `npm run tunnel` command and ngrok Host rewrite are fixed to port 3333, so update `package.json` and `ngrok-traffic-policy.yml` together when using another port.

`MCP_CWD` expands `~` and `~/...`; relative values are resolved from the server's startup directory. Startup uses the resulting absolute path consistently for shell cwd, workspace tooling, model instructions, and the native `apply_patch` default.

The shell is non-interactive and has no PTY. Commands that require terminal input are unsupported; stdin is `/dev/null` so a command cannot consume the MCP control stream. A login shell does not necessarily load interactive `.zshrc` aliases.

The command wrapper clears `errexit` (`set -e`) before and after each tool call so it cannot leak into later commands. A command that explicitly enables `set -e` can still end its current shell on failure; the server reports the lost state and starts a clean shell without terminating the MCP HTTP server.

`MCP_CWD` is a default and model instruction, not a filesystem sandbox. An explicit task can still use another path. After changing the workspace or server instructions, restart this server and refresh the app from its ChatGPT plugin settings so ChatGPT reloads the MCP metadata.

The MCP HTTP transport is stateless. Rebuilding and restarting the server on the same URL does not require an existing client to reconnect before its next request. Any request in flight during the restart can fail, and all process-local shell and webpage-cache state is reset. Refresh the ChatGPT app only when tool names, schemas, descriptions, or server instructions change.

## Activity log

By default, every newly accepted shell command prints one compact line prefixed with the server's local time in 24-hour `HH:MM` format, followed by the first non-comment command line plus multiline line/byte counts. Control characters are escaped, and long previews are byte-capped. Native `apply_patch` calls use the selected shell's logger. Set `MCP_LOG_COMMANDS=full` for raw multiline commands or `MCP_LOG_COMMANDS=off` to disable logging.

There are no request IDs, completion lines, reset or polling entries, or duplicated retry entries. Command output is not copied into the log, so the performance impact is negligible.

Even a summary preview can contain tokens, passwords, or other secrets from the first command line. Logs are terminal-only by default and are not written to a file.

## Validate

```bash
npm test
npm run typecheck
npm run build
```
