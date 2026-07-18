# ChatGPT Local Shell MCP

An intentionally unauthenticated MCP server that lets ChatGPT Developer mode run commands in one persistent shell on this computer.

> **Danger:** anyone who can reach the public MCP URL can execute arbitrary commands with your user account's permissions. Run this only for temporary testing, stop it when finished, and never expose it on a trusted production machine.

## How it works

```text
ChatGPT web -> HTTPS tunnel -> localhost:3333/mcp -> persistent /bin/zsh
```

The shell lives in the local Node process. Its working directory, exported environment variables, functions, and background processes remain available between MCP calls. State is lost whenever the server or shell resets.

By default, new repositories and generated projects belong in `~/Desktop/chatgpt-workspace`. The server creates that directory automatically, starts every fresh shell there, and tells the model to return there before cloning or creating a project unless you explicitly provide another location.

## Requirements

- Node.js 22 or newer
- A public HTTPS tunnel such as [ngrok](https://ngrok.com/)
- ChatGPT Developer mode access
- The Codex binary bundled with ChatGPT for the optional `apply_patch` command

## Run it

```bash
cd ~/Desktop/chatgpt-local-shell-mcp
npm install
npm run dev
```

In a second terminal:

```bash
npm run tunnel
```

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

- `shell_run`: executes a command. Every new command needs a unique `request_id`; a short six-character lowercase alphanumeric value such as `a7k2q9` is recommended but not enforced. Retrying the same ID and command does not execute it twice while that request remains in recent history.
- `shell_poll`: reads additional output using `next_cursor`.
- `shell_reset`: kills the entire shell process group and starts a clean shell. Every new reset needs a unique `request_id`; retrying the same ID and reason returns the original reset result instead of resetting again.

`shell_run` and `shell_poll` return at most 4096 UTF-8 output bytes by default. The model may set `max_output_bytes` for a specific response when more is necessary, up to the hard 32768-byte maximum. Byte limits never split a UTF-8 character. Additional retained output is indicated by `has_more` and remains available through `shell_poll` until it leaves the rolling transcript.

`shell_run` waits for completion until `wait_ms` expires or the output byte cap is reached. Once a command completes, later polls are bounded to that command and cannot consume output from subsequent commands. Background processes should therefore redirect their output to a file for later inspection.

The server instructs the model to prefer installed RTK equivalents for noisy supported commands such as tests, builds, diffs, logs, searches, file reads, JSON, and package-manager output. RTK is guidance only: the server does not rewrite or wrap commands, and raw shell commands remain available for persistent state changes and unsupported operations.

### Patching files

On startup, the server creates `~/Desktop/chatgpt-workspace/bin/apply_patch` as a stable symlink to the Codex binary bundled with ChatGPT and prepends that directory to the persistent shell's `PATH`. The model is instructed to prefer it for manual source-file edits:

```bash
apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch
PATCH
```

This uses the same patch engine as Codex's local `apply_patch`, but it runs as a normal `shell_run` command rather than a native MCP tool. Run it from the relevant project root and use relative paths. If the Codex binary is unavailable, the MCP server continues to start and prints a warning; ordinary shell editing remains available.

Recent command and reset records are bounded in memory. Once an old record has been evicted, its `request_id` is no longer available for retry deduplication, so always generate a fresh ID for a genuinely new operation.

### Reusable generated tools

Reusable tools live in `~/Desktop/chatgpt-workspace/tools`, with a compact catalog at `~/Desktop/chatgpt-workspace/TOOLS.md`. The model can create, validate, document, and execute these tools through `shell_run`. They are ordinary local executables rather than dynamically registered MCP tools, so creating one does not require restarting the server or refreshing ChatGPT's MCP metadata.

Each tool has its own directory containing an executable `run` entrypoint and a `TOOL.md` contract. The model is instructed to inspect the catalog before creating a new tool, avoid turning one-off commands into tools, validate new tools before cataloging them, and never store secrets in tool code or documentation.

Only one foreground command runs at a time. To start a long-running process and keep using the shell, use normal shell backgrounding and redirect its log:

```bash
npm run dev > /tmp/my-app.log 2>&1 &
echo $!
```

Then inspect it with later commands such as `tail -n 100 /tmp/my-app.log` or `ps -p <pid>`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local HTTP bind address |
| `PORT` | `3333` | Local HTTP port |
| `MCP_SHELL` | `/bin/zsh` | Persistent shell executable |
| `MCP_CWD` | `~/Desktop/chatgpt-workspace` | Default workspace and initial shell working directory |
| `MCP_CODEX_BIN` | `/Applications/ChatGPT.app/Contents/Resources/codex` | Codex binary targeted by the workspace `apply_patch` symlink |
| `MCP_TRANSCRIPT_CHARS` | `1048576` | Retained rolling transcript size |
| `MCP_OUTPUT_BYTES` | `4096` | Default UTF-8 output bytes returned per tool call |
| `MCP_MAX_OUTPUT_BYTES` | `32768` | Hard maximum for a per-call `max_output_bytes` override |
| `MCP_RECORD_LIMIT` | `1024` | Maximum recent command and reset records retained for idempotency |
| `MCP_LOG_COMMANDS` | `true` | Print each newly executed command to the server terminal |

The shell is non-interactive and has no PTY. Commands that require terminal input are unsupported; stdin is `/dev/null` so a command cannot consume the MCP control stream. A login shell does not necessarily load interactive `.zshrc` aliases.

The command wrapper clears `errexit` (`set -e`) before and after each tool call so it cannot leak into later commands. A command that explicitly enables `set -e` can still end its current shell on failure; the server reports the lost state and starts a clean shell without terminating the MCP HTTP server.

`MCP_CWD` is a default and model instruction, not a filesystem sandbox. An explicit task can still use another path. After changing the workspace or server instructions, restart this server and refresh the app from its ChatGPT plugin settings so ChatGPT reloads the MCP metadata.

## Activity log

Every newly accepted `shell_run` prints only its raw command text to the server terminal. There are no timestamps, request IDs, completion lines, reset or polling entries, or duplicated retry entries. Command output is not copied into the log, so the performance impact is negligible.

Command text can contain tokens, passwords, or other secrets. Logs are terminal-only by default and are not written to a file. Set `MCP_LOG_COMMANDS=false` to disable them.

## Validate

```bash
npm test
npm run typecheck
npm run build
```
