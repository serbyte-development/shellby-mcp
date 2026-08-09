# Build and Test

Verified 2026-08-07.

## Build Boundary

- Node.js 22 or newer is required (`package.json`).
- `tsconfig.json` compiles only `src/**/*.ts` to `dist/`, emits declarations and source maps, targets ES2022, and enables strict typing plus unchecked-index protection.
- Tests are intentionally excluded from the production build and are executed directly from TypeScript (`tsconfig.json`, `package.json`).

## Validation

| Command              | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `npm test`           | Run `test/*.test.ts` through `tsx`            |
| `npm run type-check` | Check source without emitting                 |
| `npm run build`      | Emit production JavaScript to `dist/`         |

Run the cheapest focused test first, then the broader commands when the change warrants them (`package.json`).

## Test Architecture

- Shell tests cover retained state, cwd, descriptors, idempotency, console logs, output caps, polling, concurrency, markers, recovery, and reset (`test/shell-session.test.ts`, `test/shell-session-manager.test.ts`).
- MCP audit tests cover tool-call filtering, character counts, readable `shell_run` command blocks, `apply_patch` body omission, completion metadata, and HTTP-boundary interception without contacting external services (`test/mcp-audit-log.test.ts`, `test/mcp-integration.test.ts`).
- Adapter tests cover exact Peekaboo argv, bounded JSON and images, serialization, cancellation, timeouts, snapshots, webpage extraction, cursors, and workspace patch setup (`test/peekaboo.test.ts`, `test/web-open.test.ts`, `test/workspace-tools.test.ts`).
- MCP integration tests validate the published tool order and schema mechanics, cross-request shell state, named-shell concurrency, direct patching, webpage pagination, Computer Use results, semantic errors, restart continuity, and Host rejection. Tool and server prose descriptions/instructions are intentionally not assertion-locked because they are model-facing guidance that changes independently of behavior (`test/mcp-integration.test.ts`).
- Subagent unit tests cover conversation-graph normalization and final-message filtering, while MCP integration coverage injects a fake shared service to verify caller-named agent continuity across stateless HTTP requests without contacting ChatGPT (`test/chatgpt-subagent.test.ts`, `test/mcp-integration.test.ts`).

Tests use temporary directories and real local child shells; process-group tests are POSIX-specific (`test/shell-session.test.ts`).

## Gaps

No CI workflow is present in the repository, so the three validation commands are not enforced by checked-in automation (`package.json`, repository tree).

The tests do not exercise the real `src/index.ts` composition path, `/healthz`, GET/DELETE 405 responses, signal-driven shutdown, tunnel configuration, a real browser launch, or the installed Peekaboo/macOS permission path (`test/`, `src/index.ts`, `src/http-server.ts`, `src/web-open.ts`, `src/peekaboo.ts`).
