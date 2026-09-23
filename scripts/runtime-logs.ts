import { spawnSync } from "node:child_process"
import process from "node:process"
import { MCP_CONFIG } from "../src/config.js"
import { runtimeLogPath } from "../src/logging.js"

const path = runtimeLogPath(MCP_CONFIG.stateDir)
console.log(`Runtime log: ${path}`)
const result = spawnSync("tail", ["-n", "100", "-F", path], { stdio: "inherit" })
if (result.error) throw result.error
process.exitCode = result.status ?? 0
