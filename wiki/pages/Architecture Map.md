# Architecture Map

Verified 2026-08-06.

## Layers

| Layer                  | Responsibility                                                                            | Implementation                 |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Process entry          | Parse configuration, prepare workspace tooling, compose dependencies, handle shutdown     | `src/index.ts`                 |
| HTTP boundary          | Bind localhost, validate Host, expose health and MCP routes, own request transports       | `src/http-server.ts`           |
| MCP contract           | Publish instructions, schemas, annotations, and core tool handlers                        | `src/mcp-server.ts`            |
| Computer Use tools     | Publish eleven focused schemas, validate targets, and normalize compact MCP results        | `src/computer-use-tools.ts`    |
| Peekaboo adapter       | Invoke the CLI without a shell, serialize calls, parse bounded JSON, and retain snapshot targets | `src/peekaboo.ts`          |
| Shell manager          | Lazily create, route, limit, idle-evict, and close named shell runtimes                   | `src/shell-session-manager.ts` |
| Shell runtime          | Own the child shell, marker protocol, transcript, command records, reset, and recovery    | `src/shell-session.ts`         |
| Workspace integration  | Prepare the vendored Codex patch executable and workspace `PATH`                          | `src/workspace-tools.ts`       |
| Website fetching       | Produce Markdown, cleaned HTML, or raw rendered HTML and retain bounded cursor-addressed documents | `src/web-open.ts`         |

## Request Lifecycle

1. `src/index.ts` parses configuration, prepares the workspace, and creates a `ShellSessionManager`, `WebPageOpener`, and shared `PeekabooClient`.
2. Each `POST /mcp` creates a short-lived `McpServer` and stateless `StreamableHTTPServerTransport` in `src/http-server.ts`.
3. Shell handlers resolve `shell_id` through the shared shell manager. `apply_patch` bypasses that manager and directly spawns the prepared Codex executable in its required absolute `cwd`. All request-scoped Computer Use handlers share the same process-level `PeekabooClient`.
4. The adapter serializes Computer Use calls and invokes `peekaboo` with `execFile`, exact argv, `--json`, a 30-second timeout, and a 4 MiB process-output cap. It checks the JSON `success` field and does not retry failures (`src/peekaboo.ts`).
5. Each `PersistentShellSession` writes commands into its own child login shell and detects completion through randomized control markers.
6. `computer_observe` reads Peekaboo's temporary PNG and encodes it as a same-dimension quality-75 JPEG while returning only essential snapshot metadata. `computer_inspect` separately invokes bounded `inspect-ui` text retrieval for a snapshot when AX is actually needed. The adapter retains at most 64 snapshot-to-capture-target mappings, and coordinate actions resolve through that mapping before reaching Peekaboo (`src/peekaboo.ts`, `src/computer-use-tools.ts`).

The named shell is the persistence boundary: callers using the same `shell_id` share state across independent MCP clients, while different IDs have independent cwd, environment, transcript, command records, reset lifecycle, and foreground-command lock (`src/http-server.ts`, `src/shell-session-manager.ts`, `test/mcp-integration.test.ts`).

`src/index.ts` is the composition root; adapters depend on Node APIs and installed binaries, while `src/mcp-server.ts` and `src/computer-use-tools.ts` own model-facing contracts. There is no database, hosted relay, UI, authentication layer, or per-client ownership mapping (`src/`).
