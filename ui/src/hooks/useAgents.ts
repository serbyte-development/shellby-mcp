import { useEffect, useState } from "react"

import { fetchAgents, subscribeToAgents } from "../lib/api"
import type { Agent } from "../types"

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let disposed = false
    let pendingUpdates: Map<string, Agent> | undefined
    function refresh() {
      // Events received during a snapshot request win over that snapshot. A newer request
      // supersedes an older one, including React Strict Mode's discarded subscription.
      const updates = new Map<string, Agent>()
      pendingUpdates = updates
      void fetchAgents()
        .then((snapshot) => {
          if (disposed || pendingUpdates !== updates) return
          const agentsById = new Map(snapshot.map((agent) => [agent.id, agent]))
          for (const [id, agent] of updates) agentsById.set(id, agent)
          setAgents([...agentsById.values()])
          setError(undefined)
        })
        .catch((loadError) => {
          if (disposed || pendingUpdates !== updates) return
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        })
        .finally(() => {
          if (disposed || pendingUpdates !== updates) return
          pendingUpdates = undefined
          setLoading(false)
        })
    }

    const unsubscribe = subscribeToAgents(
      ({ agent }) => {
        pendingUpdates?.set(agent.id, agent)
        setAgents((current) => {
          const index = current.findIndex((item) => item.id === agent.id)
          if (index === -1) return [...current, agent]
          const next = [...current]
          next[index] = agent
          return next
        })
      },
      (isConnected) => {
        setConnected(isConnected)
        // SSE has no replay; reconnect must recover calls completed while disconnected.
        if (isConnected) refresh()
      }
    )
    refresh()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return { agents, connected, loading, error }
}
