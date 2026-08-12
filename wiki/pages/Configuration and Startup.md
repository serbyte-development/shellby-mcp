# Configuration and Startup

Verified 2026-08-12.

## Static MCP Configuration

`src/config.ts` is the single runtime configuration boundary. It owns static defaults, parses the small supported environment surface once into `MCP_CONFIG`, validates full numeric strings and cross-field constraints such as `MCP_DEFAULT_OUTPUT_TOKENS <= MCP_MAX_OUTPUT_TOKENS`, and exposes resolved host, fixed production port, workspace, adapter, shell, shell-manager, and iOS settings. Model-facing text response limits use `o200k_base` tokens; internal safety/runtime limits such as transcript retention, per-command capture, cache size, record count, wait bounds, and shutdown grace periods remain byte/count based where appropriate and stay config-only. Other modules consume typed config rather than reading individual environment variables. The only remaining `process.env` uses outside this boundary pass the full environment through to spawned shell or Peekaboo child processes. `.env.example` is the committed, commented configuration template; local `.env*` files are ignored, and public Node entry scripts load an optional `.env` before importing runtime code. `MCP_CONFIG.server` and `MCP_CONFIG.toolMeta` own shared MCP metadata, while `buildMcpInstructions(workspace)` owns the global model-facing instructions and resolves `<workspace>/AGENTS.md`.

## Environment Inputs

| Name                       | Default                       | Consumer                                               |
| -------------------------- | ----------------------------- | ------------------------------------------------------ |
| `HOST`                     | `127.0.0.1`                   | HTTP bind address                                      |
| `NGROK_URL`                | unset                         | Optional fixed domain for the npm/PM2 ngrok helpers    |
| `NGROK_BIN`                | `ngrok` from `PATH`           | Optional ngrok executable override                     |
| `NGROK_AUTHTOKEN`          | unset                         | Optional ngrok auth token                              |
| `MCP_SHELL`                | `/bin/zsh`                    | Login shell executable                                 |
| `MCP_CWD`                  | `~/Desktop/chatgpt-workspace` | Absolute-resolved workspace and initial cwd            |
| `MCP_PEEKABOO_BIN`         | `peekaboo`                    | Peekaboo executable name or absolute path              |
| `MCP_CHATGPT_CDP_ENDPOINT` | `http://127.0.0.1:9222`       | Already-running Chrome DevTools endpoint for subagents |
| `CHROME_BIN`               | normal macOS Chrome path      | Optional dedicated-browser executable override         |
| `MCP_DEFAULT_OUTPUT_TOKENS` | `1024`                       | Default `max_output_tokens` when omitted               |
| `MCP_MAX_OUTPUT_TOKENS`     | `16384`                      | Largest allowed `max_output_tokens` override           |
| `MCP_MAX_SHELLS`           | `8`                           | Maximum named shells including `default`               |
| `MCP_SHELL_IDLE_TTL_MS`    | `1800000`                     | Idle lifetime for named shells; `0` disables cleanup   |

`MCP_CWD` expands `~`, resolves relative values from startup cwd, and becomes the shell/workspace/instruction root. Its `AGENTS.md` is the coding-instructions path advertised to MCP clients. Numeric values are range-checked. Production startup writes completed MCP `tools/call` activity to the gitignored repository-local `agent-commands.yaml`. Each call is one compact YAML document. Normal calls have no Better Comments tag; noteworthy calls use `?` for responses at least 8 KiB, `~` for calls at least 5 seconds, and `!` for MCP tool/HTTP/connection failures, in that priority order. Large response size is shown in the header without retaining normal response bodies. `shell_run` uses a block scalar capped at 2,000 characters, ordinary arguments are capped at 600 characters, and successful `apply_patch` calls record only cwd and patch size. Failed `apply_patch` calls also retain the patch body, capped at 32,000 characters, to make debugging failed edits practical (`src/config.ts`, `src/index.ts`, `src/server/audit-log.ts`, `src/server/http-server.ts`).

## Startup and Shutdown

Public startup is driven by `scripts/start.mjs`. Package scripts load an optional repository `.env` before setup, startup, browser management, URL printing, or development begins, so their preflight and child processes see the same configuration. Startup runs the Mac/ngrok preflight, builds, starts or reloads the MCP and ngrok through the repository-local PM2 dependency, launches the dedicated ChatGPT Chrome profile when it has been configured, waits for `/healthz`, and prints the public `/mcp` URL. `ecosystem.config.cjs` also loads `.env` when PM2 is invoked directly and resolves ngrok from the caller's `PATH` instead of a maintainer-specific Homebrew path. `scripts/setup.mjs` performs the same prerequisite checks for first-time setup (`package.json`, `scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/start.mjs`, `ecosystem.config.cjs`).

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

Production HTTP, health checks, the PM2 ngrok app, and the trusted Host rewrite deliberately share fixed local port 3333. The injectable HTTP server still accepts a port override for isolated tests. `NGROK_URL` changes only the optional public domain passed to ngrok (`src/config.ts`, `src/server/http-server.ts`, `scripts/start.mjs`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).
