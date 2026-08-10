# Build and Test

Verified 2026-08-10.

## Build Boundary

- Node.js 22 or newer is required (`package.json`).
- MCP uses the modular TypeScript SDK v2 packages: `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, and the integration-test-only client surface from `@modelcontextprotocol/client` (`package.json`).
- TypeScript is pinned to `6.0.3` because the current `typescript-eslint` release supports TypeScript `<6.1`; ESLint uses the recommended JavaScript and TypeScript rule sets (`package.json`, `eslint.config.js`).
- Prettier `3.9.6` owns formatting; `eslint-config-prettier` disables ESLint rules that would conflict with formatting. `.prettierrc` uses no semicolons, double quotes, ES5 trailing commas, two-space indentation, and a 160-column print width (`package.json`, `eslint.config.js`, `.prettierrc`).
- `tsconfig.json` compiles only `src/**/*.ts` to `dist/`, emits declarations and source maps, targets ES2022, and enables strict typing plus unchecked-index protection.
- `tsconfig.json` explicitly includes Node types for the MCP v2 server declarations (`tsconfig.json`).
- Tests are intentionally excluded from the production build and are executed directly from TypeScript (`tsconfig.json`, `package.json`).

## Validation

| Command              | Purpose                               |
| -------------------- | ------------------------------------- |
| `npm test`           | Run `test/*.test.ts` through `tsx`    |
| `npm run type-check` | Check source without emitting         |
| `npm run lint`       | Lint `src/` and `test/` with ESLint  |
| `npm run format`     | Format source, tests, and project config with Prettier |
| `npm run build`      | Emit production JavaScript to `dist/` |

Run the cheapest focused test first, then the broader commands when the change warrants them (`package.json`).

## Test Architecture

- Shell tests cover retained state, cwd, descriptors, idempotency, console logs, output caps, polling, concurrency, markers, recovery, and reset (`test/shell-session.test.ts`, `test/shell-session-manager.test.ts`).
- MCP audit tests cover tool-call filtering, character counts, readable `shell_run` command blocks, `apply_patch` body omission, completion metadata, and HTTP-boundary interception without contacting external services (`test/mcp-audit-log.test.ts`, `test/mcp-integration.test.ts`).
- Adapter tests cover exact Peekaboo argv, bounded JSON and images, serialization, cancellation, timeouts, snapshots, webpage extraction, cursors, and workspace patch setup (`test/peekaboo.test.ts`, `test/web-open.test.ts`, `test/workspace-tools.test.ts`).
- MCP integration tests validate the published tool order and Standard Schema mechanics, cross-request shell state, named-shell concurrency, direct patching, webpage pagination, Computer Use results, semantic errors, restart continuity, exact `/mcp` routing, and Host rejection. Tool and server prose descriptions/instructions are intentionally not assertion-locked because they are model-facing guidance that changes independently of behavior (`test/mcp-integration.test.ts`).
- Authentication unit tests cover durable state, owner-only permissions, first-owner binding, concurrent first calls, reset, and malformed-state failure. MCP integration tests additionally cover exact routing, local access, discovery without binding, binding on an invalid first tool call, same-owner reuse, different-owner rejection, and owner persistence across an HTTP restart (`test/auth.test.ts`, `test/mcp-integration.test.ts`).
- Subagent unit tests cover conversation-graph normalization and final-message filtering, while MCP integration coverage injects a fake shared service to verify caller-named agent continuity across stateless HTTP requests without contacting ChatGPT (`test/chatgpt-subagent.test.ts`, `test/mcp-integration.test.ts`).

Tests use temporary directories and real local child shells; process-group tests are POSIX-specific (`test/shell-session.test.ts`).

`npm ci` is the reproducible clean-install path. As verified on 2026-08-10, a clean install followed by lint, type-check, all 97 tests, and build succeeds. npm currently reports two moderate advisories through `@modelcontextprotocol/node -> @hono/node-server`; the advisory is for Hono static-file serving on Windows, which Shelly does not use on its macOS runtime (`package-lock.json`, `package.json`).

## Gaps

No CI workflow is present in the repository, so the validation commands are not enforced by checked-in automation (`package.json`, repository tree).

The tests do not exercise the real `src/index.ts` composition path, `/healthz`, GET/DELETE 405 responses, signal-driven shutdown, tunnel configuration, a real browser launch, or the installed Peekaboo/macOS permission path (`test/`, `src/index.ts`, `src/http-server.ts`, `src/web-open.ts`, `src/peekaboo.ts`).
