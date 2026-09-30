import { IconGitBranch, IconX } from "@react-zero-ui/icon-sprite"
import { useRef, useState } from "react"

import { Badge } from "../../components/ui/badge"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import type { Agent } from "../../types"
import { AgentRoom } from "../agent-room/AgentRoom"
import { AgentFamilyStrip } from "./AgentFamilyStrip"
import { AgentStatusDot } from "./AgentStatusDot"
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
    <Card className="min-w-0 overflow-hidden" role="region" aria-label={agent.id}>
      <CardHeader className="border-b bg-card/70">
        <div className="gap-3 grid grid-cols-12 items-start">
          <div className="min-w-0 col-span-7">
            <div className="flex h-4 items-center gap-2 ">
              <AgentStatusDot active={active} />
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="min-w-0 capitalize truncate text-base font-semibold tracking-tight outline-none"
              >
                {agent.id}
              </h2>
              {agent.parentId ? (
                <Badge>SUBAGENT</Badge>
              ) : minimized.length > 0 ? (
                <Badge className="bg-family-parent/10 text-family-parent">PARENT</Badge>
              ) : null}
            </div>
            <p className="mt-2 truncate text-sm text-muted-foreground max-w-2xs">
              {agent.taskSlug
                ?.split("-")
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(" ") ?? "No task name yet"}
            </p>
          </div>
          <div className="mt-1 h-4 col-span-3">
            {agent.parentId ? (
              <button
                type="button"
                className="flex max-w-full items-center gap-1 text-xs text-muted-foreground enabled:hover:text-family-parent enabled:hover:underline"
                disabled={!parent}
                onClick={() => parent && selectAgent(parent.id)}
                aria-label={`Show parent ${agent.parentId}`}
              >
                <IconGitBranch className="size-3 shrink-0" />
                <span className="truncate">Parent: {agent.parentId}</span>
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 col-span-2 justify-end">
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
              <IconX className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-2 pt-2">
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
    <div className="@container space-y-4">
      <AgentRoom agent={agent} />
      <div className="grid gap-4 @xl:grid-cols-2">
        <ToolCallList agent={agent} />
        <SteerComposer agent={agent} onDismissInstruction={onDismissInstruction} />
      </div>
    </div>
  )
}
