---
summary: "Focused check commands, test ownership, build boundaries, and live validation limits."
paths:
  - package.json
  - tsconfig.json
  - tsconfig.build.json
  - biome.json
  - .github/workflows/ci.yml
  - test/mcp-integration.test.ts
  - test/integrations/helpers.ts
  - test/live/subagent-live.test.ts
  - scripts/tool-schemas.ts
---

# Build and Test

Backend is Node/TypeScript ESM; the shared public config emits CommonJS for PM2. [tsconfig.json](../../../tsconfig.json) checks source, tests, and TypeScript scripts; [tsconfig.build.json](../../../tsconfig.build.json) emits only `src/`. `npm run build` replaces `dist`. Exact engine/dependency versions belong to [package.json](../../../package.json).

Fresh checkouts need `npm ci` and config-only setup before imports of `MCP_CONFIG`. Use disposable fixtures for config mutations. Root Biome excludes `ui/`; frontend dependencies, checks, and builds belong to the [UI wiki](../../../ui/wiki/AGENTS.md). Backend setup/build/start do not build UI.

## Check selection

Run focused suites with `node --import tsx --test <test-file>`. `npm test` uses recursive `tsx --test` discovery. Integration fragments under `test/integrations/` are loaded by [test/mcp-integration.test.ts](../../../test/mcp-integration.test.ts); run that entry point, optionally using `--test-name-pattern` before the filename.

| Change | Test entry points under `test/` |
| --- | --- |
| Config/startup/isolation | `config.test.ts`, `setup-workspace.test.ts`, `start.test.ts`, `instance-isolation.test.ts`, `preflight.test.ts` |
| Shell process/cache/batches | `shell-session.test.ts`, `shell-session-manager.test.ts`, `shell-parallel.test.ts`, `rtk.test.ts` |
| MCP/auth/tool contracts | `mcp-integration.test.ts`; focused `mcp/` suites for call tracking, registration, schema, output |
| Audit/identity/steering | `server/audit-log.test.ts`, `agent/context.test.ts`, `agent/observer.test.ts` |
| Delegation | `tools/delegation/` protocol, lifecycle, capacity, and persistence suites |
| Resource adapters | `web-fetch.test.ts`, `peekaboo.test.ts`, image/patch suites, vendor smoke tests |
| Wiki decision-log ordering | `wiki-log.test.ts` |

Use `npm run typecheck` and `npm run lint` for shared TypeScript changes. `lint` runs `biome check`, including lint, formatting and enabled assists. `lint:fix` runs `biome check --write --unsafe`; review its edits. `npm run format` writes formatting only. Finish file-writing commands before checks; [package.json](../../../package.json) and [biome.json](../../../biome.json) own exact commands/rules.

`npm run schemas -- <tool-name>` renders published tools through an isolated ephemeral HTTP listener; it does not restart production. `schemas:json` exposes JSON instead. [Tool Design](../tool-naming-and-schema-design.md) explains presentation. The script uses configured services/state, so do not mistake it for a wholly mocked runtime.

Tests use temporary directories, local listeners, and real child shells. Some adapters use fake executables; vendored binary suites require supported macOS. [CI](../../../.github/workflows/ci.yml) runs install, config-only setup, lint, typecheck, tests, and backend build on arm64/x64 macOS.

## Live boundaries

Default tests skip opt-in browser suites. [Subagent Testing](../subagents/testing.md) owns CDP fixtures, authenticated lifecycle modes, conversation reuse and evidence. `RUN_LIVE_WEB_TESTS=1` enables the separate [web integration cases](../../../test/integrations/web.ts), which exercise the real renderer against local fixtures.

Fixtures do not establish current private ChatGPT compatibility, real PM2/ngrok recovery, TCC behavior, or cursor-host relaunch. Live subagent restart tests cover an isolated test server, not production process recovery. UI build and authenticated browser tests remain outside CI.
