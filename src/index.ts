import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { ShellyAuthStore } from "./auth/auth.js"
import { MCP_CONFIG } from "./config.js"
import { ChatGptSubagentModule } from "./tools/subagent/chatgpt-subagent.js"
import { McpAuditLogger } from "./server/audit-log.js"
import { PersistentShellSession, type ShellSessionOptions } from "./tools/shell/session.js"
import { ShellSessionManager } from "./tools/shell/session-manager.js"
import { startMcpHttpServer } from "./server/http-server.js"
import { PeekabooClient } from "./tools/computer/peekaboo.js"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const auditLogPath = resolve(repositoryRoot, "agent-commands.yaml")
const auditLogger = new McpAuditLogger(auditLogPath)
const authStore = new ShellyAuthStore()
await authStore.ensureState()
const cwd = MCP_CONFIG.workspace
await mkdir(cwd, { recursive: true })
const peekaboo = new PeekabooClient({
  executable: MCP_CONFIG.peekaboo.executable,
})
const chatGptSubagents = new ChatGptSubagentModule({
  cdpEndpoint: MCP_CONFIG.chatGpt.cdpEndpoint,
  onPageCreated: () => {
    const child = spawn(process.execPath, [resolve(repositoryRoot, "scripts", "chatgpt-browser.mjs"), "--hide"], {
      stdio: "ignore",
    })
    child.on("error", () => undefined)
    child.unref()
  },
})

const shellOptions: ShellSessionOptions = {
  shellPath: MCP_CONFIG.shell.path,
  cwd,
  transcriptLimit: MCP_CONFIG.shell.transcriptChars,
  commandTranscriptBytes: MCP_CONFIG.shell.commandTranscriptBytes,
  defaultOutputBytes: MCP_CONFIG.shell.outputBytes,
  maxOutputBytes: MCP_CONFIG.shell.maxOutputBytes,
  recordLimit: MCP_CONFIG.shell.recordLimit,
}
const shells = new ShellSessionManager({
  createShell: () => new PersistentShellSession(shellOptions),
  maxShells: MCP_CONFIG.shell.maxShells,
  idleTimeoutMs: MCP_CONFIG.shell.idleTimeoutMs,
})

const running = await startMcpHttpServer({
  host: MCP_CONFIG.host,
  port: MCP_CONFIG.port,
  shellManager: shells,
  peekaboo,
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
console.log(`Computer Use: Peekaboo CLI (${running.peekaboo.executable})`)
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
