import { useEffect, useState } from "react"

import { useAgents } from "../../hooks/useAgents"
import type { Agent } from "../../types"

interface AgentDismissals {
  // Agent IDs can be reused after a server restart; preferences belong to one incarnation.
  firstSeenAt: number
  // Server activity timestamp when dismissed, never the browser's wall clock.
  hiddenThrough?: number
  instructionIds: string[]
}

const STORAGE_KEY = "shellby-dashboard-dismissals-v1"

/**
 * Dashboard presentation of the observer's agents. Dismissals stay in this browser;
 * they never cancel work or delete server history. New activity reveals hidden cards,
 * while delivered notices stay dismissed across card remounts and page refreshes.
 * Returned agents omit hidden cards and dismissed delivery notices; queued items stay intact.
 */
export function useDashboardAgents() {
  const observed = useAgents()
  const [dismissals, setDismissals] = useState(readDismissals)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissals))
    } catch {
      // A browser that blocks storage can still dismiss items for this page's lifetime.
    }
  }, [dismissals])

  function updateDismissals(agent: Agent, update: (current: AgentDismissals) => AgentDismissals) {
    setDismissals((current) => {
      const saved = current[agent.id]
      const entry =
        saved?.firstSeenAt === agent.firstSeenAt
          ? saved
          : { firstSeenAt: agent.firstSeenAt, instructionIds: [] }
      return { ...current, [agent.id]: update(entry) }
    })
  }

  const agents: Agent[] = []
  const dismissedAgents: Agent[] = []
  for (const agent of observed.agents) {
    const saved = dismissals[agent.id]
    const entry = saved?.firstSeenAt === agent.firstSeenAt ? saved : undefined
    if (entry?.hiddenThrough !== undefined && agent.lastSeenAt <= entry.hiddenThrough) {
      dismissedAgents.push(agent)
    } else {
      agents.push(
        entry
          ? {
              ...agent,
              instructions: agent.instructions.filter(
                (instruction) =>
                  instruction.deliveredAt === undefined ||
                  !entry.instructionIds.includes(instruction.id)
              ),
            }
          : agent
      )
    }
  }

  return {
    ...observed,
    agents,
    dismissedAgents,
    dismissAgent: (agent: Agent) =>
      updateDismissals(agent, (current) => ({ ...current, hiddenThrough: agent.lastSeenAt })),
    restoreAgent: (agent: Agent) =>
      updateDismissals(agent, (current) => ({ ...current, hiddenThrough: undefined })),
    dismissInstruction: (agent: Agent, instructionId: string) =>
      updateDismissals(agent, (current) => ({
        ...current,
        instructionIds: [...new Set([...current.instructionIds, instructionId])],
      })),
  }
}

function readDismissals(): Record<string, AgentDismissals> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const valid: Record<string, AgentDismissals> = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object" &&
        Number.isFinite(value.firstSeenAt) &&
        (value.hiddenThrough === undefined || Number.isFinite(value.hiddenThrough)) &&
        Array.isArray(value.instructionIds) &&
        value.instructionIds.every((instructionId: unknown) => typeof instructionId === "string")
      ) {
        valid[id] = value
      }
    }
    return valid
  } catch {
    return {}
  }
}
