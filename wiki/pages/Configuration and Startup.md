# Configuration and Startup

Verified 2026-08-02.

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
| `MCP_PEEKABOO_BIN`             | `peekaboo`                          | Peekaboo executable name or absolute path                |
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

Startup creates the workspace, prepares `apply_patch`, constructs the named-shell manager and one shared `PeekabooClient`, starts the default shell, and then listens. The client uses `MCP_PEEKABOO_BIN` or resolves `peekaboo` through `PATH`; startup does not probe the binary or permissions, so all eleven Computer Use schemas remain stable. A missing executable fails only the attempted Computer Use call with `PEEKABOO_NOT_FOUND` (`src/index.ts`, `src/http-server.ts`, `src/peekaboo.ts`, `src/computer-use-tools.ts`).

Additional shells are created lazily. Inactive named shells are closed after the configured idle lifetime, and `shell_close` can release one immediately. The `default` shell remains available for backward compatibility, cannot be closed, and may still be reset. Active foreground commands and resets are never idle-evicted. `SIGINT` and `SIGTERM` close HTTP requests/server, every created shell, and the Peekaboo client's pending/running queue before exiting. The server does not own a child MCP or manage Peekaboo's own daemon lifecycle (`src/index.ts`, `src/http-server.ts`, `src/shell-session-manager.ts`, `src/peekaboo.ts`).

## Computer Use Permission Bootstrap

Install Peekaboo's supported CLI, then inspect every available local/Bridge permission source:

```bash
brew install steipete/tap/peekaboo
peekaboo permissions status --all-sources --json
peekaboo permissions grant
```

`permissions grant` prints the current macOS setup instructions. Peekaboo also exposes direct permission prompts:

```bash
peekaboo permissions request-screen-recording
peekaboo permissions request-event-synthesizing
```

Follow the macOS prompts, enable Accessibility when `permissions grant` directs it, and re-run the status command. Screen Recording enables capture, Accessibility enables UI automation, and Event Synthesizing enables background synthesized input. The adapter preserves Peekaboo's JSON error instead of changing TCC automatically. If Terminal-launched and PM2-launched behavior differs, compare `peekaboo permissions status --all-sources --json` in the responsible host context before changing server code (`src/peekaboo.ts`, `src/computer-use-tools.ts`).

## Package Scripts

- `dev`: watch `src/index.ts` with `tsx`.
- `build`: compile `src/` with TypeScript.
- `start`: run `dist/index.js`.
- `server:start|reload|status|logs|stop`: manage the single stateful MCP process through PM2 in fork mode.
- `tunnel:start|status|logs|stop`: manage the fixed-domain ngrok tunnel through PM2 in fork mode. Warning: this will break your ChatGPT web session.
- `inspect`: launch the MCP Inspector package; it does not itself pass a server command.
- `tunnel`: expose port 3333 in the foreground through the same fixed ngrok development domain and traffic policy (`package.json`, `ecosystem.config.cjs`).

The tunnel policy only rewrites Host for localhost validation. It is not part of MCP authentication or authorization (`ngrok-traffic-policy.yml`, `src/http-server.ts`).

`PORT` configures the HTTP listener, but the foreground tunnel script, PM2 ngrok app, and Host rewrite are hard-coded to 3333. A port change therefore requires coordinated edits to `package.json`, `ecosystem.config.cjs`, and `ngrok-traffic-policy.yml` (`src/index.ts`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).

## Related

- [[pages/Architecture Map]]
- [[pages/HTTP Transport]]
- [[pages/Workspace Tooling]]
- [[pages/Build and Test]]
