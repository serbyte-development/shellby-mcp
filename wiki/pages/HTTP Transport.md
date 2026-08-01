# HTTP Transport

Verified 2026-08-01.

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

In-flight request closers are tracked so startup failure and server shutdown can settle them before closing the shell. HTTP shutdown begins before shell shutdown (`src/http-server.ts`, `src/index.ts`).

## Contract Tests

The integration test connects two separate SDK clients and proves shell state survives between them. It also posts with an attacker-controlled Host value and expects HTTP 403 (`test/mcp-integration.test.ts`).

## Related

- [[pages/Architecture Map]]
- [[pages/MCP Tool Surface]]
- [[pages/Open Questions and Risks]]
