# HTTP Transport

Verified 2026-08-15.

## What This Is

This page documents the local HTTP/MCP boundary, trusted remote path, subject binding, request lifetime, and audit interception.

## Routes and Middleware

- `createMcpExpressApp({ host, jsonLimit: "1mb" })` creates the Express app and applies the MCP v2 adapter's JSON parsing plus localhost Host/Origin guards. No custom `allowedOrigins` list is configured (`src/server/http-server.ts`).
- `GET /healthz` returns `{ "ok": true }` (`src/server/http-server.ts`).
- Exact `POST /mcp` is the only MCP endpoint; a regex route keeps `/mcp/` distinct because the MCP Express factory initializes Express routing before application code can enable strict routing. Direct localhost clients remain unauthenticated. Trusted tunnel traffic is marked by ngrok; on marked `tools/call` requests Unhinged Agent requires `X-OpenAI-Subject`, binds the first subject before dispatch, and requires that subject thereafter. The tool does not need to exist or succeed for the first call to bind (`src/server/http-server.ts`, `src/auth/auth.ts`).
- `GET` and `DELETE /mcp` return a JSON-RPC-shaped 405 response with `Allow: POST` (`src/server/http-server.ts`).
- Tool metadata continues to declare `noauth` because Unhinged Agent does not use MCP OAuth or per-tool security schemes; remote authorization is enforced at the HTTP/deployment boundary (`src/tools/shell/shell-tools.ts`, `src/tools/computer/computer-tools.ts`, `src/server/http-server.ts`).

The MCP Express Host/Origin guards protect the localhost HTTP listener from DNS-rebinding/browser-origin attacks; they are not caller authentication. The ngrok policy remains the remote trust boundary: it rejects traffic outside ngrok's `com.openai.chatgpt` IP category, exposes only exact `/mcp`, rewrites Host to `localhost:3333`, and adds `X-Unhinged-Agent-Remote: 1`. Unhinged Agent uses that marker only to distinguish already-origin-verified tunnel traffic from direct localhost clients (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`).

## ChatGPT Identity Metadata

OpenAI documents three opaque client-provided identifiers on MCP tool calls: `openai/subject` is an anonymized user ID for rate limiting and identification, `openai/session` is an anonymized conversation ID for correlating calls within one ChatGPT session, and `openai/organization` is an anonymized organization ID when available. Live ChatGPT traffic observed on 2026-08-09 also carried `X-OpenAI-Subject` and `X-OpenAI-Session` as HTTP headers; organization was observed in MCP `_meta`, not as an HTTP header. Across multiple conversations, subject remained stable while session changed.

Unhinged Agent currently uses `X-OpenAI-Subject` as the remote owner identifier (`src/server/http-server.ts`, `src/auth/auth.ts`). Treat subject as an identifier rather than a secret or standalone proof of origin. `openai/organization` may be useful as optional future context but must not be assumed present; `openai/session` is conversation-scoped and unsuitable for durable user binding. OpenAI marks `openai/userAgent` and `openai/userLocation` as best-effort hints that must not be relied on for authorization.

## Connection Model

Every accepted POST creates a new v2 `McpServer` and `NodeStreamableHTTPServerTransport` with no session ID generator. The response's `finish` or `close` event closes that request's transport/server, while all requests share the process-level `ShellSessionManager`, `WebPageOpener`, `PeekabooClient`, `ChatGptSubagentService`, and production `UnhingedAgentAuthStore`. The HTTP boundary creates default services or accepts explicit instances for production-specific behavior and tests (`src/server/http-server.ts`, `src/index.ts`).

When `src/index.ts` starts the production server it also injects one `McpAuditLogger`. The HTTP boundary inspects only JSON-RPC `tools/call` requests and writes one compact YAML document to `agent-commands.yaml` when each call finishes. Entries contain the tool name and duration plus bounded input context: `shell_run` gets a block scalar, ordinary arguments are truncated, successful `apply_patch` calls retain only cwd and patch size, and failed patches also retain a bounded failure message plus up to 32,000 characters of patch text. The response path counts bytes and model-facing input/output tokens when the complete response is available but does not persist ordinary response bodies. Calls at least 8 KiB are marked `?`, calls at least 5 seconds are marked `~`, failures are marked `!`, and normal calls have no Better Comments tag. Audit failures are best-effort and never alter MCP dispatch (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit-log.ts`).

Because no MCP session ID is retained by the HTTP layer, an existing client can send its next request after the server is rebuilt and restarted on the same URL without reconnecting. The bound owner survives because it lives outside the repository in `~/.unhinged-agent/auth.json`; process-local shell and webpage-cache state still reset. ChatGPT needs an app refresh when advertised tool metadata or server instructions change (`src/auth/auth.ts`, `src/server/http-server.ts`).

In-flight request closers are tracked so startup failure and server shutdown can settle them before closing the shell. HTTP shutdown begins before shell shutdown (`src/server/http-server.ts`, `src/index.ts`).

Integration tests prove state sharing across SDK clients, continued client use after a stop/start on the same port, and HTTP 403 for an attacker-controlled Host (`test/mcp-integration.test.ts`).

## Related

- [[pages/Project Overview]]
- [[pages/Architecture Map]]
- [[pages/Configuration and Startup]]
- [[pages/MCP Tool Surface]]
- [[pages/Open Questions and Risks]]
