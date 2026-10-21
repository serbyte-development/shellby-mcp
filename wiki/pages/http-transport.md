---
summary: "HTTP authorization, ngrok trust boundary, protocol compatibility, and connection lifetime."
paths:
  - src/server/http-server.ts
  - src/auth/
  - src/agent/dashboard-routes.ts
  - scripts/ui-phone.ts
  - ngrok-traffic-policy.yml
  - test/integrations/http-transport.ts
---

# HTTP Transport

## Trust boundary

[http-server.ts](../../src/server/http-server.ts) uses `createMcpExpressApp` with localhost Host/Origin guards. Direct loopback clients remain unauthenticated and retain local-user authority. Host/Origin protection is not caller authentication.

[ngrok-traffic-policy.yml](../../ngrok-traffic-policy.yml) admits the `com.openai.chatgpt` IP category, exposes only exact `/mcp`, removes an incoming remote marker, then adds `X-Shellby-Remote: 1` and rewrites Host to `localhost`. The marker means the deployment boundary already checked origin. A replacement proxy must preserve an equivalent contract.

For marked POST requests containing a named `tools/call`, [auth/store.ts](../../src/auth/store.ts) requires `X-OpenAI-Subject`. The first call binds the subject before dispatch, even if its tool is unknown or fails. Later calls require the same subject. Subject state survives restart in `<state_dir>/auth.json`; missing/invalid state fails closed. HTTP errors never echo the subject. Shellby does not use MCP OAuth or per-tool security schemes.

`X-OpenAI-Session` supplies coordination context, never authorization. [Agent Context](./agent-context.md) owns initialization, task labels, and caller-scoped state. Historical header evidence: [2026-08-09 observation](../raw/openai-mcp-identity-observation-2026-08-09.md).

## Routes and lifetime

- Exact `/mcp` uses a regex route because Express was initialized before strict routing could be enabled; `/mcp/` stays distinct.
- `/healthz` returns health plus `X-Shellby-Instance`, derived from repository and state directory. Startup uses it to reject another copy on the selected port; it is not authentication.
- Optional dashboard routes at `/`, `/editor` and `/api/*` share loopback guards but have no subject binding. Legacy `/ui/*` paths redirect. Checked-in ngrok policy excludes dashboard routes. Details: [Agent Context](./agent-context.md).

`createMcpHandler` obtains short-lived servers from the bound factory. SDK's modern protocol and explicit `legacy: "stateless"` path use the same registrations. SDK owns serving, streaming and teardown. HTTP owns auth, caller context and request-scoped [call tracking](./mcp-tool-registration-boundary.md#call-lifecycle); [composition](./architecture-map.md) owns capability lifetime.

The optional [ui:phone proxy](../../scripts/ui-phone.ts) listens on all interfaces and forwards allowlisted dashboard assets/API requests to loopback with a rewritten Host. It blocks `/mcp` but adds no authentication: LAN clients can observe and steer agents. This is a separate manually launched process, outside the ngrok policy and PM2 lifecycle; use only on a trusted network. UI build/setup routes live in the [UI wiki](../../ui/wiki/AGENTS.md).

No retained MCP HTTP session ID is required. Integration tests exercise an existing client after an isolated restart at the same URL. Process-local capabilities and `start_here` state still reset; changed schemas/instructions may require client refresh.

Validate with [transport integration cases](../../test/integrations/http-transport.ts), [auth cases](../../test/integrations/auth.ts), and [auth-store tests](../../test/auth/store.test.ts), through the runner in [Build and Test](./operations/build-and-test.md).
