import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { ShellyAuthStore } from "./auth/auth.js"
import { MCP_CONFIG, resolveWorkspacePath } from "./config.js"
import { ChatGptSubagentModule, DEFAULT_CHATGPT_CDP_ENDPOINT } from "./tools/subagent/chatgpt-subagent.js"
import { McpAuditLogger } from "./server/audit-log.js"
import { PersistentShellSession, type ShellSessionOptions } from "./tools/shell/session.js"
import { ShellSessionManager } from "./tools/shell/session-manager.js"
import { startMcpHttpServer } from "./server/http-server.js"
import { PeekabooClient } from "./tools/computer/peekaboo.js"

const host = process.env.HOST ?? MCP_CONFIG.defaults.host
const port = parsePositiveInteger(process.env.PORT, MCP_CONFIG.defaults.port)
const defaultOutputBytes = parsePositiveInteger(process.env.MCP_OUTPUT_BYTES, 2 * 1024)
const maxOutputBytes = parsePositiveInteger(process.env.MCP_MAX_OUTPUT_BYTES, 32 * 1024)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const auditLogPath = resolve(repositoryRoot, "agent-commands.yaml")
const auditLogger = new McpAuditLogger(auditLogPath)
const authStore = new ShellyAuthStore()
await authStore.ensureState()
const cwd = resolveWorkspacePath(process.env.MCP_CWD ?? MCP_CONFIG.defaults.workspace)
await mkdir(cwd, { recursive: true })
const peekaboo = new PeekabooClient({
  executable: process.env.MCP_PEEKABOO_BIN ?? "peekaboo",
})
const chatGptCdpEndpoint = process.env.MCP_CHATGPT_CDP_ENDPOINT ?? DEFAULT_CHATGPT_CDP_ENDPOINT
const chatGptSubagents = new ChatGptSubagentModule({
  cdpEndpoint: chatGptCdpEndpoint,
  onPageCreated: () => {
    const child = spawn(process.execPath, [resolve(repositoryRoot, "scripts", "chatgpt-browser.mjs"), "--hide"], {
      stdio: "ignore",
    })
    child.on("error", () => undefined)
    child.unref()
  },
})

const shellOptions: ShellSessionOptions = {
  shellPath: process.env.MCP_SHELL ?? "/bin/zsh",
  cwd,
  transcriptLimit: parsePositiveInteger(process.env.MCP_TRANSCRIPT_CHARS, 1024 * 1024),
  commandTranscriptBytes: parsePositiveInteger(process.env.MCP_COMMAND_TRANSCRIPT_BYTES, 256 * 1024),
  defaultOutputBytes,
  maxOutputBytes,
  recordLimit: parsePositiveInteger(process.env.MCP_RECORD_LIMIT, 1024),
}
const shells = new ShellSessionManager({
  createShell: () => new PersistentShellSession(shellOptions),
  maxShells: parsePositiveInteger(process.env.MCP_MAX_SHELLS, 8),
  idleTimeoutMs: parseNonNegativeInteger(process.env.MCP_SHELL_IDLE_TTL_MS, 30 * 60 * 1000),
})

const running = await startMcpHttpServer({
  host,
  port,
  shellManager: shells,
  peekaboo,
  chatGptSubagents,
  auditLogger,
  authStore,
})
console.log(`Local shell MCP server: ${running.url}`)
console.log("Remote MCP authentication: trusted ChatGPT origin + bound OpenAI subject")
console.log(`Shell: ${process.env.MCP_SHELL ?? "/bin/zsh"}`)
console.log(`Default workspace: ${cwd}`)
console.log(`Maximum named shells: ${shells.maximumShells}`)
console.log(`Agent MCP audit log: ${auditLogPath}`)
console.log(`Computer Use: Peekaboo CLI (${running.peekaboo.executable})`)
console.log(`ChatGPT Subagents: attach-only CDP ${chatGptCdpEndpoint}`)

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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}.`)
  }
  return parsed
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, received ${JSON.stringify(value)}.`)
  }
  return parsed
}
