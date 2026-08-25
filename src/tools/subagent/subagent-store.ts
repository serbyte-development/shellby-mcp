import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export interface PersistedSubagent {
  conversationUrl: string
  turnCount: number
}

export interface SubagentStore {
  get(agentId: string): PersistedSubagent | undefined
  set(agentId: string, value: PersistedSubagent): void
  clear(): void
  close(): void
}

export function subagentDatabasePath(): string {
  return join(homedir(), ".shellby", "subagents.sqlite")
}

export function createSubagentStore(path = subagentDatabasePath()): SubagentStore | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        conversation_url TEXT NOT NULL,
        turn_count INTEGER NOT NULL
      )
    `)
    const get = db.prepare("SELECT conversation_url, turn_count FROM agents WHERE agent_id = ?")
    const set = db.prepare(`
      INSERT INTO agents (agent_id, conversation_url, turn_count)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        conversation_url = excluded.conversation_url,
        turn_count = excluded.turn_count
    `)

    return {
      get(agentId) {
        try {
          const row = get.get(agentId) as { conversation_url?: unknown; turn_count?: unknown } | undefined
          if (!row || typeof row.conversation_url !== "string" || typeof row.turn_count !== "number") return undefined
          return { conversationUrl: row.conversation_url, turnCount: row.turn_count }
        } catch {
          return undefined
        }
      },
      set(agentId, value) {
        try {
          set.run(agentId, value.conversationUrl, value.turnCount)
        } catch {
          // Persistence is best effort. Runtime behavior should continue normally.
        }
      },
      clear() {
        try {
          db.exec("DELETE FROM agents")
        } catch {
          // Best effort.
        }
      },
      close() {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      },
    }
  } catch {
    return undefined
  }
}
