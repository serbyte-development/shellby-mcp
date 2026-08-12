# Configuration and Startup

Verified 2026-08-11.

## Static MCP Configuration

`src/config.ts` is the central static configuration surface. `MCP_CONFIG.server` defines the MCP name, version, and icon; `MCP_CONFIG.toolMeta` defines the shared security metadata applied to every published tool; and `MCP_CONFIG.defaults` defines the host, port, and workspace defaults used when their environment variables are absent. `buildMcpInstructions(workspace)` owns the global model-facing instructions and resolves the coding-instructions file as `<workspace>/AGENTS.md`. Runtime environment parsing remains in `src/index.ts`.

## Environment Inputs

| Name                           | Default                       | Consumer                                               |
| ------------------------------ | ----------------------------- | ------------------------------------------------------ |
| `HOST`                         | `127.0.0.1`                   | HTTP bind address                                      |
| `PORT`                         | `3333`                        | HTTP port                                              |
| `NGROK_URL`                    | unset                         | Optional fixed domain for the npm/PM2 ngrok helpers    |
| `NGROK_BIN`                    | `ngrok` from `PATH`           | Optional ngrok executable override                     |
| `MCP_SHELL`                    | `/bin/zsh`                    | Login shell executable                                 |
| `MCP_CWD`                      | `~/Desktop/chatgpt-workspace` | Absolute-resolved workspace and initial cwd            |
| `MCP_PEEKABOO_BIN`             | `peekaboo`                    | Peekaboo executable name or absolute path              |
| `MCP_CHATGPT_CDP_ENDPOINT`     | `http://127.0.0.1:9222`       | Already-running Chrome DevTools endpoint for subagents |
| `CHROME_BIN`                   | normal macOS Chrome path      | Optional dedicated-browser executable override         |
| `MCP_TRANSCRIPT_CHARS`         | `1048576`                     | Rolling JavaScript-string length                       |
| `MCP_COMMAND_TRANSCRIPT_BYTES` | `262144`                      | Per-command retained UTF-8 output ceiling              |
| `MCP_OUTPUT_BYTES`             | `4096`                        | Default response byte cap                              |
| `MCP_MAX_OUTPUT_BYTES`         | `65536`                       | Maximum response byte cap                              |
| `MCP_RECORD_LIMIT`             | `1024`                        | Per-map recent record limit                            |
| `MCP_MAX_SHELLS`               | `8`                           | Maximum named shells including `default`               |
| `MCP_SHELL_IDLE_TTL_MS`        | `1800000`                     | Idle lifetime for named shells; `0` disables cleanup   |

`MCP_CWD` expands `~`, resolves relative values from startup cwd, and becomes the shell/workspace/instruction root. Its `AGENTS.md` is the coding-instructions path advertised to MCP clients. Numeric values are range-checked. Production startup writes completed MCP `tools/call` activity to the gitignored repository-local `agent-commands.yaml`. Each call is one compact YAML document. Normal calls have no Better Comments tag; noteworthy calls use `?` for responses at least 8 KiB, `~` for calls at least 5 seconds, and `!` for MCP tool/HTTP/connection failures, in that priority order. Large response size is shown in the header without retaining normal response bodies. `shell_run` uses a block scalar capped at 2,000 characters, ordinary arguments are capped at 600 characters, and successful `apply_patch` calls record only cwd and patch size. Failed `apply_patch` calls also retain the patch body, capped at 32,000 characters, to make debugging failed edits practical (`src/config.ts`, `src/index.ts`, `src/server/audit-log.ts`, `src/server/http-server.ts`).

## Startup and Shutdown

Public startup is driven by `scripts/start.mjs`. It runs the Mac/ngrok preflight, builds, starts or reloads the MCP and ngrok through the repository-local PM2 dependency, launches the dedicated ChatGPT Chrome profile when it has been configured, waits for `/healthz`, and prints the public `/mcp` URL. `ecosystem.config.cjs` resolves ngrok from the caller's `PATH` instead of a maintainer-specific Homebrew path. `scripts/setup.mjs` performs the same prerequisite checks for first-time setup (`package.json`, `scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/start.mjs`, `ecosystem.config.cjs`).

Inside the MCP process, startup first ensures `~/.shelly/auth.json`, prepares the workspace, constructs shared adapters, creates the default shell, and starts HTTP. `apply_patch` resolves its checked-in vendored binary directly from `src/tools/apply-patch/apply-patch.ts`; startup does not install or link it into the workspace. Authentication state is not stored in the repository or `dist`, so ordinary builds and restarts preserve the bound subject. `ChatGptSubagentModule` remains attach-only; browser launching belongs to `scripts/chatgpt-browser.mjs`. Normal public startup hides the managed headed Chrome process, and a non-fatal page-created callback re-hides it when Chromium reveals itself after opening a subagent tab. `SIGINT` and `SIGTERM` close HTTP, shells, the Peekaboo queue, and any still-managed ChatGPT pages created by the module; the separately launched Chrome process itself is never closed (`src/index.ts`, `src/auth/auth.ts`, `src/server/http-server.ts`, `src/tools/apply-patch/apply-patch.ts`, `src/tools/subagent/chatgpt-subagent.ts`, `scripts/chatgpt-browser.mjs`).

## Computer Use Permission Bootstrap

Install Peekaboo and inspect or request its macOS permissions:

```bash
brew install steipete/tap/peekaboo
peekaboo permissions status --all-sources --json
peekaboo permissions grant
```

Screen Recording enables capture; Accessibility and Event Synthesizing enable actions. TCC grants attach to the responsible launching process, so compare status from the Terminal or PM2 context that runs the server (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

## Package Scripts

- First-time setup: `setup` validates Apple Silicon macOS, Node 22+, local dependencies, ngrok installation, and ngrok authentication, then best-effort creates and launches `~/.shelly/chatgpt-chrome` for a one-time ChatGPT sign-in. Browser setup failures do not block the core MCP; `setup:chatgpt` retries that browser step strictly (`scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/chatgpt-browser.mjs`).
- Production runtime: `start` builds and starts/reloads MCP + ngrok and auto-launches the configured ChatGPT browser; `restart` does the same after clearing the current audit log; `status`, `logs`, and `stop` expose the small PM2 management surface. PM2 is a package dependency rather than a global prerequisite (`package.json`, `scripts/start.mjs`).
- Development: `dev`, `build`, and `inspect` keep direct local development separate from the managed production runtime.
- Tunnel: `tunnel` remains a low-level helper that exposes port 3333 through the checked-in ngrok policy with the ngrok agent's local HTTP inspector disabled. ngrok assigns the public URL unless `NGROK_URL` supplies the caller's own fixed domain (`package.json`, `ecosystem.config.cjs`).
- URL discovery: `print-url` prints `https://<domain>/mcp`, using `NGROK_URL` when configured or ngrok's local tunnel API otherwise. `start` and `restart` call it after the managed runtime is healthy (`package.json`, `scripts/print-url.mjs`, `scripts/start.mjs`).
- Authentication: `auth:reset` performs the local warning/confirmation flow and clears the bound subject. Reset does not generate or rotate an ngrok URL (`package.json`, `src/auth/reset.ts`).
- Quality: `test`, `type-check`, `lint`, `lint:fix`, and `format` cover automated tests, TypeScript checking, ESLint, and Prettier (`package.json`, `eslint.config.js`, `.prettierrc`).

The tunnel policy is the trusted-origin half of remote authentication: it allows only ngrok's ChatGPT IP category on exact `/mcp`, rewrites Host, and adds `X-Shelly-Remote: 1`. Shelly then binds or checks `X-OpenAI-Subject` only for marked `tools/call` requests. The checked-in commands use `--inspect=false` to disable the local ngrok inspector (`ngrok-traffic-policy.yml`, `package.json`, `ecosystem.config.cjs`, `src/server/http-server.ts`, `src/auth/auth.ts`).

`PORT` changes only HTTP; the tunnel script, PM2 ngrok app, and Host rewrite remain fixed at 3333 and must be edited together. `NGROK_URL` changes only the optional public domain passed to ngrok (`src/index.ts`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).
