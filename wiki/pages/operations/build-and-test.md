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
| MCP/auth/tool contracts | `mcp-integration.test.ts`; focused `mcp/` suites for registration, schema, output |
| Audit/identity/steering | `server/audit-log.test.ts`, `agent/context.test.ts`, `agent/observer.test.ts` |
| Delegation | `tools/delegation/` protocol, lifecycle, capacity, and persistence suites |
| Resource adapters | `web-fetch.test.ts`, `peekaboo.test.ts`, image/patch suites, vendor smoke tests |
| Wiki decision-log ordering | `wiki-log.test.ts` |

Use `npm run typecheck` and `npm run lint` for shared TypeScript/style changes. `npm run schemas -- <tool-name>` lists published schemas through an isolated ephemeral HTTP listener; it does not restart production. It uses configured services/state, so do not mistake it for a wholly mocked runtime.

Tests use temporary directories, local listeners, and real child shells. Some adapters use fake executables; vendored binary suites require supported macOS. [CI](../../../.github/workflows/ci.yml) runs install, config-only setup, lint, typecheck, tests, and backend build on arm64/x64 macOS.

## Live boundaries

`test:live:subagent` opts into an authenticated two-turn ChatGPT canary, skipped by default and in CI. It creates a real conversation and ignored diagnostic artifacts; use a dedicated available browser without competing delegation. Private transport investigation: [CDP diagnostics](../subagents/chatgpt-cdp-transport.md).

Fixtures do not establish current private ChatGPT compatibility, real PM2/ngrok recovery, TCC behavior, cursor-host relaunch, or complete browser restoration across production restart. UI build and live browser canary are outside CI. Report these limits when claiming validation.
