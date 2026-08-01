# Architecture Map

Verified 2026-07-19.

## What This Is

ChatGPT Local Shell MCP is a private Node.js/TypeScript service that exposes bounded named persistent shells through four MCP tools over Streamable HTTP (`package.json`, `src/index.ts`, `src/mcp-server.ts`).

## Layers

| Layer                 | Responsibility                                                                         | Implementation                 |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| Process entry         | Parse configuration, prepare workspace tooling, compose dependencies, handle shutdown  | `src/index.ts`                 |
| HTTP boundary         | Bind localhost, validate Host, expose health and MCP routes, own request transports    | `src/http-server.ts`           |
| MCP contract          | Publish instructions, schemas, annotations, and tool handlers                          | `src/mcp-server.ts`            |
| Shell manager         | Lazily create, route, limit, idle-evict, and close named shell runtimes                | `src/shell-session-manager.ts` |
| Shell runtime         | Own the child shell, marker protocol, transcript, command records, reset, and recovery | `src/shell-session.ts`         |
| Workspace integration | Make the bundled Codex patch executable available through `PATH`                       | `src/workspace-tools.ts`       |

## Request Lifecycle

1. `src/index.ts` creates a `ShellSessionManager` backed by a configured `PersistentShellSession` factory.
2. Each `POST /mcp` creates a short-lived `McpServer` and stateless `StreamableHTTPServerTransport` in `src/http-server.ts`.
3. Tool handlers in `src/mcp-server.ts` resolve `shell_id` through the shared manager.
4. Each `PersistentShellSession` writes commands into its own child login shell and detects completion through randomized control markers.
5. Structured snapshots return bounded transcript slices and cursors to the caller.

The named shell is the persistence boundary: callers using the same `shell_id` share state across independent MCP clients, while different IDs have independent cwd, environment, transcript, command records, reset lifecycle, and foreground-command lock (`src/http-server.ts`, `src/shell-session-manager.ts`, `test/mcp-integration.test.ts`).

## Dependency Direction

`src/index.ts` composes all modules. `src/http-server.ts` depends on the MCP contract and shell manager; `src/mcp-server.ts` depends on the manager and shell runtime; `src/workspace-tools.ts` is independent. There is no database, hosted relay, UI, authentication layer, or automatic per-client ownership mapping (`src/`).

## Related

- [[pages/HTTP Transport]]
- [[pages/MCP Tool Surface]]
- [[pages/Persistent Shell Runtime]]
- [[pages/Configuration and Startup]]
