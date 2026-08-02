# Configuration and Startup

Verified 2026-08-01.

## What This Is

`src/index.ts` is the production entry point that converts environment variables into the composed HTTP server, workspace integration, and shell runtime.

## Environment Inputs

| Name                           | Default                            | Consumer                                                |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------- |
| `HOST`                         | `127.0.0.1`                        | HTTP bind address                                       |
| `PORT`                         | `3333`                             | HTTP port                                               |
| `MCP_SHELL`                    | `/bin/zsh`                         | Login shell executable                                  |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace`      | Absolute-resolved workspace and initial cwd             |
| `MCP_CODEX_BIN`                | ChatGPT app's bundled `codex` path | `apply_patch` symlink target                            |
| `CHATGPT_COMPUTER_USE_LAUNCHER`| Auto-discovered                     | Explicit Computer Use child MCP launcher path           |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                          | Rolling JavaScript-string length                        |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                           | Per-command retained UTF-8 output ceiling               |
| `MCP_OUTPUT_BYTES`             | `2048`                             | Default response byte cap                               |
| `MCP_MAX_OUTPUT_BYTES`         | `32768`                            | Maximum response byte cap                               |
| `MCP_RECORD_LIMIT`             | `1024`                             | Per-map recent record limit                             |
| `MCP_MAX_SHELLS`               | `8`                                | Maximum named shells including `default`                |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                          | Idle lifetime for named shells; `0` disables cleanup    |
| `MCP_LOG_COMMANDS`             | `summary`                          | `off`, compact `summary`, or raw `full` command logging |

`MCP_CWD` expands `~` and `~/...`, resolves relative values from the server startup directory, and then uses that absolute path for shell startup, workspace tooling, and MCP instructions. Numeric limits are parsed and range-checked by startup helpers. Logging accepts `off`, `summary`, and `full`; true-like legacy values select `summary`, false-like values select `off`, and other values fail fast (`src/index.ts`, `src/workspace-tools.ts`). Accepted commands are prefixed with the server's local time in 24-hour `HH:MM` format so terminal observers can follow when agent activity occurred (`src/shell-session.ts`).

## Startup and Shutdown

Startup creates the workspace, prepares `apply_patch`, constructs the named-shell manager, resolves the Computer Use launcher, starts the default shell, and then listens. The Computer Use child remains stopped until its first wrapper call. Launcher discovery checks `CHATGPT_COMPUTER_USE_LAUNCHER`, the known ChatGPT application path, then a bounded search inside the ChatGPT plugin directory. A missing launcher disables only the six Computer Use wrappers. An incompatible child schema disables those wrappers after the first attempted connection without stopping shell or web tools (`src/computer-use-manager.ts`, `src/http-server.ts`).

Additional shells are created lazily. Inactive named shells are closed after the configured idle lifetime, and `shell_close` can release one immediately. The `default` shell remains available for backward compatibility, cannot be closed, and may still be reset. Active foreground commands and resets are never idle-evicted. `SIGINT` and `SIGTERM` close HTTP requests/server, every created shell, and the Computer Use child before exiting (`src/index.ts`, `src/http-server.ts`, `src/shell-session-manager.ts`, `src/computer-use-manager.ts`).

## Computer Use Permission Bootstrap

The installed helper may return macOS error `-1743` or `-10000: Sender process is not authenticated` when `SkyComputerUseService` lacks Apple Events permission or cannot authenticate the process identity responsible for launching the MCP. The wrapper preserves the child error and adds a permission hint. The server never resets TCC or changes privacy settings automatically.

For the simplest bootstrap, run the MCP directly from the Terminal that should own the permission:

```bash
cd ~/Desktop/chatgpt-local-shell-mcp
npm run dev
```

Then refresh the ChatGPT developer app and call `computer_list_apps` or `computer_get_app_state`. Approve the macOS Automation prompt. If the permission record is stuck, reset only the Computer Use service before repeating the interactive call:

```bash
tccutil reset AppleEvents com.openai.sky.CUAService
pkill -x SkyComputerUseService
open "$HOME/.codex/computer-use/Codex Computer Use.app"
```

PM2 can work when its daemon inherits the same responsible Terminal identity, but that attribution is less obvious and can change after daemon recreation. Running `npm run dev` or `npm run build && npm start` in Terminal is the preferred diagnostic path. A stable signed host application is only necessary if TCC attribution proves unreliable in normal use.

## Package Scripts

- `dev`: watch `src/index.ts` with `tsx`.
- `build`: compile `src/` with TypeScript.
- `start`: run `dist/index.js`.
- `server:start|reload|status|logs|stop`: manage the single stateful MCP process through PM2 in fork mode.
- `tunnel:start|status|logs|stop`: manage the fixed-domain ngrok tunnel through PM2 in fork mode. WARNING: THis will break your ChatGPT web session.
- `inspect`: launch the MCP Inspector package; it does not itself pass a server command.
- `tunnel`: expose port 3333 in the foreground through the same fixed ngrok development domain and traffic policy (`package.json`, `ecosystem.config.cjs`).

The tunnel policy only rewrites Host for localhost validation. It is not part of MCP authentication or authorization (`ngrok-traffic-policy.yml`, `src/http-server.ts`).

`PORT` configures the HTTP listener, but the foreground tunnel script, PM2 ngrok app, and Host rewrite are hard-coded to 3333. A port change therefore requires coordinated edits to `package.json`, `ecosystem.config.cjs`, and `ngrok-traffic-policy.yml` (`src/index.ts`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).

## Related

- [[pages/Architecture Map]]
- [[pages/HTTP Transport]]
- [[pages/Workspace Tooling]]
- [[pages/Build and Test]]
