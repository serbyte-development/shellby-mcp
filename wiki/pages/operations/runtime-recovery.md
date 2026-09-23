---
summary: "Routine versus hard restart, PM2 launch-context failures, shutdown, and state reset boundaries."
paths:
  - package.json
  - scripts/start.ts
  - scripts/pm2.ts
  - scripts/chatgpt/browser.mjs
  - scripts/chatgpt/reset-delegation-state.ts
  - src/index.ts
  - src/auth/reset.ts
  - ecosystem.config.cjs
---

# Runtime Recovery

Follow the restart approval rule in [wiki/AGENTS.md](../../AGENTS.md). Configuration/bootstrap: [Configuration and Startup](./configuration-and-startup.md).

## Restart boundary

[package.json](../../../package.json) routes lifecycle commands through [start.ts](../../../scripts/start.ts) and [pm2.ts](../../../scripts/pm2.ts). PM2 always uses `<state_dir>/pm2`, overriding inherited PM2 home; it manages this installation, not the default shared daemon.

- `npm start`: build and start/reload managed services.
- `npm run restart`: also clear the current audit log; retain the PM2 daemon.
- `npm run restart -- --hard`: build, kill the dedicated daemon/apps, clear audit, then start fresh. Refuses when PM2 metadata identifies the caller as an MCP descendant; run from a healthy external Terminal session.

Build must succeed before service mutation or audit deletion. Hard shutdown must succeed before clearing audit. Ordinary restart prepares Chrome and reconciles ngrok before MCP reload because MCP shutdown can kill the initiating CLI. PM2's surviving daemon completes the reload even if that tool call disconnects. Use a fresh call after recovery; its old shell record is gone. See [restart rationale](../../log.md).

A failed `/healthz` check identifies failed observation, not root cause. Inspect instance identity/port, [runtime events](./runtime-logging.md) with `npm run logs:runtime`, and PM2 logs. [start tests](../../../test/start.test.ts) verify command ordering with fixtures; they do not prove every live recovery scenario.

## macOS launch context

A historical failure left MCP reachable while PM2 descendants lost shell DNS and Chromium aborted in `_RegisterApplication`. Recreating PM2 from a healthy Terminal restored service; ordinary app reload retained the broken daemon context. TCC permissions likewise depend on the responsible launcher. [Computer Use](../computer-use.md) routes permission diagnostics.

Startup does not install a LaunchAgent. Migrating older installations from default `~/.pm2` requires removing only Shellby's old app entries there; no automatic migration touches unrelated projects. See [README operations](../../../README.md) for operator steps.

## Shutdown and persistence

[src/index.ts](../../../src/index.ts) closes HTTP, then shared shell/Peekaboo/delegation/cursor-host services on signals. PM2's configured stop grace bounds that cleanup. Browser profile/auth binding persist; named shells, fetched pages, snapshots, initialization, steering, and detached turn results do not.

Runtime logs survive restarts and flush after service cleanup. Rotation bounds retained history; see [Runtime Logging](./runtime-logging.md) for failure and buffering behavior.

`auth:reset` clears the bound subject through its confirmation flow; it does not rotate a tunnel URL. `reset-agents` deletes delegated conversation mappings and SQLite sidecars, not upstream ChatGPT conversations. These are different recovery operations. [Delegation runtime](../subagents/browser-chatgpt-subagents.md) explains which agent state can restore.
