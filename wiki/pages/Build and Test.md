# Build and Test

Verified 2026-07-19.

## What This Is

The project uses TypeScript's NodeNext ESM model, Node's built-in test runner through `tsx`, and direct integration tests against the MCP SDK (`package.json`, `tsconfig.json`).

## Build Boundary

- Node.js 22 or newer is required (`package.json`).
- `tsconfig.json` compiles only `src/**/*.ts` to `dist/`, emits declarations and source maps, targets ES2022, and enables strict typing plus unchecked-index protection.
- Tests are intentionally excluded from the production build and are executed directly from TypeScript (`tsconfig.json`, `package.json`).

## Validation Commands

- `npm test` runs `tsx --test test/*.test.ts`.
- `npm run typecheck` checks source without emitting.
- `npm run build` emits production files (`package.json`).

## Test Architecture

- `test/shell-session.test.ts` covers state retention, descriptor isolation, idempotency, full and summary logging, control-character escaping, response and per-command output caps, polling, concurrency, marker-safe multiline commands, shell recovery, process-group failure, and reset.
- `test/mcp-integration.test.ts` starts an ephemeral HTTP server, validates published metadata/tool schemas, proves state crosses MCP client sessions, exercises native patch quoting and shared-shell concurrency, and tests Host rejection.
- `test/workspace-tools.test.ts` covers `apply_patch` symlink creation and graceful absence of the Codex binary.

Tests use temporary directories and real local child shells; process-group tests are POSIX-specific (`test/shell-session.test.ts`).

## Current Gap

No CI workflow is present in the repository, so the three validation commands are not enforced by checked-in automation (`package.json`, repository tree).

The tests do not exercise the real `src/index.ts` composition path, `/healthz`, GET/DELETE 405 responses, signal-driven graceful shutdown, the checked-in tunnel configuration, or replacement of an existing stale `apply_patch` executable (`test/`, `src/index.ts`, `src/http-server.ts`, `src/workspace-tools.ts`).

## Related

- [[pages/Architecture Map]]
- [[pages/Persistent Shell Runtime]]
- [[pages/HTTP Transport]]
- [[pages/Open Questions and Risks]]
