import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { ShellyAuthStore } from "./auth/auth.js"
import { MCP_CONFIG } from "./config.js"
import { ChatGptSubagentModule } from "./tools/subagent/chatgpt-subagent.js"
import { McpAuditLogger } from "./server/audit-log.js"
import { PersistentShellSession } from "./tools/shell/session.js"
import { ShellSessionManager } from "./tools/shell/session-manager.js"
import { startMcpHttpServer } from "./server/http-server.js"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const auditLogPath = resolve(repositoryRoot, "agent-commands.yaml")
const auditLogger = new McpAuditLogger(auditLogPath)
const authStore = new ShellyAuthStore()
await authStore.ensureState()
const cwd = MCP_CONFIG.workspace
await mkdir(cwd, { recursive: true })
const chatGptSubagents = new ChatGptSubagentModule({
  onPageCreated: () => {
    const child = spawn(process.execPath, [resolve(repositoryRoot, "scripts", "chatgpt-browser.mjs"), "--hide"], {
      stdio: "ignore",
    })
    child.on("error", () => undefined)
    child.unref()
  },
})

const shells = new ShellSessionManager({
  createShell: () => new PersistentShellSession({ cwd }),
})

const running = await startMcpHttpServer({
  shellManager: shells,
  chatGptSubagents,
  auditLogger,
  authStore,
})
console.log(`Local shell MCP server: ${running.url}`)
console.log("Remote MCP authentication: trusted ChatGPT origin + bound OpenAI subject")
console.log(`Shell: ${MCP_CONFIG.shell.path}`)
console.log(`Default workspace: ${cwd}`)
console.log(`Maximum named shells: ${shells.maximumShells}`)
console.log(`Agent MCP audit log: ${auditLogPath}`)
console.log(`Computer Use: Peekaboo CLI (${MCP_CONFIG.peekaboo.executable})`)
console.log(`ChatGPT Subagents: attach-only CDP ${MCP_CONFIG.chatGpt.cdpEndpoint}`)

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; shutting down.`)
  await running.close()
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error) => {
        console.error("Shutdown failed:", error)
        process.exit(1)
      }
    )
  })
}
