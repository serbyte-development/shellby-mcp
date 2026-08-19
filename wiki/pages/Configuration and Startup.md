# Configuration and Startup

Verified 2026-08-18.

## What This Is

This page documents the supported environment surface, first-time workspace initialization, managed production lifecycle, and operational recovery path.

## Static MCP Configuration

`src/config.ts` is the single runtime configuration boundary. It owns static defaults, parses the small supported environment surface once into `MCP_CONFIG`, validates full numeric strings and cross-field constraints such as `MCP_DEFAULT_OUTPUT_TOKENS <= MCP_MAX_OUTPUT_TOKENS`, and exposes resolved host, fixed production port, workspace, adapter, shell, shell-manager, and iOS settings. Model-facing text response limits use `o200k_base` tokens; internal safety/runtime limits such as transcript retention, per-command capture, cache size, record count, wait bounds, and shutdown grace periods remain byte/count based where appropriate and stay config-only. Other modules consume typed config rather than reading individual environment variables. The only remaining `process.env` uses outside this boundary pass the full environment through to spawned shell or Peekaboo child processes. `.env.example` is the committed, commented configuration template; local `.env*` files are ignored, and public Node entry scripts load an optional `.env` before importing runtime code. `MCP_CONFIG.server` and `MCP_CONFIG.toolMeta` own shared MCP metadata, while `buildMcpInstructions(workspace)` owns the global model-facing instructions and resolves `<workspace>/AGENTS.md`.

## Environment Inputs

| Name                        | Default                     | Consumer                                                 |
| --------------------------- | --------------------------- | -------------------------------------------------------- |
| `NGROK_URL`                 | unset                       | Optional fixed domain for the npm/PM2 ngrok helpers      |
| `NGROK_BIN`                 | `ngrok` from `PATH`         | Optional ngrok executable override                       |
| `NGROK_AUTHTOKEN`           | unset                       | Optional ngrok auth token                                |
| `MCP_SHELL`                 | `/bin/zsh`                  | Login shell executable                                   |
| `MCP_CWD`                   | `~/Desktop/agent-workspace` | Absolute-resolved workspace and initial cwd              |
| `MCP_PEEKABOO_BIN`          | `peekaboo`                  | Peekaboo executable name or absolute path                |
| `MCP_CHATGPT_CDP_ENDPOINT`  | `http://127.0.0.1:9222`     | Already-running Chrome DevTools endpoint for subagents   |
| `CHROME_BIN`                | normal macOS Chrome path    | Optional dedicated-browser executable override           |
| `MCP_DEFAULT_OUTPUT_TOKENS` | `1024`                      | Default `max_output_tokens` when omitted                 |
| `MCP_MAX_OUTPUT_TOKENS`     | `16384`                     | Largest allowed `max_output_tokens` override             |
| `MCP_MAX_SHELLS`            | `8`                         | Maximum live shells including protected `default`        |
| `MCP_SHELL_IDLE_TTL_MS`     | `300000`                    | Live named-shell idle lifetime; `0` disables hibernation |
| `MCP_SHELL_CACHE_TTL_MS`    | `86400000`                  | Cached cwd/exported-environment lifetime since last use  |

Shell configuration values are canonical here. Caller-visible lifetime consequences are in [`shell_run` / `shell_poll`](./tools/shell_run.md); manager mechanics are in [Persistent Shell Runtime](./Persistent%20Shell%20Runtime.md).

Production HTTP always binds to `127.0.0.1:3333`; host and port are not environment-configurable. `MCP_CWD` expands `~`, resolves relative values from startup cwd, and becomes the shell/workspace/instruction root. Its `AGENTS.md` is the coding-instructions path advertised to MCP clients. Numeric values are range-checked. Audit retention and token-accounting behavior are documented in [Audit Logging](./Audit%20Logging.md).

## Startup and Shutdown

Public startup is driven by `scripts/start.mjs`. Package scripts load an optional repository `.env` before setup, startup, browser management, URL printing, or development begins, so their preflight and child processes see the same configuration. Startup runs the Mac/ngrok preflight, builds, starts or reloads the MCP and ngrok through the repository-local PM2 dependency, launches the dedicated ChatGPT Chrome profile when it has been configured, waits for `/healthz`, and prints the public `/mcp` URL. `ecosystem.config.cjs` also loads `.env` when PM2 is invoked directly and resolves ngrok from the caller's `PATH` instead of a maintainer-specific Homebrew path. For first-time setup, `scripts/setup.mjs` performs prerequisite checks and calls `scripts/workspace-setup.mjs`, which creates the workspace plus a starter `AGENTS.md` only when that file is absent; existing workspace instructions are never overwritten (`package.json`, `scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/workspace-setup.mjs`, `scripts/start.mjs`, `ecosystem.config.cjs`, `test/setup-workspace.test.ts`).

Inside the MCP process, startup first ensures `~/.unhinged-agent/auth.json`, prepares the workspace, constructs shared adapters, creates the default shell, and starts HTTP. `apply_patch` resolves its checked-in vendored binary directly from `src/tools/apply-patch/apply-patch.ts`; startup does not install or link it into the workspace. Authentication state is not stored in the repository or `dist`, so ordinary builds and restarts preserve the bound subject. `ChatGptSubagentModule` remains attach-only; browser launching belongs to `scripts/chatgpt-browser.mjs`. Normal public startup hides the managed headed Chrome process, and a non-fatal page-created callback re-hides it when Chromium reveals itself after opening a subagent tab. `SIGINT` and `SIGTERM` close HTTP, shells, the Peekaboo queue, and any still-managed ChatGPT pages created by the module; the separately launched Chrome process itself is never closed (`src/index.ts`, `src/auth/auth.ts`, `src/server/http-server.ts`, `src/tools/apply-patch/apply-patch.ts`, `src/tools/subagent/chatgpt-subagent.ts`, `scripts/chatgpt-browser.mjs`).

## Computer Use Permission Bootstrap

Install Peekaboo and use its own permission workflow:

```bash
brew install steipete/tap/peekaboo
npm run setup:computer
```

Normal `npm run setup` invokes `peekaboo permissions status --all-sources` when Peekaboo is installed and prints the CLI's own source-aware status. `setup:computer` delegates directly to `peekaboo permissions grant`; Unhinged Agent does not duplicate Peekaboo's macOS permission logic. Screen Recording enables capture; Accessibility and Event Synthesizing enable actions. TCC grants attach to the responsible launching process, so use the source reported by Peekaboo itself (`scripts/peekaboo-permissions.mjs`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).

## Package Scripts

- Runtime check: `preflight` accepts macOS arm64 and x64, then validates Node 22.13.0+, local dependencies, ngrok installation, and ngrok authentication without changing runtime state. `setup` wraps those checks and the first-time workspace/build/Peekaboo/Chrome flow in a zero-dependency terminal UI with compact step status and actionable notes. Missing Peekaboo or browser setup does not block the core MCP; `setup:computer` and `setup:chatgpt` rerun those optional setup paths (`scripts/preflight.mjs`, `scripts/setup.mjs`, `scripts/setup-ui.mjs`, `scripts/peekaboo-permissions.mjs`, `scripts/chatgpt-browser.mjs`).
- Production runtime: `start` builds and starts/reloads MCP + ngrok and auto-launches the configured ChatGPT browser; `restart` does the same after clearing the current audit log; `status`, `logs`, and `stop` expose the small PM2 management surface. PM2 gives the MCP process 10 seconds to complete its signal-driven cleanup before forcing termination. PM2 is a package dependency rather than a global prerequisite (`package.json`, `scripts/start.mjs`, `ecosystem.config.cjs`).
- Development: `dev`, `build`, and `inspect` keep direct local development separate from the managed production runtime.
- Tunnel: `tunnel` remains a low-level helper that exposes port 3333 through the checked-in ngrok policy with the ngrok agent's local HTTP inspector disabled. ngrok assigns the public URL unless `NGROK_URL` supplies the caller's own fixed domain (`package.json`, `ecosystem.config.cjs`).
- URL discovery: `print-url` prints `https://<domain>/mcp`, using `NGROK_URL` when configured or ngrok's local tunnel API otherwise. `start` and `restart` call it after the managed runtime is healthy (`package.json`, `scripts/print-url.mjs`, `scripts/start.mjs`).
- Authentication: `auth:reset` performs the local warning/confirmation flow and clears the bound subject. Reset does not generate or rotate an ngrok URL (`package.json`, `src/auth/reset.ts`).

Remote trust and subject binding are canonical in [HTTP Transport](./HTTP%20Transport.md).

Production HTTP, health checks, the PM2 ngrok app, and the trusted Host rewrite deliberately share fixed local port 3333. The injectable HTTP server still accepts a port override for isolated tests. `NGROK_URL` changes only the optional public domain passed to ngrok (`src/config.ts`, `src/server/http-server.ts`, `scripts/start.mjs`, `package.json`, `ecosystem.config.cjs`, `ngrok-traffic-policy.yml`).

## Operational Recovery

- `npm run restart` removes the current audit log, rebuilds, and asks PM2 to `startOrReload` only the MCP and ngrok definitions in `ecosystem.config.cjs`. It then ensures the dedicated ChatGPT browser is available; it does not recreate the PM2 daemon or replace the authenticated browser profile (`package.json`, `scripts/start.mjs`, `scripts/chatgpt-browser.mjs`, `ecosystem.config.cjs`).
- If startup reaches `MCP server did not become healthy`, inspect `npm run status` and `npm run logs` before treating the health timeout as the root cause. The health loop only proves that `/healthz` did not respond within five seconds after PM2 returned (`scripts/start.mjs`, `package.json`).
- A repository move, macOS permission-context change, PM2 upgrade, or inconsistent daemon state can require recreating PM2. Confirm that condition first; `./node_modules/.bin/pm2 kill` stops every application managed by that daemon, not only Unhinged Agent. Afterward, `npm run restart` creates the configured MCP and ngrok processes from the current repository path (`scripts/start.mjs`, `ecosystem.config.cjs`).

## Related

- [Project Overview](./Project%20Overview.md)
- [Architecture Map](./Architecture%20Map.md)
- [HTTP Transport](./HTTP%20Transport.md)
- [Workspace Tooling](./Workspace%20Tooling.md)
- [Build and Test](./Build%20and%20Test.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
- [Audit Logging](./Audit%20Logging.md)
