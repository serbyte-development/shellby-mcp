# HTTP Transport

Verified 2026-08-04.

## What This Is

The HTTP layer adapts stateless MCP Streamable HTTP requests to one process-wide `ShellSessionManager` and webpage cache (`src/http-server.ts`).

## Routes and Middleware

- Express parses JSON with a 1 MiB limit and applies the MCP SDK's localhost Host-header validator before routes (`src/http-server.ts`).
- `GET /healthz` returns `{ "ok": true }` (`src/http-server.ts`).
- `POST /mcp` is the only MCP method. `GET /mcp` and `DELETE /mcp` return a JSON-RPC-shaped 405 response with `Allow: POST` (`src/http-server.ts`).
- There is no CORS or authentication middleware. Tool metadata declares `noauth` (`src/mcp-server.ts`).

Host validation protects a localhost listener from mismatched Host headers; it is not caller authentication. The ngrok helper rewrites Host to `localhost:3333` so requests pass this validation (`ngrok-traffic-policy.yml`, `package.json`).

## Connection Model

Every POST creates a new `McpServer` and `StreamableHTTPServerTransport` with no session ID generator. The response's `finish` or `close` event closes that request's transport/server, while all requests share the injected `ShellSessionManager` and `WebPageOpener` (`src/http-server.ts`).

Because no MCP session ID is retained by the HTTP layer, an existing client can send its next request after the server is rebuilt and restarted on the same URL without reconnecting. Requests already in flight may fail, and the restart discards process-local shell and webpage-cache state. ChatGPT still needs an app refresh when the advertised tool metadata or server instructions change.

In-flight request closers are tracked so startup failure and server shutdown can settle them before closing the shell. HTTP shutdown begins before shell shutdown (`src/http-server.ts`, `src/index.ts`).

## Contract Tests

The integration tests connect two separate SDK clients and prove shell state survives between them. They also keep one client alive across a full HTTP server stop/start cycle on the same port and prove its next tool call succeeds without reconnecting. A separate test posts with an attacker-controlled Host value and expects HTTP 403 (`test/mcp-integration.test.ts`).

## Related

- [[pages/Architecture Map]]
- [[pages/MCP Tool Surface]]
- [[pages/Open Questions and Risks]]
