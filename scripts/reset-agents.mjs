import { rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const path = join(homedir(), ".shellby", "subagents.sqlite")
rmSync(path, { force: true })
rmSync(`${path}-shm`, { force: true })
rmSync(`${path}-wal`, { force: true })
console.log(`Reset subagent state: ${path}`)
