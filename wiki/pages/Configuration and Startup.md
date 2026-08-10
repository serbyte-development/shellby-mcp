# Configuration and Startup

Verified 2026-08-10.

## Static MCP Configuration

`src/config.ts` is the central static configuration surface. `MCP_CONFIG.server` defines the MCP name, version, and icon; `MCP_CONFIG.toolMeta` defines the shared security metadata applied to every published tool; and `MCP_CONFIG.defaults` defines the host, port, workspace, and shell-log defaults used when their environment variables are absent. `buildMcpInstructions(workspace)` owns the global model-facing instructions and resolves the coding-instructions file as `<workspace>/AGENTS.md`. Runtime environment parsing remains in `src/index.ts`.

## Environment Inputs

| Name                           | Default                       | Consumer                                               |
| ------------------------------ | ----------------------------- | ------------------------------------------------------ |
| `HOST`                         | `127.0.0.1`                   | HTTP bind address                                      |
| `PORT`                         | `3333`                        | HTTP port                                              |
| `NGROK_URL`                    | unset                         | Optional fixed domain for the npm/PM2 ngrok helpers    |
| `MCP_SHELL`                    | `/bin/zsh`                    | Login shell executable                                 |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace` | Absolute-resolved workspace and initial cwd            |
| `MCP_PEEKABOO_BIN`             | `peekaboo`                    | Peekaboo executable name or absolute path              |
| `MCP_CHATGPT_CDP_ENDPOINT`     | `http://127.0.0.1:9222`       | Already-running Chrome DevTools endpoint for subagents |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                     | Rolling JavaScript-string length                       |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                      | Per-command retained UTF-8 output ceiling              |
| `MCP_OUTPUT_BYTES`             | `2048`                        | Default response byte cap                              |
| `MCP_MAX_OUTPUT_BYTES`         | `32768`                       | Maximum response byte cap                              |
| `MCP_RECORD_LIMIT`             | `1024`                        | Per-map recent record limit                            |
| `MCP_MAX_SHELLS`               | `8`                           | Maximum named shells including `default`               |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                     | Idle lifetime for named shells; `0` disables cleanup   |

`MCP_CWD` expands `~`, resolves relative values from startup cwd, and becomes the shell/workspace/instruction root. Its `AGENTS.md` is the coding-instructions path advertised to MCP clients. Numeric values are range-checked. Production startup writes completed MCP `tools/call` activity to the gitignored repository-local `agent-commands.yaml`. Each call is one compact YAML document with tool name and duration in the document-start comment; `shell_run` uses a block scalar capped at 2,000 characters, ordinary arguments are capped at 600 characters, and `apply_patch` records only cwd and patch size rather than the patch body (`src/config.ts`, `src/index.ts`, `src/server/audit-log.ts`, `src/server/http-server.ts`).

## Startup and Shutdown

Startup first ensures `~/.shelly/auth.json`, prepares the workspace, constructs shared adapters, creates the default shell, and starts HTTP. `apply_patch` resolves its checked-in vendored binary directly from `src/tools/apply-patch/apply-patch.ts`; startup does not install or link it into the workspace. Authentication state is not stored in the repository or `dist`, so ordinary builds and restarts preserve the bound subject. The ChatGPT subagent module is attach-only and does not connect to or launch Chrome during startup. `SIGINT` and `SIGTERM` close HTTP, shells, the Peekaboo queue, and any still-managed ChatGPT pages created by the module; the externally owned Chrome process itself is never closed (`src/index.ts`, `src/auth/auth.ts`, `src/server/http-server.ts`, `src/tools/apply-patch/apply-patch.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

## Computer Use Permission Bootstrap

Install Peekaboo and inspect or request its macOS permissions:

```bash
brew install steipete/tap/peekaboo
peekaboo permissions status --all-sources --json
peekaboo permissions grant
```

Screen Recording enables capture; Accessibility and Event Synthesizing enable actions. TCC grants attach to the responsible launching process, so compare status from the Terminal or PM2 context that runs the server (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

## Package Scripts

- Development: `dev`, `build`, `start`, `inspect`.
- PM2: `pm2:start`, `pm2:restart`, `pm2:status`, `pm2:logs`, `pm2:stop`.
- Tunnel: `tunnel` exposes port 3333 through the checked-in ngrok policy with the ngrok agent's local HTTP inspector disabled. ngrok assigns the public URL unless `NGROK_URL` supplies the caller's own fixed domain; the PM2 ngrok app follows the same rule (`package.json`, `ecosystem.config.cjs`).
- Authentication: `auth:reset` performs the local warning/confirmation flow and clears the bound subject. Reset does not generate or rotate an ngrok URL (`package.json`, `src/auth/reset.ts`).
- Quality: `test`, `type-check`, `lint`, `lint:fix`, and `format` cover automated tests, TypeScript checking, ESLint, and Prettier (`package.json`, `eslint.config.js`, `.prettierrc`).

The tunnel policy is the trusted-origin half of remote authentication: it allows only ngrok's ChatGPT IP category on exact `/mcp`, rewrites Host, and adds `X-Shelly-Remote: 1`. Shelly then binds or checks `X-OpenAI-Subject` only for marked `tools/call` requests. The checked-in commands use `--inspect=false` to disable the local ngrok inspector (`ngrok-traffic-policy.yml`, `package.json`, `ecosystem.config.cjs`, `src/server/http-server.ts`, `src/auth/auth.ts`).

`PORT` changes only HTTP; the tunnel script, PM2 ngrok app, and Host rewrite remain fixed at 3333 and must be edited together. `NGROK_URL` changes only the optional public domain passed to ngrok (`src/index.ts`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).
