# Build and Test

Verified 2026-08-24.

## What This Is

This page maps the compile boundary, focused validation commands, test responsibilities, CI matrix, and known verification gaps.

## Build Boundary

- Node.js 22.13.0 or newer is required. Public Node entry scripts depend on `--env-file-if-exists`, and the pinned ESLint release has the same minimum on the Node 22 line (`package.json`, `scripts/preflight.mjs`).
- MCP uses the modular TypeScript SDK v2 packages: `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, and the integration-test-only client surface from `@modelcontextprotocol/client` (`package.json`).
- TypeScript is pinned to `6.0.3` because the current `typescript-eslint` release supports TypeScript `<6.1`; ESLint uses the recommended JavaScript and TypeScript rule sets (`package.json`, `eslint.config.js`).
- Prettier `3.9.6` owns formatting; `eslint-config-prettier` disables ESLint rules that would conflict with formatting. `.prettierrc` uses no semicolons, double quotes, ES5 trailing commas, two-space indentation, and a 160-column print width (`package.json`, `eslint.config.js`, `.prettierrc`).
- `tsconfig.json` is the shared type-check configuration for both `src/**/*.ts` and `test/**/*.ts`; it emits declarations and source maps when emission is enabled, targets ES2022, and enables strict typing plus unchecked-index protection.
- `tsconfig.build.json` extends the shared config but includes only `src/**/*.ts`, so production builds emit `dist/index.js` and the source tree without compiling tests into `dist/` (`tsconfig.json`, `tsconfig.build.json`, `package.json`).
- `tsconfig.json` explicitly includes Node types for the MCP v2 server declarations (`tsconfig.json`).

## Validation

| Command                      | Purpose                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm test`                   | Run `test/*.test.ts` through `tsx`                                                                 |
| `npm run test:live:subagent` | Manually exercise one real browser-backed subagent conversation across two turns; excluded from CI |
| `npm run type-check`         | Check source and tests without emitting                                                            |
| `npm run lint`               | Lint `src/` and `test/` with ESLint                                                                |
| `npm run format`             | Format source, tests, and project config with Prettier                                             |
| `npm run build`              | Emit production JavaScript to `dist/`                                                              |
| `npm run schemas`            | Print the actual registered MCP tool schemas                                                       |

Run the cheapest focused test first, then the broader commands when the change warrants them (`package.json`).

As verified on 2026-08-23 with the native Peekaboo child and its public-name/description overlay connected, published tool definitions cost 6,475 `o200k_base` tokens in `always` mode, 5,221 in `optional` mode, and 5,015 in the production `never` mode. The ten-tool Peekaboo block accounts for 2,809 tokens.

`npm run schemas` starts the MCP on an ephemeral localhost port, connects with the real MCP client, calls `tools/list`, and prints the returned tool definitions as formatted JSON. Pass tool names after `--` to filter the output, for example `npm run schemas -- shell_run fetch_website` (`scripts/tool-schemas.ts`, `src/server/http-server.ts`).

## Test Architecture

- Shell tests are split by responsibility: persistent-shell behavior lives in `test/shell-session.test.ts`, parallel batch execution in `test/shell-parallel.test.ts`, and named-shell lifecycle in `test/shell-session-manager.test.ts`. Lifecycle coverage includes LRU pressure eviction, busy-shell protection, idle hibernation, cwd/exported-environment restoration, cache expiry, destructive explicit close, and capture-failure behavior. Shared completion/polling helpers live in `test/helpers/shell.ts`; `test/mcp-integration.test.ts` additionally verifies explicit close through the public shell surface.
- MCP audit tests cover tool-call filtering, compact YAML formatting, MCP `in / out` token counts, slow/failure Better Comments tags, bounded response-body capture for token derivation, bounded `shell_run` command blocks, ordinary-argument truncation, successful `apply_patch` body omission, bounded failed-patch retention, and HTTP-boundary interception without contacting external services (`test/mcp-audit-log.test.ts`, `test/mcp-integration.test.ts`).
- Registration-boundary and output tests cover annotation compaction, canonical JSON Schema ordering, structured-output modes, compact Markdown projection, and pending-event injection (`test/tool-registration-boundary.test.ts`, `test/tool-output.test.ts`, `test/mcp-integration.test.ts`).
- Adapter tests cover child MCP discovery, transformed-name dispatch, native schema/result forwarding, missing configured tools, interrupted-action non-retry, next-call reconnect, webpage extraction, and cursors (`test/child-mcp.test.ts`, `test/web-fetch.test.ts`). Peekaboo coverage checks real vendored-binary discovery, exact `computer_*` names, the compact-description budget, representative native constraints, image compression, and visual-receipt compaction without performing a GUI action (`test/peekaboo-mcp.test.ts`). Its vendor smoke test also verifies both macOS architectures, fork build identity, and `--allow-foreground` support (`test/peekaboo-vendor.test.ts`, `vendor/peekaboo/provenance.json`). HTTP integration additionally verifies child metadata merging plus native image, structured, and error passthrough for an untransformed fixture provider (`test/integrations/computer.ts`). `apply_patch` wrapper behavior and real-binary partial/move semantics are covered by MCP integration tests; the vendored executable also has a host-architecture smoke test (`test/mcp-integration.test.ts`, `test/apply-patch-vendor.test.ts`, [apply_patch](./tools/apply_patch.md)).
- MCP integration tests validate the published tool order and Standard Schema mechanics, Zod rejection of malformed tool inputs before runtime services, all three model-facing output modes, compact output, one-shot pending-event delivery, final compact-output token logging, cross-request shell state, named-shell concurrency, direct patching, webpage pagination, Computer Use results, semantic errors, restart continuity, exact `/mcp` routing, and Host rejection. Tool and server prose descriptions/instructions are intentionally not assertion-locked because they are model-facing guidance that changes independently of behavior (`test/mcp-integration.test.ts`).
- Authentication unit tests cover durable state, owner-only permissions, first-owner binding, concurrent first calls, reset, and malformed-state failure. MCP integration tests additionally cover exact routing, local access, discovery without binding, binding on an invalid first tool call, same-owner reuse, different-owner rejection, and owner persistence across an HTTP restart (`test/auth.test.ts`, `test/mcp-integration.test.ts`).
- Subagent tests mirror the simplified production split: `test/chatgpt-subagent.test.ts` covers project start, persistent same-page multi-turn, pacing, capacity, rate limiting, and CDP availability; `test/chatgpt-subagent-browser.test.ts` covers exact prompt binding, v1 delta reconstruction, tool-call rejection, and conversation identity. MCP integration coverage keeps the unchanged public `subagent_run`/`subagent_result` schemas and stagger behavior.
- `test/live/subagent-live.test.ts` is a separate manual black-box canary for the real MCP subagent lifecycle. It is outside the `test/*.test.ts` glob, refuses to run in CI, and `npm run test:live:subagent` is the intended entry point. It starts the normal MCP HTTP server with the production ChatGPT subagent service and interacts only through public `subagent_run`/`subagent_result`. Turn 1 must start and return a non-empty response containing a random context key; Turn 2 uses the same `agent_id` and must return a non-empty response containing the remembered key. That is intentionally the whole behavioral assertion surface; protocol details, page identity, and conversation IDs belong to deterministic tests. The canary records poll timing/status plus failure details in ignored `test/live/artifacts/subagent-live-last.json` for post-failure diagnosis, never deliberately reloads the managed conversation itself, and has a live-test-only five-minute process hard cap in case the Playwright/CDP handle keeps Node alive after the test body finishes. Run it only when the authenticated dedicated Chrome is already running and no other subagent generation is active.

Tests use temporary directories and real local child shells; `test/helpers/temp.ts` centralizes disposable-directory cleanup. Process-group tests are POSIX-specific (`test/shell-session.test.ts`, `test/shell-parallel.test.ts`).

`npm ci` is the reproducible clean-install path. As verified on 2026-08-14, lint, type-check, tests, and build succeed on the supported macOS runtime, and `npm audit --omit=dev` reports no production dependency vulnerabilities (`package-lock.json`, `package.json`).

## Continuous Integration

GitHub Actions runs the same release validation sequence on both `macos-15` arm64 and `macos-15-intel` x64 runners for pushes to `main` and pull requests: clean install, lint, type-check, tests, and production build. The suite includes a direct vendored `apply_patch` smoke test, so each runner executes its native slice of the checked-in Universal 2 binary. The real-browser compatibility test is deliberately excluded because CI has no authenticated ChatGPT session; `test:live:subagent` consumes a real generated conversation (`.github/workflows/ci.yml`, `package.json`, `test/apply-patch-vendor.test.ts`, `test/live/`).

## Gaps

The normal/CI tests do not exercise the real `src/index.ts` composition path, `/healthz`, GET/DELETE 405 responses, signal-driven shutdown, tunnel configuration, a real browser launch, or Peekaboo's macOS permission and GUI-action paths used by `setup`/`setup:computer`. They do discover schemas from the real vendored Peekaboo binary. The generative live canary attaches to the real authenticated ChatGPT browser but does not own browser launch/setup (`test/`, `test/live/`, `scripts/peekaboo-permissions.mjs`, `src/index.ts`, `src/server/http-server.ts`, `src/tools/web/web-open.ts`, `src/tools/computer/peekaboo-mcp.ts`).

The checked-in live conversation IDs are account-specific. A future fixture bootstrap command should create normal and optional project conversations for the current authenticated account, store only their IDs in an ignored local file, and leave the shared parser fixture account-neutral.

Some `apply_patch` integration cases inject fake executables for deterministic caps/abort behavior; real-binary integration now covers partial application, failed-hunk reporting, and move+edit. Remaining parser observations and unsupported tolerances are tracked in [apply_patch](./tools/apply_patch.md) (`test/mcp-integration.test.ts`, `test/apply-patch-vendor.test.ts`).

## Related

- [Project Overview](./Project%20Overview.md)
- [Configuration and Startup](./Configuration%20and%20Startup.md)
- [MCP Tool Surface](./MCP%20Tool%20Surface.md)
- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
- [apply_patch](./tools/apply_patch.md)
