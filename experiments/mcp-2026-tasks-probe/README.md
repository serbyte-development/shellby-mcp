# Temporary MCP 2026 + Tasks Probe

**Deferred future experiment.** Do not run or wire this into normal Unhinged Agent development unless the MCP 2026/Tasks roadmap item is intentionally resumed.

This directory is a disposable compatibility test. It does not import or modify Unhinged Agent's normal `/mcp` server.

It tests two client capabilities in one manual ChatGPT invocation:

1. MCP protocol era `2026-07-28`. The server runs modern-only with the SDK's `createMcpHandler(..., { legacy: "reject" })`; 2025-era initialization is rejected.
2. The current `io.modelcontextprotocol/tasks` extension. The server advertises the extension through `server/discover`. When the client declares the same extension on `tools/call`, the probe returns `resultType: "task"`; the client must poll `tasks/get` to receive the final result.

The extension shim is local to `server.ts` because the installed TypeScript MCP SDK 2.0 supports the 2026-07-28 core protocol but intentionally does not implement the new Tasks extension runtime. The obsolete 2025-11-25 task request flag, `capabilities.tasks`, `execution.taskSupport`, `tasks/list`, and `tasks/result` are not used.

## Run

The temporary server defaults to Unhinged Agent's local port so the existing ngrok URL can be reused. Stop only the normal MCP process; leave the ngrok PM2 process running.

```bash
cd /path/to/unhinged-agent
npx pm2 stop unhinged-agent-mcp
node --import tsx temporary/mcp-2026-tasks-probe/server.ts
```

The MCP endpoint is `http://127.0.0.1:3333/mcp`. If the normal ngrok process is already forwarding port 3333, it can keep using the same public URL. Otherwise start `npm run tunnel` in a second terminal. Then update/refresh the ChatGPT MCP app so it rediscovers the temporary server.

In a new ChatGPT conversation, ask it to call `temporary_2026_tasks_probe`.

## Interpret

- `MCP_2026_OK__TASKS_EXTENSION_OK`: ChatGPT used MCP 2026-07-28, declared `io.modelcontextprotocol/tasks`, accepted `resultType: "task"`, called `tasks/get` with current routing headers, and surfaced the final task result.
- `MCP_2026_OK__TASKS_EXTENSION_NOT_DECLARED`: ChatGPT successfully used MCP 2026-07-28, but did not declare the Tasks extension on the tool call. The tool therefore completed synchronously.
- Tool cannot be discovered/called and ChatGPT reports protocol negotiation failure: ChatGPT did not successfully use the required 2026-07-28 era against this modern-only endpoint.
- Tool starts but fails after task creation / never returns the success marker: ChatGPT declared the Tasks extension but did not successfully complete the current task lifecycle.

## Test

```bash
node --import tsx --test temporary/mcp-2026-tasks-probe/server.test.ts
npx tsc -p temporary/mcp-2026-tasks-probe/tsconfig.json
```

Delete `temporary/mcp-2026-tasks-probe` after the manual compatibility decision.

After testing, stop the temporary server with `Ctrl-C` and restore normal Unhinged Agent with `npm run restart`.
