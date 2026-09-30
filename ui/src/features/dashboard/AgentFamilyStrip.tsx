import type { Agent } from "../../types"
import { AgentRoom } from "../agent-room/AgentRoom"
import { AgentStatusDot } from "./AgentStatusDot"

export function AgentFamilyStrip({
  rootId,
  agents,
  now,
  onSelect,
}: {
  rootId: string
  agents: Agent[]
  now: number
  onSelect: (id: string) => void
}) {
  if (agents.length === 0) return null
  return (
    <fieldset className="min-w-0 border-t pt-4" aria-label={`Agent family ${rootId}`}>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Agent family · {agents.length + 1}
      </h3>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {agents.map((agent) => {
          const isParent = agent.id === rootId
          return (
            <button
              key={agent.id}
              type="button"
              aria-label={`Show ${agent.id}${isParent ? ", parent" : ""}`}
              title={`${agent.id} · ${agent.taskSlug ?? "No task name yet"}`}
              onClick={() => onSelect(agent.id)}
              className={`min-w-0 overflow-hidden rounded-lg border text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-family-parent ${isParent ? "border-family-parent bg-family-parent/5 ring-1 ring-family-parent/40" : "bg-background/50 hover:border-muted-foreground"}`}
            >
              <AgentRoom agent={agent} preview />
              <div className="space-y-1 border-t px-2 py-2">
                <div className="flex h-4 min-w-0 items-center gap-1.5">
                  <AgentStatusDot active={now - agent.lastSeenAt < 30_000} />
                  <span className="truncate text-xs font-semibold">{agent.id}</span>
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {agent.taskSlug ?? "No task name yet"}
                </p>
                <p className="h-3 text-[9px] font-semibold tracking-wider text-family-parent">
                  {isParent ? "PARENT" : ""}
                </p>
              </div>
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
