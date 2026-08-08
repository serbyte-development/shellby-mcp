# Configuration and Startup

Verified 2026-08-07.

## Environment Inputs

| Name                           | Default                            | Consumer                                                |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------- |
| `HOST`                         | `127.0.0.1`                        | HTTP bind address                                       |
| `PORT`                         | `3333`                             | HTTP port                                               |
| `MCP_SHELL`                    | `/bin/zsh`                         | Login shell executable                                  |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace`      | Absolute-resolved workspace and initial cwd             |
| `MCP_CODEX_BIN`                | Repository `vendor/apply_patch`    | Optional `apply_patch` symlink-target override          |
| `MCP_PEEKABOO_BIN`             | `peekaboo`                          | Peekaboo executable name or absolute path                |
| `MCP_CHATGPT_CDP_ENDPOINT`     | `http://127.0.0.1:9222`             | Already-running Chrome DevTools endpoint for subagents   |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                          | Rolling JavaScript-string length                        |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                           | Per-command retained UTF-8 output ceiling               |
| `MCP_OUTPUT_BYTES`             | `2048`                             | Default response byte cap                               |
| `MCP_MAX_OUTPUT_BYTES`         | `32768`                            | Maximum response byte cap                               |
| `MCP_RECORD_LIMIT`             | `1024`                             | Per-map recent record limit                             |
| `MCP_MAX_SHELLS`               | `8`                                | Maximum named shells including `default`                |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                          | Idle lifetime for named shells; `0` disables cleanup    |
| `MCP_LOG_COMMANDS`             | `summary`                          | `off`, compact `summary`, or raw `full` command logging |

`MCP_CWD` expands `~`, resolves relative values from startup cwd, and becomes the shell/workspace/instruction root. Numeric values are range-checked. `MCP_LOG_COMMANDS` accepts `off`, `summary`, and `full` and controls only shell command console logging. Independently, production startup writes every MCP `tools/call` invocation to the gitignored repository-local `agent-commands.log` with input and output character counts. Most argument objects are serialized directly; `apply_patch` excludes the patch body and records `patch_chars`, while `shell_run` places the command in its own readable block. Audit timestamps use a compact human-readable form such as `AUG-23-14:23:23` (`src/index.ts`, `src/mcp-audit-log.ts`, `src/http-server.ts`, `src/shell-session.ts`).

## Startup and Shutdown

Startup prepares the workspace and patch executable, constructs shared adapters, creates the default shell, and starts HTTP. The ChatGPT subagent module is attach-only and does not connect to or launch Chrome during startup. `SIGINT` and `SIGTERM` close HTTP, shells, the Peekaboo queue, and any still-managed ChatGPT pages created by the module; the externally owned Chrome process itself is never closed. Tabs that were navigated away from their managed ChatGPT conversation are left alone (`src/index.ts`, `src/http-server.ts`, `src/chatgpt-subagent.ts`).

## Computer Use Permission Bootstrap

Install Peekaboo and inspect or request its macOS permissions:

```bash
brew install steipete/tap/peekaboo
peekaboo permissions status --all-sources --json
peekaboo permissions grant
```

Screen Recording enables capture; Accessibility and Event Synthesizing enable actions. TCC grants attach to the responsible launching process, so compare status from the Terminal or PM2 context that runs the server (`src/peekaboo.ts`, `src/computer-use-tools.ts`).

## Package Scripts

- Development: `dev`, `build`, `start`, `inspect`.
- PM2: `pm2:start`, `pm2:reload`, `pm2:status`, `pm2:logs`, `pm2:stop`.
- Tunnel: `tunnel` exposes port 3333 through the checked-in ngrok domain and policy (`package.json`, `ecosystem.config.cjs`).

The tunnel policy only rewrites Host for localhost validation. It is not part of MCP authentication or authorization (`ngrok-traffic-policy.yml`, `src/http-server.ts`).

`PORT` changes only HTTP; the tunnel script, PM2 ngrok app, and Host rewrite remain fixed at 3333 and must be edited together (`src/index.ts`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).
