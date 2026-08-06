# Configuration and Startup

Verified 2026-08-06.

## Environment Inputs

| Name                           | Default                            | Consumer                                                |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------- |
| `HOST`                         | `127.0.0.1`                        | HTTP bind address                                       |
| `PORT`                         | `3333`                             | HTTP port                                               |
| `MCP_SHELL`                    | `/bin/zsh`                         | Login shell executable                                  |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace`      | Absolute-resolved workspace and initial cwd             |
| `MCP_CODEX_BIN`                | Repository `vendor/apply_patch`    | Optional `apply_patch` symlink-target override          |
| `MCP_PEEKABOO_BIN`             | `peekaboo`                          | Peekaboo executable name or absolute path                |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                          | Rolling JavaScript-string length                        |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                           | Per-command retained UTF-8 output ceiling               |
| `MCP_OUTPUT_BYTES`             | `2048`                             | Default response byte cap                               |
| `MCP_MAX_OUTPUT_BYTES`         | `32768`                            | Maximum response byte cap                               |
| `MCP_RECORD_LIMIT`             | `1024`                             | Per-map recent record limit                             |
| `MCP_MAX_SHELLS`               | `8`                                | Maximum named shells including `default`                |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                          | Idle lifetime for named shells; `0` disables cleanup    |
| `MCP_LOG_COMMANDS`             | `summary`                          | `off`, compact `summary`, or raw `full` command logging |

`MCP_CWD` expands `~`, resolves relative values from startup cwd, and becomes the shell/workspace/instruction root. Numeric values are range-checked. Logging accepts `off`, `summary`, and `full`; accepted `shell_run` commands also append once, without redaction, to gitignored `agent-commands.log` (`src/index.ts`, `src/workspace-tools.ts`, `src/command-history.ts`, `src/shell-session.ts`).

## Startup and Shutdown

Startup prepares the workspace and patch executable, constructs shared adapters, creates the default shell, and starts HTTP. Named shells are lazy and idle-evicted; active work is not. `SIGINT` and `SIGTERM` close HTTP, shells, and the Peekaboo queue. Peekaboo availability and permissions are checked on use, not startup (`src/index.ts`, `src/http-server.ts`, `src/shell-session-manager.ts`, `src/peekaboo.ts`).

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
