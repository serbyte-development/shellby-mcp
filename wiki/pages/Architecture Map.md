# Architecture Map

Verified 2026-08-01.

## What This Is

ChatGPT Local Shell MCP is a private Node.js/TypeScript service that exposes bounded named persistent shells, webpage extraction, and an optional allowlisted bridge to ChatGPT's installed Computer Use child MCP over Streamable HTTP (`package.json`, `src/index.ts`, `src/mcp-server.ts`).

## Layers

| Layer                  | Responsibility                                                                            | Implementation                 |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Process entry          | Parse configuration, prepare workspace tooling, compose dependencies, handle shutdown     | `src/index.ts`                 |
| HTTP boundary          | Bind localhost, validate Host, expose health and MCP routes, own request transports       | `src/http-server.ts`           |
| MCP contract           | Publish instructions, schemas, annotations, and core tool handlers                        | `src/mcp-server.ts`            |
| Computer Use wrappers  | Publish six fixed schemas and forward complete MCP content blocks                         | `src/computer-use-tools.ts`    |
| Computer Use manager   | Discover, lazily launch, validate, serialize, reconnect, and close the child MCP           | `src/computer-use-manager.ts`  |
| Shell manager          | Lazily create, route, limit, idle-evict, and close named shell runtimes                   | `src/shell-session-manager.ts` |
| Shell runtime          | Own the child shell, marker protocol, transcript, command records, reset, and recovery    | `src/shell-session.ts`         |
| Workspace integration  | Make the bundled Codex patch executable available through `PATH`                          | `src/workspace-tools.ts`       |
| Webpage extraction     | Render pages, extract Markdown, and retain bounded cursor-addressed documents              | `src/web-open.ts`              |

## Request Lifecycle

1. `src/index.ts` creates a `ShellSessionManager` and resolves the installed Computer Use launcher without starting it.
2. Each `POST /mcp` creates a short-lived `McpServer` and stateless `StreamableHTTPServerTransport` in `src/http-server.ts`.
3. Shell handlers resolve `shell_id` through the shared shell manager. Computer Use handlers share one process-level `ComputerUseManager`.
4. The first Computer Use call launches the installed child MCP over stdio, validates the six expected schemas, and forwards the call serially.
5. Each `PersistentShellSession` writes commands into its own child login shell and detects completion through randomized control markers.
6. Shell snapshots remain bounded, while Computer Use forwards child text, image, structured content, metadata, and error state without flattening them.

The named shell is the persistence boundary: callers using the same `shell_id` share state across independent MCP clients, while different IDs have independent cwd, environment, transcript, command records, reset lifecycle, and foreground-command lock (`src/http-server.ts`, `src/shell-session-manager.ts`, `test/mcp-integration.test.ts`).

## Dependency Direction

`src/index.ts` composes all modules. `src/http-server.ts` owns the shared shell and Computer Use managers. `src/mcp-server.ts` publishes the request-scoped MCP contract. `src/computer-use-manager.ts` depends only on the MCP client SDK and installed launcher. `src/workspace-tools.ts` is independent. There is no database, hosted relay, UI, authentication layer, or automatic per-client ownership mapping (`src/`).

## Related

- [[pages/HTTP Transport]]
- [[pages/MCP Tool Surface]]
- [[pages/Persistent Shell Runtime]]
- [[pages/Configuration and Startup]]
