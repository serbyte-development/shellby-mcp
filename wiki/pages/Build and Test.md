# Build and Test

Verified 2026-08-14.

## Build Boundary

- Node.js 22.13.0 or newer is required. Public Node entry scripts depend on `--env-file-if-exists`, and the pinned ESLint release has the same minimum on the Node 22 line (`package.json`, `scripts/preflight.mjs`).
- MCP uses the modular TypeScript SDK v2 packages: `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, and the integration-test-only client surface from `@modelcontextprotocol/client` (`package.json`).
- TypeScript is pinned to `6.0.3` because the current `typescript-eslint` release supports TypeScript `<6.1`; ESLint uses the recommended JavaScript and TypeScript rule sets (`package.json`, `eslint.config.js`).
- Prettier `3.9.6` owns formatting; `eslint-config-prettier` disables ESLint rules that would conflict with formatting. `.prettierrc` uses no semicolons, double quotes, ES5 trailing commas, two-space indentation, and a 160-column print width (`package.json`, `eslint.config.js`, `.prettierrc`).
- `tsconfig.json` is the shared type-check configuration for both `src/**/*.ts` and `test/**/*.ts`; it emits declarations and source maps when emission is enabled, targets ES2022, and enables strict typing plus unchecked-index protection.
- `tsconfig.build.json` extends the shared config but includes only `src/**/*.ts`, so production builds emit `dist/index.js` and the source tree without compiling tests into `dist/` (`tsconfig.json`, `tsconfig.build.json`, `package.json`).
- `tsconfig.json` explicitly includes Node types for the MCP v2 server declarations (`tsconfig.json`).

## Validation

| Command              | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `npm test`           | Run `test/*.test.ts` through `tsx`                     |
| `npm run type-check` | Check source and tests without emitting                |
| `npm run lint`       | Lint `src/` and `test/` with ESLint                    |
| `npm run format`     | Format source, tests, and project config with Prettier |
| `npm run build`      | Emit production JavaScript to `dist/`                  |
| `npm run schemas`    | Print the actual registered MCP tool schemas           |

Run the cheapest focused test first, then the broader commands when the change warrants them (`package.json`).

As verified on 2026-08-14, published tool definitions cost 5,850 `o200k_base` tokens in `always` mode, 4,879 in the default `optional` mode, and 4,582 in `never` mode. The default therefore saves 971 tool-definition tokens while keeping per-call structured results available.

`npm run schemas` starts the MCP on an ephemeral localhost port, connects with the real MCP client, calls `tools/list`, and prints the returned tool definitions as formatted JSON. Pass tool names after `--` to filter the output, for example `npm run schemas -- shell_run fetch_website` (`scripts/tool-schemas.ts`, `src/server/http-server.ts`).

## Test Architecture

- Shell tests cover retained state, cwd, descriptors, idempotency, output caps, polling, concurrency, markers, recovery, and reset (`test/shell-session.test.ts`, `test/shell-session-manager.test.ts`).
- MCP audit tests cover tool-call filtering, compact YAML formatting, MCP `in / out` token counts, Better Comments status tags, large-response thresholds, bounded `shell_run` command blocks, ordinary-argument truncation, `apply_patch` body omission, and HTTP-boundary interception without contacting external services (`test/mcp-audit-log.test.ts`, `test/mcp-integration.test.ts`).
- Adapter tests cover exact Peekaboo argv, bounded JSON and images, serialization, cancellation, timeouts, snapshots, webpage extraction, and cursors (`test/peekaboo.test.ts`, `test/web-fetch.test.ts`). Direct `apply_patch` execution and abort behavior are covered by MCP integration tests (`test/mcp-integration.test.ts`).
- MCP integration tests validate the published tool order and Standard Schema mechanics, all three model-facing output modes, compact output, one-shot pending-event delivery, final compact-output token logging, cross-request shell state, named-shell concurrency, direct patching, webpage pagination, Computer Use results, semantic errors, restart continuity, exact `/mcp` routing, and Host rejection. Tool and server prose descriptions/instructions are intentionally not assertion-locked because they are model-facing guidance that changes independently of behavior (`test/mcp-integration.test.ts`).
- Authentication unit tests cover durable state, owner-only permissions, first-owner binding, concurrent first calls, reset, and malformed-state failure. MCP integration tests additionally cover exact routing, local access, discovery without binding, binding on an invalid first tool call, same-owner reuse, different-owner rejection, and owner persistence across an HTTP restart (`test/auth.test.ts`, `test/mcp-integration.test.ts`).
- Subagent unit tests cover the hard three-generation cap, passive network completion/event queueing, page/conversation recovery, deleted-conversation failure, result-time DOM reconciliation, activity heartbeats, 30-minute idle reclamation, conversation-graph normalization, and duplicate/final-message filtering. MCP integration coverage verifies array-only 1-3 start/result schemas, real stagger timing, concurrent result retrieval, partial failures, compact answer delivery, and shared service state across stateless HTTP requests without contacting ChatGPT (`test/chatgpt-subagent.test.ts`, `test/mcp-integration.test.ts`).

Tests use temporary directories and real local child shells; process-group tests are POSIX-specific (`test/shell-session.test.ts`).

`npm ci` is the reproducible clean-install path. As verified on 2026-08-10, a clean install followed by lint, type-check, all 97 tests, and build succeeds. npm currently reports two moderate advisories through `@modelcontextprotocol/node -> @hono/node-server`; the advisory is for Hono static-file serving on Windows, which Shelly does not use on its macOS runtime (`package-lock.json`, `package.json`).

## Gaps

No CI workflow is present in the repository, so the validation commands are not enforced by checked-in automation (`package.json`, repository tree).

The tests do not exercise the real `src/index.ts` composition path, `/healthz`, GET/DELETE 405 responses, signal-driven shutdown, tunnel configuration, a real browser launch, or the installed Peekaboo/macOS permission path (`test/`, `src/index.ts`, `src/server/http-server.ts`, `src/tools/web/web-open.ts`, `src/tools/computer/peekaboo.ts`).

The `apply_patch` MCP integration tests inject a fake executable, so they cover wrapper behavior, output caps, concurrency, and abort cleanup but not the checked-in Codex parser itself. Direct MCP probes against `vendor/apply-patch/apply_patch` on 2026-08-11 found three semantics not represented by those tests: consecutive `@@` context anchors are rejected, absolute patch file paths are accepted, and `Add File` overwrites an existing path (`src/tools/apply-patch/apply-patch.ts`, `test/mcp-integration.test.ts`, `vendor/apply-patch/apply_patch`).
