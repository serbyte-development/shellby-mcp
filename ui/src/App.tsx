import {
  IconActivity,
  IconPencil,
  IconRefresh,
  IconWifi,
  IconWifiOff,
} from "@react-zero-ui/icon-sprite"
import { useEffect, useState } from "react"

import { ThemeSelect } from "./components/ThemeSelect"
import { Button } from "./components/ui/button"
import { WorkspaceHeader } from "./components/WorkspaceHeader"
import { RoomEditor } from "./features/agent-room/editor/RoomEditor"
import { AgentCard } from "./features/dashboard/AgentCard"
import { groupAgentFamilies } from "./features/dashboard/agent-families"
import { useDashboardAgents } from "./features/dashboard/useDashboardAgents"

export function App() {
  const editorRoute =
    window.location.pathname.replace(/\/+$/u, "") === "/editor" ||
    new URLSearchParams(window.location.search).has("editor")
  if (editorRoute) return <RoomEditor />
  return <Dashboard />
}

function Dashboard() {
  const {
    agents,
    dismissedAgents,
    dismissAgent,
    restoreAgent,
    dismissInstruction,
    connected,
    loading,
    error,
  } = useDashboardAgents()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const activeCount = [...agents, ...dismissedAgents].filter(
    (agent) => now - agent.lastSeenAt < 30_000
  ).length

  return (
    <main className="min-h-screen">
      <WorkspaceHeader
        title="Shellby Control"
        description={`${activeCount} active · ${agents.length + dismissedAgents.length} observed`}
        leading={
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent-muted text-accent shadow-panel">
            <IconActivity className="size-5" />
          </div>
        }
      >
        <div
          className={`mr-2 hidden items-center gap-1.5 text-xs sm:flex ${connected ? "text-success" : "text-muted-foreground"}`}
        >
          {connected ? <IconWifi className="size-3.5" /> : <IconWifiOff className="size-3.5" />}
          {connected ? "Live" : "Reconnecting"}
        </div>
        <ThemeSelect />
        <Button variant="outline" size="sm" onClick={() => (window.location.href = "/editor")}>
          <IconPencil className="size-3.5" />
          Edit room
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          <IconRefresh className="size-3.5" />
          Refresh
        </Button>
      </WorkspaceHeader>

      <div className="mx-auto max-w-375 px-4 py-5 lg:px-6">
        {error ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="py-24 text-center text-sm text-muted-foreground">
            Loading Shellby agents...
          </div>
        ) : agents.length === 0 ? (
          <div className="mx-auto max-w-lg rounded-xl border bg-card px-6 py-20 text-center shadow-card">
            <IconActivity className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-4 text-lg font-semibold">
              {dismissedAgents.length > 0 ? "All agents are dismissed" : "No agents observed yet"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {dismissedAgents.length > 0
                ? "Restore an agent below, or wait for new activity."
                : "Agents will appear here automatically when they make a Shellby MCP tool call."}
            </p>
          </div>
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-2">
            {groupAgentFamilies(agents, dismissedAgents).map((family) => (
              <AgentCard
                key={family.rootId}
                family={family}
                now={now}
                onDismiss={dismissAgent}
                onDismissInstruction={dismissInstruction}
              />
            ))}
          </div>
        )}

        {dismissedAgents.length > 0 ? (
          <details className="mt-6 rounded-xl border bg-card px-4 py-3 shadow-card">
            <summary className="cursor-pointer text-sm font-medium">
              Dismissed agents ({dismissedAgents.length})
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              Agents return automatically when they become active again.
            </p>
            <ul className="mt-3 divide-y">
              {dismissedAgents.map((agent) => (
                <li key={agent.id} className="flex items-center justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{agent.id}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {agent.taskSlug ?? "No task name yet"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Restore ${agent.id}`}
                    onClick={() => restoreAgent(agent)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </main>
  )
}
