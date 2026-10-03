import { rmSync } from "node:fs"
import { join } from "node:path"

import { MCP_CONFIG } from "../../src/config.js"

const stateDatabasePath: string = join(MCP_CONFIG.stateDir, "subagents.sqlite")
for (const suffix of ["", "-shm", "-wal", "-journal"]) {
  rmSync(`${stateDatabasePath}${suffix}`, { force: true })
}
console.log(`Reset subagent state: ${stateDatabasePath}`)
