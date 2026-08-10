# Unhinged Terminal MCP

A local MCP agent harness for giving ChatGPT and other local MCP clients controlled access to persistent shells, file patching, webpage fetching, macOS Computer Use, and browser-backed ChatGPT subagents.

> **Security:** this server can execute arbitrary commands with your macOS user permissions. Remote ChatGPT access is restricted by the included ngrok traffic policy and a bound OpenAI subject, but an authorized caller still has the power of your local user account. Run it only on a machine you trust.

Maintainers should start with the [architecture wiki](wiki/index.md).

## What it provides

- Named persistent shells with retained cwd, environment, bounded output, polling, reset, and parallel shell IDs.
- Native `apply_patch` for source edits without routing patches through a shell.
- `fetch_website` with cleaned Markdown/HTML and cached pagination.
- Eleven focused macOS `computer_*` tools backed by Peekaboo.
- Persistent browser-backed ChatGPT subagents through an already-running Chrome CDP session.
- Dynamic workspace skills loaded from `<workspace>/skills/*/SKILL.md`.
- Agent feedback logging and compact MCP tool-call auditing.

The server uses MCP TypeScript SDK v2 with stateless Streamable HTTP requests. Shared runtime state such as shells, browser subagents, and Peekaboo spans independent requests but resets when the process restarts. The bound remote owner is durable and survives restarts in `~/.shelly/auth.json`.

## Architecture

Remote ChatGPT traffic:

```text
ChatGPT
  -> ngrok
     -> allow only com.openai.chatgpt source traffic
     -> expose exact /mcp
     -> add X-Shelly-Remote: 1
  -> localhost:3333/mcp
     -> bind/check X-OpenAI-Subject
     -> MCP tools
```

Direct local MCP clients connect to:

```text
http://127.0.0.1:3333/mcp
```

Local access is intentionally unauthenticated. The remote ChatGPT path relies on ngrok to prove the caller came from ChatGPT infrastructure, then binds the first remote tool caller's `X-OpenAI-Subject` as the owner.

Authentication state is stored outside the repository at:

```text
~/.shelly/auth.json
```

Reset the bound ChatGPT owner with:

```bash
npm run auth:reset
```

## Requirements

- macOS
- Node.js 22+
- npm
- ngrok CLI for remote ChatGPT access
- ChatGPT Developer mode for remote use
- [Peekaboo](https://peekaboo.sh/) for `computer_*` tools
- An authenticated Chrome instance with CDP enabled for `chatgpt_subagent`

Install Peekaboo if you want Computer Use:

```bash
brew install steipete/tap/peekaboo
peekaboo permissions grant
```

The server still starts when Peekaboo or Chrome are unavailable. Only the dependent tools fail.

## Install

```bash
git clone https://github.com/Austin1serb/unhinged-terminal-mcp.git
cd unhinged-terminal-mcp
npm ci
```

## Run locally

Start the MCP server:

```bash
npm run dev
```

The local endpoint is:

```text
http://127.0.0.1:3333/mcp
```

You can inspect it with:

```bash
npm run inspect
```

## Connect ChatGPT through ngrok

Authenticate your ngrok CLI first using your own ngrok account.

Then start the tunnel:

```bash
npm run tunnel
```

By default ngrok assigns the public URL. Use the HTTPS URL it gives you and append `/mcp`:

```text
https://<your-ngrok-domain>/mcp
```

If you have a fixed ngrok domain, set it before starting the tunnel:

```bash
export NGROK_URL="<your-ngrok-domain>"
npm run tunnel
```

`NGROK_URL` is optional. The repository contains no maintainer-specific public MCP URL.

Configure ChatGPT to use the resulting HTTPS `/mcp` endpoint as a no-auth MCP endpoint. This server does not use MCP OAuth; remote authorization is enforced by the ngrok ChatGPT source check plus the bound OpenAI subject.

The first trusted remote `tools/call` binds that Shelly installation to the calling ChatGPT subject. Later remote tool calls must carry the same subject. Discovery does not bind ownership.

## Run with PM2

Build and start both the MCP server and ngrok:

```bash
npm run pm2:start
```

For a fixed ngrok domain:

```bash
export NGROK_URL="<your-ngrok-domain>"
npm run pm2:start
```

Management commands:

```bash
npm run pm2:restart
npm run pm2:status
npm run pm2:logs
npm run pm2:stop
```

`pm2:restart` rebuilds the server and reloads the PM2 configuration with the current environment.

## Browser ChatGPT subagents

`chatgpt_subagent` and `chatgpt_subagent_poll` use an already-running authenticated Chrome instance exposed through the Chrome DevTools Protocol.

Default endpoint:

```text
http://127.0.0.1:9222
```

Override it with:

```bash
export MCP_CHATGPT_CDP_ENDPOINT="http://127.0.0.1:9222"
```

The server does not launch Chrome or choose a browser profile. Chrome lifecycle and authentication remain outside the MCP process.

## Tools

Core tools:

- `fetch_website`
- `skill_list`
- `skill_load`
- `feedback_submit`
- `chatgpt_subagent`
- `chatgpt_subagent_poll`
- `apply_patch`

Shell tools:

- `shell_run`
- `shell_poll`
- `shell_reset`
- `shell_list`
- `shell_close`

Computer Use tools:

- `computer_list`
- `computer_observe`
- `computer_inspect`
- `computer_click`
- `computer_type`
- `computer_press`
- `computer_hotkey`
- `computer_scroll`
- `computer_drag`
- `computer_app`
- `computer_window`

For exact schemas, lifecycle behavior, output limits, and model-facing descriptions, see [MCP Tool Surface](wiki/pages/MCP%20Tool%20Surface.md).

## Persistent shells

`shell_id` defaults to `default`. Reusing the same ID preserves cwd, environment variables, functions, transcript, and background processes. Different shell IDs run independently and may execute foreground work concurrently.

Each new `shell_run` command requires a `request_id`. Retrying the same request ID with the same command returns the retained result rather than executing it twice. Reusing the ID with different command text returns a conflict.

Defaults:

- 8 live shells including `default`
- 30-minute idle timeout for named shells
- 2 KiB response output
- 32 KiB maximum response override
- 256 KiB retained output per command
- 1 MiB rolling shell transcript

The workspace defaults to:

```text
~/Desktop/chatgpt-workspace
```

This is a default working directory and model convention, not a sandbox.

## Computer Use

Peekaboo permissions can be inspected with:

```bash
peekaboo permissions status --all-sources --json
```

`computer_observe` returns a screenshot plus snapshot ID. Snapshot-based actions use that retained capture target so coordinates are interpreted against the correct screen/window. Observe again after the UI changes rather than reusing stale coordinates.

## `apply_patch`

The repository includes a pinned macOS arm64 standalone `apply_patch` executable under `vendor/`. Startup exposes it through the workspace and the MCP registers it as a first-class tool.

Each call requires an absolute `cwd` and a normal Codex-style patch. It runs independently of shell state and has bounded output and abort escalation.

## Configuration

| Variable                       | Default                       | Purpose                                            |
| ------------------------------ | ----------------------------- | -------------------------------------------------- |
| `HOST`                         | `127.0.0.1`                   | MCP HTTP bind address                              |
| `PORT`                         | `3333`                        | MCP HTTP port                                      |
| `NGROK_URL`                    | unset                         | Optional fixed ngrok domain used by tunnel helpers |
| `MCP_SHELL`                    | `/bin/zsh`                    | Persistent shell executable                        |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace` | Initial/default workspace                          |
| `MCP_CODEX_BIN`                | `vendor/apply_patch`          | Optional `apply_patch` executable override         |
| `MCP_PEEKABOO_BIN`             | `peekaboo`                    | Peekaboo executable                                |
| `MCP_CHATGPT_CDP_ENDPOINT`     | `http://127.0.0.1:9222`       | Chrome CDP endpoint for browser subagents          |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                     | Rolling transcript size                            |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                      | Per-command retained output ceiling                |
| `MCP_OUTPUT_BYTES`             | `2048`                        | Default response bytes                             |
| `MCP_MAX_OUTPUT_BYTES`         | `32768`                       | Maximum response bytes                             |
| `MCP_RECORD_LIMIT`             | `1024`                        | Recent command/reset records                       |
| `MCP_MAX_SHELLS`               | `8`                           | Maximum live shells                                |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                     | Named-shell idle timeout; `0` disables cleanup     |
| `MCP_LOG_COMMANDS`             | `summary`                     | `off`, `summary`, or `full` shell logging          |

The included ngrok helper and traffic policy assume local port `3333`. If you change `PORT`, update the ngrok command and Host rewrite as well.

## Development

Validation:

```bash
npm ci
npm run lint
npm run type-check
npm test
npm run build
```

Format code with:

```bash
npm run format
```

The wiki under [`wiki/`](wiki/) is the concise source of truth for maintainers. Current code and tests outrank historical raw notes and README text when they disagree.
