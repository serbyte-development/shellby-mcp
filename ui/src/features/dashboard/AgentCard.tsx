import { IconGitBranch, IconX } from "@react-zero-ui/icon-sprite"
import { useRef, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import type { Agent } from "../../types"
import { AgentRoom } from "../agent-room/AgentRoom"
import { AgentFamilyStrip } from "./AgentFamilyStrip"
import { AgentStatusDot } from "./AgentStatusDot"
import { AgentTokenUsage } from "./AgentTokenUsage"
import type { AgentFamily } from "./agent-families"
import { SteerComposer } from "./SteerComposer"
import { ToolCallList } from "./ToolCallList"

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
    headingRef.current?.focus({ preventScroll: true })
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
    <Card
      className={`@container min-w-0 overflow-hidden ${active ? "border-accent/30" : ""}`}
      role="region"
      aria-label={agent.id}
    >
      <CardHeader className="pb-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-3">
          <div className="min-w-0">
            <div className="flex h-5 items-center gap-1 @md:gap-2">
              <AgentStatusDot active={active} />
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="min-w-0 truncate text-base font-semibold capitalize tracking-tight outline-none @md:text-lg"
              >
                {agent.id}
              </h2>
              {agent.parentId ? (
                <Badge>SUBAGENT</Badge>
              ) : minimized.length > 0 ? (
                <Badge className="bg-family-parent/10 text-family-parent">PARENT</Badge>
              ) : null}
            </div>
            <p className="mt-1.5 max-w-2xs truncate text-xs leading-5 text-muted-foreground">
              {agent.taskSlug
                ?.split("-")
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(" ") ?? "No task name yet"}
            </p>
          </div>
          <div className="w-20 space-y-1">
            <AgentTokenUsage usage={agent.toolUsage} />
            <div className="h-4">
              {agent.parentId ? (
                <button
                  type="button"
                  className="flex max-w-full items-center gap-1 text-xs text-muted-foreground enabled:hover:text-family-parent enabled:hover:underline"
                  disabled={!parent}
                  onClick={() => parent && selectAgent(parent.id)}
                  aria-label={`Show parent ${agent.parentId}`}
                  title={`Parent: ${agent.parentId}`}
                >
                  <IconGitBranch className="size-3 shrink-0" />
                  <span className="truncate">{agent.parentId}</span>
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-1.5">
            <Badge
              className={`hidden @md:inline-flex ${active ? "border-success/25 bg-success-muted text-success" : ""}`}
            >
              {active ? "ACTIVE" : "INACTIVE"}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 rounded-md border bg-surface text-muted-foreground"
              aria-label={`Dismiss ${agent.id}`}
              title="Dismiss agent until new activity"
              onClick={() => onDismiss(agent)}
            >
              <IconX className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <AgentWorkspace
          key={`${agent.id}:${agent.firstSeenAt}`}
          agent={agent}
          onDismissInstruction={(instructionId) => onDismissInstruction(agent, instructionId)}
        />
        <AgentFamilyStrip
          rootId={family.rootId}
          agents={minimized}
          now={now}
          onSelect={selectAgent}
        />
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
  return (
    <div className="@container space-y-3">
      <AgentRoom agent={agent} />
      <div className="grid gap-3 @md:grid-cols-2">
        <ToolCallList agent={agent} />
        <SteerComposer agent={agent} onDismissInstruction={onDismissInstruction} />
      </div>
    </div>
  )
}
