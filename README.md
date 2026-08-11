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

- Apple Silicon macOS
- Node.js 22+
- npm
- An [ngrok](https://ngrok.com/) account and CLI
- A ChatGPT account/workspace that can create a custom MCP app with the actions you want to use. See OpenAI's [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

Optional capabilities:

- Google Chrome for `chatgpt_subagent` and `chatgpt_subagent_poll`
- [Peekaboo](https://peekaboo.sh/) for `computer_*` tools

Install Peekaboo if you want Computer Use:

```bash
brew install steipete/tap/peekaboo
peekaboo permissions grant
```

The server still starts when Peekaboo or the dedicated ChatGPT browser are unavailable. Only the dependent tools fail.

## First-time setup

Install ngrok if needed:

```bash
brew install --cask ngrok
```

Clone and install dependencies:

```bash
git clone https://github.com/Austin1serb/unhinged-terminal-mcp.git
cd unhinged-terminal-mcp
npm ci
```

Authenticate ngrok once using the token from your ngrok account:

```bash
ngrok config add-authtoken <your-token>
```

Verify the supported Mac, Node, local dependencies, and ngrok configuration:

```bash
npm run setup
```

If Google Chrome is installed, `setup` also creates a separate profile under `~/.shelly/chatgpt-chrome` and opens ChatGPT. Sign into ChatGPT in that window once. The repository never copies or modifies your normal Chrome profile.

If browser setup was skipped because Chrome was unavailable or port `9222` was already in use, retry it later with:

```bash
npm run setup:chatgpt
```

## Start

After first-time setup, normal use is one command:

```bash
npm start
```

`npm start` validates the runtime, builds the MCP, starts or reloads the MCP and ngrok using the repository's local PM2 dependency, launches the dedicated ChatGPT Chrome profile when configured, waits for the local health check, and prints the exact public `/mcp` URL.

Example:

```text
ChatGPT browser: running
MCP server: running
ngrok: running
MCP URL: https://example.ngrok-free.app/mcp
```

ngrok assigns a public domain by default. If your ngrok account has a fixed/custom domain, pass it when starting:

```bash
NGROK_URL="your-domain.example" npm start
```

`NGROK_URL` is optional and is never repository-specific. `npm run print-url` prints the currently active ChatGPT-ready endpoint at any time.

## Add it to ChatGPT

Enable Developer Mode in ChatGPT, create a custom app, and use the URL printed by `npm start` as the MCP endpoint. This server uses no MCP OAuth, so choose the no-authentication option, scan the tools, and create the app. OpenAI's current UI and plan requirements are documented in [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

The first trusted remote `tools/call` binds this installation to the calling ChatGPT subject. Later remote tool calls must carry the same subject. Discovery does not bind ownership.

Reset the bound ChatGPT owner with:

```bash
npm run auth:reset
```

## Runtime commands

```bash
npm start
npm run restart
npm run status
npm run logs
npm run stop
npm run print-url
npm run chatgpt
```

PM2 is a repository dependency and implementation detail; users do not need to install it globally. `restart` also clears the current `agent-commands.yaml` audit log before reloading the runtime.

## Browser ChatGPT subagents

`npm run setup:chatgpt` creates a dedicated Chrome profile and launches it with the Chrome DevTools Protocol on `127.0.0.1:9222`. After you sign into ChatGPT once, `npm start` launches that profile automatically when needed. `npm run chatgpt` launches it manually without restarting the MCP.

Returned turn IDs are readable and sequential per local agent, for example `seo-audit_turn_1` and `seo-audit_turn_2`. Idle subagent state expires after 30 minutes: the managed browser tab and local turn records are removed, while the ChatGPT conversation remains in the user's ChatGPT history.

Default endpoint:

```text
http://127.0.0.1:9222
```

Override it with:

```bash
export MCP_CHATGPT_CDP_ENDPOINT="http://127.0.0.1:9222"
```

When a non-local CDP endpoint is configured, the startup helper leaves Chrome lifecycle to that external endpoint.

## Local development

For direct development without the managed production runtime:

```bash
npm run dev
```

The local endpoint is `http://127.0.0.1:3333/mcp`. `npm run inspect` opens the MCP inspector.

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

The repository includes a pinned macOS arm64 standalone `apply_patch` executable at `vendor/apply-patch/apply_patch`. The MCP executes that vendored binary directly as a first-class tool; it is not installed into or exposed through the workspace shell.

Each call requires an absolute `cwd` and a normal Codex-style patch. It runs independently of shell state and has abort escalation. Failure diagnostics are capped internally at 4 KiB so callers cannot expand patch errors into large context-consuming responses.

## Configuration

| Variable                       | Default                       | Purpose                                            |
| ------------------------------ | ----------------------------- | -------------------------------------------------- |
| `HOST`                         | `127.0.0.1`                   | MCP HTTP bind address                              |
| `PORT`                         | `3333`                        | MCP HTTP port                                      |
| `NGROK_URL`                    | unset                         | Optional fixed ngrok domain used by tunnel helpers |
| `NGROK_BIN`                    | `ngrok` from `PATH`           | Optional ngrok executable override                 |
| `MCP_SHELL`                    | `/bin/zsh`                    | Persistent shell executable                        |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace` | Initial/default workspace                          |
| `MCP_PEEKABOO_BIN`             | `peekaboo`                    | Peekaboo executable                                |
| `MCP_CHATGPT_CDP_ENDPOINT`     | `http://127.0.0.1:9222`       | Chrome CDP endpoint for browser subagents          |
| `CHROME_BIN`                   | normal macOS Chrome path      | Optional dedicated Chrome executable override      |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                     | Rolling transcript size                            |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                      | Per-command retained output ceiling                |
| `MCP_OUTPUT_BYTES`             | `2048`                        | Default response bytes                             |
| `MCP_MAX_OUTPUT_BYTES`         | `32768`                       | Maximum response bytes                             |
| `MCP_RECORD_LIMIT`             | `1024`                        | Recent command/reset records                       |
| `MCP_MAX_SHELLS`               | `8`                           | Maximum live shells                                |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                     | Named-shell idle timeout; `0` disables cleanup     |

The included ngrok helper, managed startup flow, and traffic policy assume local port `3333`. If you change `PORT`, update the ngrok command, startup health check, and Host rewrite as well.

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
