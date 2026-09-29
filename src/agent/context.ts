import { AsyncLocalStorage } from "node:async_hooks"

interface StoredAgentIdentity {
  sessionId: string
  agent: string
  taskSlug?: string
  /** Canonical parent identity, once linked through an observed delegated conversation. */
  parent?: AgentIdentity
}

export type AgentIdentity = Readonly<StoredAgentIdentity>

const agents = new Map<string, StoredAgentIdentity>()
const currentAgent = new AsyncLocalStorage<StoredAgentIdentity>()

export function runWithAgent<T>(sessionId: string | undefined, callback: () => T): T {
  return sessionId ? currentAgent.run(agentForSession(sessionId), callback) : callback()
}

export function getAgentIdentity(): AgentIdentity | undefined {
  return currentAgent.getStore()
}

export function setAgentTaskSlug(taskSlug: string): void {
  const identity = currentAgent.getStore()
  if (identity) identity.taskSlug = taskSlug
}

/** Bind existing session identities. Repeated evidence is harmless; conflicting or cyclic links fail closed. */
export function bindAgentParent(
  childSessionId: string,
  parentSessionId: string
): AgentIdentity | undefined {
  if (!childSessionId || !parentSessionId || childSessionId === parentSessionId) return undefined
  const child = agentForSession(childSessionId)
  const parent = agentForSession(parentSessionId)
  if (child.parent) return child.parent === parent ? child : undefined
  for (let ancestor: AgentIdentity | undefined = parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor === child) return undefined
  }
  child.parent = parent
  return child
}

/** Direct children share the same canonical parent reference; no second relationship index. */
export function getAgentChildren(parent: AgentIdentity): readonly AgentIdentity[] {
  return [...agents.values()].filter((identity) => identity.parent === parent)
}

function agentForSession(sessionId: string): StoredAgentIdentity {
  const known = agents.get(sessionId)
  if (known) return known

  const identity = { sessionId, agent: `agent-${agents.size + 1}` }
  agents.set(sessionId, identity)
  return identity
}
