import { IconAlertTriangle, IconCheck, IconLoader2 } from "@react-zero-ui/icon-sprite"
import { useState } from "react"

import { CardPanel } from "../../components/ui/card"
import type { Agent, AgentCall } from "../../types"
import { ToolCallModal } from "./ToolCallModal"
import { describeToolCall } from "./tool-call-presentation"

/** Owns call inspection by ID so an open modal receives live status and returned output. */
export function ToolCallList({ agent }: { agent: Agent }) {
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const calls = [agent.current, ...agent.recent].filter((call): call is AgentCall => Boolean(call))
  return (
    <CardPanel title="Recent activity">
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
    </CardPanel>
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
      className={`flex h-14 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50 ${failed ? "bg-danger-muted text-destructive hover:bg-destructive/15" : running ? "bg-accent-muted/30 hover:bg-accent-muted/60" : "hover:bg-muted/60"}`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-md border ${failed ? "border-destructive/20 bg-danger-muted" : running ? "border-success/20 bg-success-muted" : "border-accent/15 bg-accent-muted/40"}`}
      >
        <Icon
          className={`size-4 ${failed ? "text-destructive" : running ? "text-success" : "text-accent"}`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{call.tool}</span>
        <span
          className={`mt-0.5 block truncate text-[11px] ${failed ? "text-destructive" : "text-muted-foreground"}`}
        >
          {summary}
        </span>
      </span>

      <span className="flex min-w-10 shrink-0 flex-col items-end gap-1 text-[10px] tabular-nums text-muted-foreground">
        <StatusIcon
          className={`size-3 shrink-0 ${running ? "animate-spin text-accent" : failed ? "text-destructive" : "text-success"}`}
        />
        {running ? "now" : time}
      </span>
    </button>
  )
}
