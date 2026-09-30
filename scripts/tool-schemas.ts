import process from "node:process"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { renderToolsList } from "json-schema-to-openai-typescript"
import { MCP_CONFIG } from "../src/config.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { countTokens, OUTPUT_TOKEN_ENCODING } from "../src/tokenizer.js"
import { PeekabooClient } from "../src/tools/computer/peekaboo.js"
import { createSubagents } from "../src/tools/delegation/subagents.js"
import { createShellSession } from "../src/tools/shell/session.js"
import { createShellSessionManager } from "../src/tools/shell/session-manager.js"
import { WebPageOpener } from "../src/tools/web/web-open.js"

const args = process.argv.slice(2)
const json = args.includes("--json")
const requestedNames = new Set(args.filter((arg) => arg !== "--json"))
const shells = MCP_CONFIG.tools.shell
  ? createShellSessionManager({
      createShell: () => createShellSession({ cwd: MCP_CONFIG.workspace }),
    })
  : undefined
const peekaboo = MCP_CONFIG.tools.computer ? new PeekabooClient({ localOnly: true }) : undefined
const subagents = MCP_CONFIG.tools.subagents ? createSubagents() : undefined
const webPageOpener = MCP_CONFIG.tools.web ? new WebPageOpener() : undefined
const running = await startMcpHttpServer(
  {
    createMcpServer: createMcpServerFactory({
      shellManager: shells,
      peekaboo,
      subagents,
      webPageOpener,
    }),
  },
  { port: 0 }
)
const client = new Client(
  { name: "shellby-mcp-schema-viewer", version: MCP_CONFIG.server.version },
  { versionNegotiation: { mode: "auto" } }
)
const transport = new StreamableHTTPClientTransport(new URL(running.url))

try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const selected =
    requestedNames.size === 0 ? tools : tools.filter((tool) => requestedNames.has(tool.name))

  if (requestedNames.size > 0) {
    const foundNames = new Set(selected.map((tool) => tool.name))
    const missing = [...requestedNames].filter((name) => !foundNames.has(name))
    if (missing.length > 0) {
      throw new Error(`Unknown tool${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`)
    }
  }

  const output = json
    ? JSON.stringify(selected, null, 2)
    : renderToolsList({ tools: selected }, "mcp__shellby__")
  const tokenText = json ? JSON.stringify(selected) : output
  process.stdout.write(
    `Token count (${OUTPUT_TOKEN_ENCODING}): ${countTokens(tokenText)}\n\n${output}\n`
  )
} finally {
  await client.close().catch(() => undefined)
  await running.close()
  await Promise.allSettled([
    shells?.close() ?? Promise.resolve(),
    peekaboo?.close() ?? Promise.resolve(),
    subagents?.dispose() ?? Promise.resolve(),
  ])
}
