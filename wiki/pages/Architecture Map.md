# Architecture Map

Verified 2026-08-09.

## Layers

| Layer                  | Responsibility                                                                            | Implementation                 |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Process entry          | Parse configuration, prepare workspace tooling, compose dependencies, handle shutdown     | `src/index.ts`                 |
| HTTP boundary          | Bind localhost, validate Host, expose health and MCP routes, own request transports       | `src/http-server.ts`           |
| MCP audit log          | Record every `tools/call` request and compact completion metadata without affecting dispatch | `src/mcp-audit-log.ts`      |
| MCP contract           | Publish instructions, schemas, annotations, and core tool handlers                        | `src/mcp-server.ts`            |
| Computer Use tools     | Publish eleven focused schemas, validate targets, and normalize compact MCP results        | `src/computer-use-tools.ts`    |
| Peekaboo adapter       | Invoke the CLI without a shell, serialize calls, parse bounded JSON, and retain snapshot targets | `src/peekaboo.ts`          |
| Shell manager          | Lazily create, route, limit, idle-evict, and close named shell runtimes                   | `src/shell-session-manager.ts` |
| Shell runtime          | Own the child shell, marker protocol, transcript, command records, reset, and recovery    | `src/shell-session.ts`         |
| Workspace integration  | Prepare the vendored Codex patch executable and workspace `PATH`                          | `src/workspace-tools.ts`       |
| Skill catalog          | Discover and load reusable workspace `SKILL.md` files dynamically                         | `src/skills.ts`                |
| Website fetching       | Produce Markdown, cleaned HTML, or raw rendered HTML and retain bounded cursor-addressed documents | `src/web-open.ts`         |
| ChatGPT subagents      | Attach to debuggable Chrome, retain caller-named agent/page state, submit turns, and normalize final responses | `src/chatgpt-subagent.ts` |

## Request Lifecycle

1. `src/index.ts` parses configuration, prepares the workspace, and creates a `ShellSessionManager`, shared `PeekabooClient`, shared `ChatGptSubagentModule`, and repository-local `McpAuditLogger`; webpage opening is composed at the HTTP boundary when not injected.
2. Each `POST /mcp` creates a short-lived `McpServer` and stateless `StreamableHTTPServerTransport` in `src/http-server.ts`. `tools/call` requests are recorded once at this boundary before dispatch, so auditing covers current and future MCP tools without tool-specific logging hooks (`src/http-server.ts`, `src/mcp-audit-log.ts`).
3. Shell handlers resolve `shell_id` through the shared shell manager. `skill_list` and `skill_load` read `<workspace>/skills` directly on each call, so catalog changes require no server rebuild. `chatgpt_subagent` resolves caller-named `agent_id` through the shared process-level subagent module. `apply_patch` bypasses the shell manager and directly spawns the prepared Codex executable. All request-scoped Computer Use handlers share the same process-level `PeekabooClient`.
4. The adapter serializes Computer Use calls and invokes `peekaboo` with `execFile`, exact argv, `--json`, a 30-second timeout, and a 4 MiB process-output cap. It checks the JSON `success` field and does not retry failures (`src/peekaboo.ts`).
5. Each `PersistentShellSession` writes commands into its own child login shell and detects completion through randomized control markers.
6. `computer_observe` reads Peekaboo's temporary PNG and encodes it as a same-dimension quality-75 JPEG while returning only essential snapshot metadata. `computer_inspect` separately invokes bounded `inspect-ui` text retrieval for a snapshot when AX is actually needed. The adapter retains at most 64 snapshot-to-capture-target mappings, and coordinate actions resolve through that mapping before reaching Peekaboo (`src/peekaboo.ts`, `src/computer-use-tools.ts`).

The named shell is the persistence boundary: callers using the same `shell_id` share state across independent MCP clients, while different IDs have independent cwd, environment, transcript, command records, reset lifecycle, and foreground-command lock (`src/http-server.ts`, `src/shell-session-manager.ts`, `test/mcp-integration.test.ts`).

`src/index.ts` is the composition root; adapters depend on Node APIs and installed binaries, while `src/mcp-server.ts` and `src/computer-use-tools.ts` own model-facing contracts. There is no database, hosted relay, UI, authentication layer, or per-client ownership mapping (`src/`).
