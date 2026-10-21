---
summary: "Snapshot/SSE recovery, agent families, local dismissals, steering targets, and tool-call inspection."
paths:
  - src/App.tsx
  - vite.config.ts
  - src/hooks/useAgents.ts
  - src/lib/api.ts
  - src/types.ts
  - src/features/dashboard/
---

# Runtime and Interaction Map

## Data Flow

[useAgents](../../src/hooks/useAgents.ts) loads `GET /api/agents` and subscribes to `/api/events`. Each `agent_changed` replaces that agent in place; newly observed agents append. Events received during a snapshot request override that snapshot. A newer request supersedes an older one, including discarded Strict Mode subscriptions.

SSE has no replay. Each successful connection refreshes the snapshot so calls completed while disconnected reappear. Preserve both reconnect refresh and event/snapshot ordering when changing this hook.

[types.ts](../../src/types.ts) mirrors backend [observer](../../../src/agent/observer.ts) snapshots, including `parentId`, bounded call history, response previews and cumulative tool usage. Usage comes from backend call tracking and survives history eviction; do not recompute it from recent rows or sum families into one agent's totals.

## Component Ownership

| Area | Owner | Durable behavior |
| --- | --- | --- |
| Page shell / connection indicator | `src/App.tsx` | Active means `lastSeenAt` within 30 seconds. |
| Family workspace | `src/features/dashboard/AgentCard.tsx` | Selected agent's room, activity and steering; other family members in `AgentFamilyStrip`. |
| Live data | `src/hooks/useAgents.ts` | Snapshot + SSE replacement model. |
| Local visibility | `src/features/dashboard/useDashboardAgents.ts` | Browser-persisted agent and delivered-instruction dismissals. |
| API calls | `src/lib/api.ts` | Relative `/api/...` URLs only. |
| Steering | `src/features/dashboard/SteerComposer.tsx` | Queue/cancel against selected agent's ID. |
| Tool details | `src/features/dashboard/ToolCallList.tsx`, `ToolCallModal.tsx` | Captured input/response and measured token counts. |
| Agent room | `src/features/agent-room/` | Canvas runtime, layout/rendering, Pixel Agents catalog/storage, and editor. |
| Room editor | `src/features/agent-room/editor/RoomEditor.tsx` | Orchestrate editor state, pointer behavior, persistence, and layout mutation. |

## Family and dismissal boundaries

[agent-families.ts](../../src/features/dashboard/agent-families.ts) groups visible agents under their highest known ancestor using server `parentId`. Dismissed agents supply ancestry without becoming visible members. Missing parents still provide a grouping key. Backend [Agent Context](../../../wiki/pages/agent-context.md#observed-parent-links) owns lineage evidence; UI must not infer it from names, task labels or timing.

[AgentCard](../../src/features/dashboard/AgentCard.tsx) selects one visible family member. Its workspace is keyed by agent ID and `firstSeenAt`: switching agents remounts drafts, modals and room animation so none target the wrong agent. Dismissing the selection chooses a remaining member; later activity must not steal selection back.

[useDashboardAgents](../../src/features/dashboard/useDashboardAgents.ts) persists presentation preferences only. Dismissed cards reappear when server `lastSeenAt` advances. Preferences belong to the matching `firstSeenAt` incarnation because aliases can be reused after restart. Delivered-instruction dismissals survive remount/refresh; queued instructions remain visible. Dismissal never cancels work or deletes server history.

## Steering Contract

`POST /api/agents/:agentId/steer` queues human instruction. Server injects queued instruction into a later dispatched tool response. `DELETE /api/agents/:agentId/instructions/:instructionId` cancels only still-queued instruction. Delivery means notice collection by the backend, not upstream execution or confirmed client receipt.

UI status meanings:

- amber clock: queued on server;
- green check: delivered by server;
- red alert: request failed;
- `Dismiss` for delivered status changes local presentation only.

## Tool Calls

Recent list includes current call followed by retained recent calls. Row click opens input/response inspection. Backend owns bounded previews; [tool-call-presentation.ts](../../src/features/dashboard/tool-call-presentation.ts) adds display labels, and [highlight-tool-text.ts](../../src/features/dashboard/highlight-tool-text.ts) owns safe highlighting. Labels and truncated previews are not execution evidence. Token counts come from complete tracked text before preview truncation.

Do not derive operational truth from pixel-room queue. Room intentionally lags fast calls for readability. See [Agent Room](./agent-room.md).

## Server Boundary

Backend [dashboard-routes.ts](../../../src/agent/dashboard-routes.ts) mounts static `/`, `/editor` and `/api/*`. Legacy `/ui/*` requests redirect with HTTP 308 to preserve methods, bodies and old asset URLs. [HTTP Transport](../../../wiki/pages/http-transport.md) owns loopback/ngrok boundaries and the optional unauthenticated `ui:phone` LAN proxy. Tool execution/steering delivery lives at the [registration boundary](../../../wiki/pages/mcp-tool-registration-boundary.md).

Production assets use the same configured port as MCP. [vite.config.ts](../../vite.config.ts) proxies `/api` to root `port` through the shared config loader, so a second checkout reaches its own backend. Run config-only setup if config is missing. Root `ui:install`/`ui:build` manage frontend separately from backend build/start; `ui:dev` uses Vite. `ui:phone` requires enabled backend and built assets.

Validation: [family grouping](../../../test/ui/agent-families.test.ts), [tool labels](../../../test/ui/tool-call-presentation.test.ts), [highlighting](../../../test/ui/highlight-tool-text.test.ts), and opt-in [dashboard integration](../../../test/ui/dashboard.test.ts) through `npm run test:ui`.
