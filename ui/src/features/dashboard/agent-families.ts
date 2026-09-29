import type { Agent } from "../../types.js"

export interface AgentFamily {
  rootId: string
  agents: Agent[]
}

/** Group visible agents under their highest known ancestor, parent first. Hidden agents supply ancestry only. */
export function groupAgentFamilies(agents: Agent[], dismissed: Agent[]): AgentFamily[] {
  const known = new Map([...agents, ...dismissed].map((agent) => [agent.id, agent]))
  const families = new Map<string, AgentFamily>()
  for (const agent of agents) {
    let root = agent
    let rootId = agent.id
    const visited = new Set([rootId])
    while (root.parentId && !visited.has(root.parentId)) {
      rootId = root.parentId
      visited.add(rootId)
      const parent = known.get(rootId)
      if (!parent) break
      root = parent
    }
    const family: AgentFamily = families.get(rootId) ?? { rootId, agents: [] }
    if (agent.id === rootId) family.agents.unshift(agent)
    else family.agents.push(agent)
    families.set(rootId, family)
  }
  return [...families.values()]
}
