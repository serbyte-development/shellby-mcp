# HTTP Transport

Verified 2026-08-07.

## Routes and Middleware

- Express parses JSON with a 1 MiB limit and applies the MCP SDK's localhost Host-header validator before routes (`src/http-server.ts`).
- `GET /healthz` returns `{ "ok": true }` (`src/http-server.ts`).
- `POST /mcp` is the only MCP method. `GET /mcp` and `DELETE /mcp` return a JSON-RPC-shaped 405 response with `Allow: POST` (`src/http-server.ts`).
- There is no CORS or authentication middleware. Tool metadata declares `noauth` (`src/mcp-server.ts`).

Host validation protects a localhost listener from mismatched Host headers; it is not caller authentication. The ngrok helper rewrites Host to `localhost:3333` so requests pass this validation (`ngrok-traffic-policy.yml`, `package.json`).

## Connection Model

Every POST creates a new `McpServer` and `StreamableHTTPServerTransport` with no session ID generator. The response's `finish` or `close` event closes that request's transport/server, while all requests share the injected `ShellSessionManager`, `WebPageOpener`, `PeekabooClient`, and `ChatGptSubagentService` (`src/http-server.ts`).

When `src/index.ts` starts the production server it also injects one `McpAuditLogger`. The HTTP boundary inspects only JSON-RPC `tools/call` requests and writes the tool name plus input character count to `agent-commands.log`. Most tools retain their full serialized arguments; `apply_patch` omits the patch body while preserving its character count and remaining parameters, and `shell_run` writes command text as a readable block separate from the other arguments. Completion lines record the serialized JSON-RPC result/error character count, duration, HTTP status, and whether the response finished or closed. Full tool output is not persisted. Audit failures are best-effort and never alter MCP dispatch (`src/index.ts`, `src/http-server.ts`, `src/mcp-audit-log.ts`).

Because no MCP session ID is retained by the HTTP layer, an existing client can send its next request after the server is rebuilt and restarted on the same URL without reconnecting. Requests already in flight may fail, and the restart discards process-local shell and webpage-cache state. ChatGPT still needs an app refresh when the advertised tool metadata or server instructions change.

In-flight request closers are tracked so startup failure and server shutdown can settle them before closing the shell. HTTP shutdown begins before shell shutdown (`src/http-server.ts`, `src/index.ts`).

Integration tests prove state sharing across SDK clients, continued client use after a stop/start on the same port, and HTTP 403 for an attacker-controlled Host (`test/mcp-integration.test.ts`).
