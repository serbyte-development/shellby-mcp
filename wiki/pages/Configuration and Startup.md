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

Startup creates the workspace, prepares `apply_patch`, constructs the named-shell manager, starts its default shell before listening, and prints local runtime information. Additional shells are created lazily. Inactive named shells are closed after the configured idle lifetime, and `shell_close` can release one immediately. The `default` shell remains available for backward compatibility, cannot be closed, and may still be reset. Active foreground commands and resets are never idle-evicted. `SIGINT` and `SIGTERM` close HTTP requests/server and then every created shell before exiting (`src/index.ts`, `src/http-server.ts`, `src/shell-session-manager.ts`).

## Package Scripts

- `dev`: watch `src/index.ts` with `tsx`.
- `build`: compile `src/` with TypeScript.
- `start`: run `dist/index.js`.
- `inspect`: launch the MCP Inspector package; it does not itself pass a server command.
- `tunnel`: expose port 3333 through a fixed ngrok development domain and traffic policy (`package.json`).

The tunnel policy only rewrites Host for localhost validation. It is not part of MCP authentication or authorization (`ngrok-traffic-policy.yml`, `src/http-server.ts`).

`PORT` configures the HTTP listener, but both the tunnel script and Host rewrite are hard-coded to 3333. A port change therefore requires coordinated edits to `package.json` and `ngrok-traffic-policy.yml` (`src/index.ts`, `package.json`, `ngrok-traffic-policy.yml`).

## Related

- [[pages/Architecture Map]]
- [[pages/HTTP Transport]]
- [[pages/Workspace Tooling]]
- [[pages/Build and Test]]
