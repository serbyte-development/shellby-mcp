# Build and Test

Verified 2026-08-04.

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
- `test/shell-session-manager.test.ts` covers named-shell creation, limits, listing, closure, idle eviction, default-shell protection, and manager shutdown.
- `test/peekaboo.test.ts` drives a fake Peekaboo CLI and covers PATH/explicit executable selection, literal argv, JSON-envelope failures, malformed and oversized output, serialization, queued cancellation, timeouts without retry, screenshot return/cleanup, and retained snapshot targets.
- `test/mcp-integration.test.ts` starts an ephemeral HTTP server, validates the seven core tools and eleven-tool Computer Use surface, proves state crosses MCP client sessions, exercises named-shell isolation and concurrency, native patching, website format schemas and pagination, visual-first observation, bounded snapshot inspection, compact action results, validation failures, Peekaboo semantic errors, and Host rejection.
- `test/web-open.test.ts` covers default Markdown, requested format forwarding, format-bound cursors, bounded cached pagination, redirects, cursor validation and expiry, and source truncation.
- `test/workspace-tools.test.ts` covers absolute workspace resolution, `apply_patch` symlink creation, and graceful absence of the Codex binary.

Tests use temporary directories and real local child shells; process-group tests are POSIX-specific (`test/shell-session.test.ts`).

## Current Gap

No CI workflow is present in the repository, so the three validation commands are not enforced by checked-in automation (`package.json`, repository tree).

The tests do not exercise the real `src/index.ts` composition path, `/healthz`, GET/DELETE 405 responses, signal-driven graceful shutdown, the checked-in tunnel configuration, a real Cloak Browser launch, the installed Peekaboo binary and macOS permission path, or replacement of an existing stale `apply_patch` executable (`test/`, `src/index.ts`, `src/http-server.ts`, `src/web-open.ts`, `src/peekaboo.ts`, `src/workspace-tools.ts`).

## Related

- [[pages/Architecture Map]]
- [[pages/Persistent Shell Runtime]]
- [[pages/HTTP Transport]]
- [[pages/Open Questions and Risks]]
