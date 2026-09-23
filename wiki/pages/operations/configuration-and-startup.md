---
summary: "Config ownership, create-only setup, enabled-service composition, and concurrent installations."
paths:
  - src/public-config.cts
  - src/config.ts
  - src/index.ts
  - scripts/setup.ts
  - scripts/workspace-setup.ts
  - scripts/preflight.ts
  - scripts/start.ts
  - scripts/pm2.ts
  - scripts/ngrok-config.cjs
  - scripts/print-url.ts
  - scripts/chatgpt/browser.mjs
  - ecosystem.config.cjs
---

# Configuration and Startup

## Configuration owner

[public-config.cts](../../../src/public-config.cts) owns the public schema, defaults, and `.shellby/config.toml` loader. [config.ts](../../../src/config.ts) resolves paths and derives `MCP_CONFIG`; internal retention/wait/resource limits remain code-owned there. Read those files for setting inventories and values.

Missing fields default silently. Invalid values warn and fall back individually; valid siblings survive. Unknown keys warn and are ignored. Missing/unreadable files or malformed TOML remain errors: whole-file fallback could silently re-enable disabled tools or lose a reserved tunnel URL.

The same module compiles to CommonJS for PM2's ecosystem file while serving the ESM runtime. [workspace-setup.ts](../../../scripts/workspace-setup.ts) derives initial TOML from shared defaults. Do not add another parser/default table in a launcher. Public configuration changes require restart; [startup prompts and skills](../mcp-tool-surface.md) have separate dynamic loading.

Shellby does not load repository `.env` files. ngrok credentials stay in native ngrok configuration; package-local binaries and managed Chrome profile location are derived by Shellby. Optional RTK is resolved from startup PATH and validated when enabled.

`logging.enabled` defaults to `false`; [Runtime Logging](./runtime-logging.md) owns activation, event coverage, and file retention. Configuration is read at startup.

## Bootstrap and composition

`npm run setup -- --config-only` creates the config only if missing. Full [setup.ts](../../../scripts/setup.ts) loads it before prerequisite checks, creates workspace/state directories, builds backend, and checks browser/computer integrations only when enabled. Existing TOML, workspace instructions, and copied starter skills remain untouched. See [Workspace Tooling](../workspace-tooling.md).

Managed [start.ts](../../../scripts/start.ts) requires config/workspace, runs preflight, builds, prepares dedicated Chrome when delegation is enabled, reconciles ngrok, then reloads MCP through [pm2.ts](../../../scripts/pm2.ts). The runtime delegation service itself is attach-only. [src/index.ts](../../../src/index.ts) owns service construction and disposal; [Architecture Map](../architecture-map.md) owns request/state flow.

`ui.enabled` composes the observer and serves `ui/dist`. Root setup/build/start do not install or build UI dependencies; use `ui:install`/`ui:build`, or `ui:dev` with its API proxy. Frontend: [UI wiki](../../../ui/wiki/AGENTS.md).

## Isolation and local-only mode

`state_dir` owns auth, delegated conversation mappings, managed Chrome profile, and PM2 home. Concurrent repository copies additionally need distinct MCP ports, local CDP ports when delegation is enabled, and ngrok API ports/public endpoints when tunneled. Independent copies should not use endpoint pooling. Shared workspace and desktop remain shared.

[ngrok-config.cjs](../../../scripts/ngrok-config.cjs) combines native credentials with a secret-free per-instance API-address overlay; it supports native config v2/v3 layout. [print-url.ts](../../../scripts/print-url.ts) selects the matching upstream/reserved domain. Health checks verify repository/state identity; browser startup rejects an occupied local CDP endpoint belonging to another profile.

With `ngrok.enabled=false`, setup/preflight skip ngrok and URL discovery returns loopback directly. Start must explicitly remove an existing managed tunnel before MCP reload; omitting it from the ecosystem alone leaves it running. Cleanup failures abort startup. Unmanaged tunnels are outside this lifecycle.

Operational recovery, restart ordering, and macOS launch-context failures: [Runtime Recovery](./runtime-recovery.md). Focused validation: [Build and Test](./build-and-test.md).
