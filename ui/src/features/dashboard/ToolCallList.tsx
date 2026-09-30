import { IconAlertTriangle, IconCheck, IconLoader2 } from "@react-zero-ui/icon-sprite"
import { useState } from "react"

import type { Agent, AgentCall } from "../../types"
import { ToolCallModal } from "./ToolCallModal"
import { describeToolCall } from "./tool-call-presentation"

/** Owns call inspection by ID so an open modal receives live status and returned output. */
export function ToolCallList({ agent }: { agent: Agent }) {
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const calls = [agent.current, ...agent.recent].filter((call): call is AgentCall => Boolean(call))
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Recent
      </h3>
      {/* Reserve the same space for empty, short, and full histories when switching agents. */}
      <ul
        className="h-44 space-y-1 overflow-y-auto pr-1 scrollbar-gutter-stable"
        aria-label="Recent tool calls"
      >
        {calls.length === 0 ? (
          <li className="px-2 py-3 text-xs text-muted-foreground">No tool calls yet</li>
        ) : (
          calls.map((call) => (
            <li key={call.id}>
              <ToolCallRow call={call} onClick={() => setSelectedCallId(call.id)} />
            </li>
          ))
        )}
      </ul>
      <ToolCallModal
        call={calls.find((call) => call.id === selectedCallId)}
        onClose={() => setSelectedCallId(undefined)}
      />
    </div>
  )
}

function ToolCallRow({ call, onClick }: { call: AgentCall; onClick: () => void }) {
  const { icon: Icon, summary } = describeToolCall(call)
  const running = call.status === "running"
  const failed = call.status === "failed"
  const StatusIcon = failed ? IconAlertTriangle : running ? IconLoader2 : IconCheck
  const time = new Date(call.finishedAt ?? call.startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Inspect ${call.tool}: ${call.summary || summary} (${call.status})`}
      title={call.summary || summary}
      className={`flex h-14 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset ${failed ? "bg-danger-muted text-destructive hover:bg-destructive/15" : running ? "bg-success-muted/60 hover:bg-success-muted" : "hover:bg-muted/60"}`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background/60">
        <Icon
          className={`size-5 ${failed ? "text-destructive" : running ? "text-success" : "text-muted-foreground"}`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{call.tool}</span>
        </span>
        <span
          className={`mt-0 block truncate text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
        >
          {summary}
        </span>
      </span>

      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground justify-items-center">
        <StatusIcon
          className={`size-3 shrink-0 ${running ? "animate-spin text-accent" : failed ? "text-destructive" : "text-success"} mb-1`}
        />
        {running ? "now" : time}
      </span>
    </button>
  )
}
