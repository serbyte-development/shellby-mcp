import { Check, Circle, GitBranch, LoaderCircle, TriangleAlert, X } from "lucide-react"
import { useRef, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import type { Agent, AgentCall } from "../../types"
import { AgentRoom } from "../agent-room/AgentRoom"
import type { AgentFamily } from "./agent-families"
import { SteerComposer } from "./SteerComposer"
import { ToolCallModal } from "./ToolCallModal"

export function AgentCard({
  family,
  now,
  onDismiss,
  onDismissInstruction,
}: {
  family: AgentFamily
  now: number
  onDismiss: (agent: Agent) => void
  onDismissInstruction: (agent: Agent, instructionId: string) => void
}) {
  const [selectedId, setSelectedId] = useState(family.rootId)
  const headingRef = useRef<HTMLHeadingElement>(null)
  function selectAgent(id: string) {
    setSelectedId(id)
    headingRef.current?.focus()
  }
  const agent =
    family.agents.find((item) => item.id === selectedId) ??
    family.agents.find((item) => item.id === family.rootId) ??
    family.agents[0]
  if (!agent) return null
  // A dismissed selection must not take over again when it returns with new activity.
  if (selectedId !== agent.id) setSelectedId(agent.id)
  const active = now - agent.lastSeenAt < 30_000
  const minimized = family.agents.filter((item) => item.id !== agent.id)
  const parent = family.agents.find((item) => item.id === agent.parentId)

  return (
    <Card className="min-w-0 overflow-hidden" role="region" aria-label={agent.id}>
      <CardHeader className="border-b bg-card/70">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot active={active} />
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="scroll-mt-28 text-base font-semibold tracking-tight outline-none"
              >
                {agent.id}
              </h2>
              {agent.parentId ? (
                <Badge>SUBAGENT</Badge>
              ) : minimized.length > 0 ? (
                <Badge className="bg-family-parent/10 text-family-parent">PARENT</Badge>
              ) : null}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {agent.taskSlug ?? "No task name yet"}
            </p>
            {agent.parentId ? (
              <button
                type="button"
                className="mt-1 flex items-center gap-1 text-xs text-muted-foreground enabled:hover:text-family-parent enabled:hover:underline"
                disabled={!parent}
                onClick={() => parent && selectAgent(parent.id)}
                aria-label={`Show parent ${agent.parentId}`}
              >
                <GitBranch className="size-3" /> Parent: {agent.parentId}
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge
              className={active ? "border-success/25 bg-success-muted text-success" : undefined}
            >
              {active ? "ACTIVE" : "INACTIVE"}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={`Dismiss ${agent.id}`}
              title="Dismiss agent until new activity"
              onClick={() => onDismiss(agent)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <AgentWorkspace
          key={`${agent.id}:${agent.firstSeenAt}`}
          agent={agent}
          onDismissInstruction={(instructionId) => onDismissInstruction(agent, instructionId)}
        />
        {minimized.length > 0 ? (
          <fieldset className="min-w-0 border-t pt-4" aria-label={`Agent family ${family.rootId}`}>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Agent family · {family.agents.length}
            </h3>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {minimized.map((member) => {
                const isParent = member.id === family.rootId
                return (
                  <button
                    key={member.id}
                    type="button"
                    aria-label={`Show ${member.id}${isParent ? ", parent" : ""}`}
                    title={`${member.id} · ${member.taskSlug ?? "No task name yet"}`}
                    onClick={() => selectAgent(member.id)}
                    className={`min-w-0 overflow-hidden rounded-lg border text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-family-parent ${isParent ? "border-family-parent bg-family-parent/5 ring-1 ring-family-parent/40" : "bg-background/50 hover:border-muted-foreground"}`}
                  >
                    <AgentRoom agent={member} preview />
                    <div className="space-y-1 border-t px-2 py-2">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <StatusDot active={now - member.lastSeenAt < 30_000} />
                        <span className="text-xs font-medium">{member.id}</span>
                        {isParent ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-family-parent">
                            <GitBranch className="size-3" /> PARENT
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {member.taskSlug ?? "No task name yet"}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          </fieldset>
        ) : null}
      </CardContent>
    </Card>
  )
}

// Remount the workspace on selection so a draft, open modal, or animation cannot target the wrong agent.
function AgentWorkspace({
  agent,
  onDismissInstruction,
}: {
  agent: Agent
  onDismissInstruction: (instructionId: string) => void
}) {
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const recent = [agent.current, ...agent.recent].filter((call): call is AgentCall => Boolean(call))
  const selectedCall = recent.find((call) => call.id === selectedCallId)
  return (
    <div className="@container space-y-4">
      <AgentRoom agent={agent} />
      <div className="grid gap-4 @xl:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent
          </h3>
          <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
            {recent.map((call) => (
              <ActivityRow key={call.id} call={call} onClick={() => setSelectedCallId(call.id)} />
            ))}
          </div>
        </div>
        <SteerComposer agent={agent} onDismissInstruction={onDismissInstruction} />
      </div>
      <ToolCallModal call={selectedCall} onClose={() => setSelectedCallId(undefined)} />
    </div>
  )
}

function ActivityRow({ call, onClick }: { call: AgentCall; onClick: () => void }) {
  const running = call.status === "running"
  const failed = call.status === "failed"
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${failed ? "bg-danger-muted text-destructive hover:bg-destructive/15" : running ? "bg-success-muted/60 hover:bg-success-muted" : "hover:bg-muted/60"}`}
    >
      {failed ? (
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
      ) : running ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-success" />
      ) : (
        <Check className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="w-24 shrink-0 truncate font-medium">{call.tool}</span>
      <span
        className={`min-w-0 flex-1 truncate font-mono ${failed ? "text-destructive" : "text-muted-foreground"}`}
      >
        {call.summary || (running ? "Working..." : "Completed")}
      </span>
      <span
        className={
          failed
            ? "shrink-0 text-destructive"
            : running
              ? "shrink-0 text-success"
              : "shrink-0 text-muted-foreground"
        }
      >
        {running ? "now" : formatClock(call.finishedAt ?? call.startedAt)}
      </span>
    </button>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return active ? (
    <span className="size-2.5 shrink-0 rounded-full bg-success shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" />
  ) : (
    <Circle className="size-2.5 shrink-0 fill-current text-muted-foreground/50" />
  )
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}
