# HTTP Transport

Verified 2026-08-10.

## Routes and Middleware

- `createMcpExpressApp({ host, jsonLimit: "1mb" })` creates the Express app and applies the MCP v2 adapter's JSON parsing plus localhost Host/Origin guards. No custom `allowedOrigins` list is configured (`src/server/http-server.ts`).
- `GET /healthz` returns `{ "ok": true }` (`src/server/http-server.ts`).
- Exact `POST /mcp` is the only MCP endpoint; a regex route keeps `/mcp/` distinct because the MCP Express factory initializes Express routing before application code can enable strict routing. Direct localhost clients remain unauthenticated. Trusted tunnel traffic is marked by ngrok; on marked `tools/call` requests Shelly requires `X-OpenAI-Subject`, binds the first subject before dispatch, and requires that subject thereafter. The tool does not need to exist or succeed for the first call to bind (`src/server/http-server.ts`, `src/auth/auth.ts`).
- `GET` and `DELETE /mcp` return a JSON-RPC-shaped 405 response with `Allow: POST` (`src/server/http-server.ts`).
- Tool metadata continues to declare `noauth` because Shelly does not use MCP OAuth or per-tool security schemes; remote authorization is enforced at the HTTP/deployment boundary (`src/tools/shell/shell-tools.ts`, `src/tools/computer/computer-tools.ts`, `src/server/http-server.ts`).

The MCP Express Host/Origin guards protect the localhost HTTP listener from DNS-rebinding/browser-origin attacks; they are not caller authentication. The ngrok policy remains the remote trust boundary: it rejects traffic outside ngrok's `com.openai.chatgpt` IP category, exposes only exact `/mcp`, rewrites Host to `localhost:3333`, and adds `X-Shelly-Remote: 1`. Shelly uses that marker only to distinguish already-origin-verified tunnel traffic from direct localhost clients (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`).

## ChatGPT Identity Metadata

OpenAI documents three opaque client-provided identifiers on MCP tool calls: `openai/subject` is an anonymized user ID for rate limiting and identification, `openai/session` is an anonymized conversation ID for correlating calls within one ChatGPT session, and `openai/organization` is an anonymized organization ID when available. Live ChatGPT traffic observed on 2026-08-09 also carried `X-OpenAI-Subject` and `X-OpenAI-Session` as HTTP headers; organization was observed in MCP `_meta`, not as an HTTP header. Across multiple conversations, subject remained stable while session changed.

Shelly currently uses `X-OpenAI-Subject` as the remote owner identifier (`src/server/http-server.ts`, `src/auth/auth.ts`). Treat subject as an identifier rather than a secret or standalone proof of origin. `openai/organization` may be useful as optional future context but must not be assumed present; `openai/session` is conversation-scoped and unsuitable for durable user binding. OpenAI marks `openai/userAgent` and `openai/userLocation` as best-effort hints that must not be relied on for authorization.

## Connection Model

Every accepted POST creates a new v2 `McpServer` and `NodeStreamableHTTPServerTransport` with no session ID generator. The response's `finish` or `close` event closes that request's transport/server, while all requests share the injected `ShellSessionManager`, `WebPageOpener`, `PeekabooClient`, `ChatGptSubagentService`, and production `ShellyAuthStore` (`src/server/http-server.ts`, `src/index.ts`).

When `src/index.ts` starts the production server it also injects one `McpAuditLogger`. The HTTP boundary inspects only JSON-RPC `tools/call` requests and writes the tool name plus input character count to `agent-commands.log`. Most tools retain their full serialized arguments; `apply_patch` omits the patch body while preserving its character count and remaining parameters, and `shell_run` writes command text as a readable block separate from the other arguments. Completion lines record the serialized JSON-RPC result/error character count, duration, HTTP status, and whether the response finished or closed. Full tool output is not persisted. Audit failures are best-effort and never alter MCP dispatch (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit-log.ts`).

Because no MCP session ID is retained by the HTTP layer, an existing client can send its next request after the server is rebuilt and restarted on the same URL without reconnecting. The bound owner survives because it lives outside the repository in `~/.shelly/auth.json`; process-local shell and webpage-cache state still reset. ChatGPT needs an app refresh when advertised tool metadata or server instructions change (`src/auth/auth.ts`, `src/server/http-server.ts`).

In-flight request closers are tracked so startup failure and server shutdown can settle them before closing the shell. HTTP shutdown begins before shell shutdown (`src/server/http-server.ts`, `src/index.ts`).

Integration tests prove state sharing across SDK clients, continued client use after a stop/start on the same port, and HTTP 403 for an attacker-controlled Host (`test/mcp-integration.test.ts`).
