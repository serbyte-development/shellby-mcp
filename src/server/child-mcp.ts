import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client"
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio"
import { type McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server"

export interface ChildMcpCallOptions {
  signal?: AbortSignal
  _meta?: Record<string, unknown>
}

export interface ChildMcpToolProvider {
  readonly name: string
  readonly tools: readonly Tool[]
  start(): Promise<void>
  callTool(name: string, args: Record<string, unknown>, options?: ChildMcpCallOptions): Promise<CallToolResult>
  close(): Promise<void>
}

export interface ChildMcpClientOptions extends StdioServerParameters {
  name: string
  tools?: readonly string[]
  connectTimeoutMs?: number
  transformTool?: (tool: Tool) => Tool
  transformResult?: (toolName: string, result: CallToolResult) => CallToolResult | Promise<CallToolResult>
}

interface ChildConnection {
  client: Client
  upstreamToolsByPublicName: ReadonlyMap<string, Tool>
}

export class ChildMcpClient implements ChildMcpToolProvider {
  readonly name: string

  private readonly server: StdioServerParameters
  private readonly includedTools?: readonly string[]
  private readonly connectTimeoutMs: number
  private readonly transformTool?: (tool: Tool) => Tool
  private readonly transformResult?: (toolName: string, result: CallToolResult) => CallToolResult | Promise<CallToolResult>
  private connection?: ChildConnection
  private connecting?: Promise<ChildConnection>
  private publishedTools?: readonly Tool[]
  private toolSignature?: string
  private closed = false

  constructor(options: ChildMcpClientOptions) {
    const { name, tools, connectTimeoutMs = 10_000, transformTool, transformResult, ...server } = options
    this.name = name
    this.server = server
    this.includedTools = tools
    this.connectTimeoutMs = connectTimeoutMs
    this.transformTool = transformTool
    this.transformResult = transformResult
  }

  get tools(): readonly Tool[] {
    if (!this.publishedTools) throw new Error(`Child MCP ${this.name} has not started.`)
    return this.publishedTools
  }

  async start(): Promise<void> {
    await this.ensureConnection()
  }

  async callTool(name: string, args: Record<string, unknown>, options: ChildMcpCallOptions = {}): Promise<CallToolResult> {
    const connection = await this.ensureConnection()
    const upstreamTool = connection.upstreamToolsByPublicName.get(name)
    if (!upstreamTool) throw new Error(`Child MCP ${this.name} does not expose tool ${name}.`)

    const result = await connection.client.callTool(
      {
        name: upstreamTool.name,
        arguments: args,
        ...(options._meta ? { _meta: options._meta } : {}),
      },
      {
        signal: options.signal,
        toolDefinition: upstreamTool,
      }
    )
    return this.transformResult ? this.transformResult(name, result) : result
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const connection = this.connection ?? (await this.connecting?.catch(() => undefined))
    this.connection = undefined
    await connection?.client.close()
  }

  private ensureConnection(): Promise<ChildConnection> {
    if (this.closed) return Promise.reject(new Error(`Child MCP ${this.name} is closed.`))
    if (this.connection) return Promise.resolve(this.connection)
    if (this.connecting) return this.connecting

    const connecting = this.connect()
    this.connecting = connecting
    const clearConnecting = () => {
      if (this.connecting === connecting) this.connecting = undefined
    }
    void connecting.then(clearConnecting, clearConnecting)
    return connecting
  }

  private async connect(): Promise<ChildConnection> {
    const client = new Client({ name: `shellby-${this.name}`, version: "1.0.0" })
    const transport = new StdioClientTransport(this.server)
    let connection: ChildConnection | undefined
    client.onclose = () => {
      if (this.connection === connection) this.connection = undefined
    }

    try {
      await client.connect(transport, { timeout: this.connectTimeoutMs })
      const listed = await client.listTools()
      const bindings = selectTools(this.name, listed.tools, this.includedTools).map((upstreamTool) => ({
        upstreamTool,
        publicTool: this.transformTool?.(upstreamTool) ?? upstreamTool,
      }))
      const publicTools = bindings.map((binding) => binding.publicTool)
      const upstreamToolsByPublicName = new Map<string, Tool>()
      for (const binding of bindings) {
        if (upstreamToolsByPublicName.has(binding.publicTool.name)) {
          throw new Error(`Child MCP ${this.name} publishes duplicate tool name ${binding.publicTool.name}.`)
        }
        upstreamToolsByPublicName.set(binding.publicTool.name, binding.upstreamTool)
      }

      const signature = JSON.stringify(publicTools)
      if (this.toolSignature !== undefined && this.toolSignature !== signature) {
        throw new Error(`Child MCP ${this.name} changed its tool definitions. Restart Shellby before using it again.`)
      }
      if (this.closed) throw new Error(`Child MCP ${this.name} is closed.`)

      this.publishedTools ??= publicTools
      this.toolSignature ??= signature
      connection = { client, upstreamToolsByPublicName }
      this.connection = connection
      return connection
    } catch (error) {
      await client.close().catch(() => undefined)
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not connect child MCP ${this.name}: ${detail}`, { cause: error })
    }
  }
}

export function registerChildMcpTools(server: McpServer, providers: readonly ChildMcpToolProvider[], toolMeta?: Record<string, unknown>): void {
  for (const provider of providers) {
    for (const tool of provider.tools) {
      server.registerTool(
        tool.name,
        {
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: passThroughSchema(tool.inputSchema),
          ...(tool.outputSchema ? { outputSchema: passThroughSchema(tool.outputSchema) } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool.icons ? { icons: tool.icons } : {}),
          ...mergeMeta(tool._meta, toolMeta),
        },
        async (args, ctx) =>
          provider.callTool(tool.name, args, {
            signal: ctx.mcpReq.signal,
            ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
          })
      )
    }
  }
}

function selectTools(name: string, listedTools: readonly Tool[], includedTools: readonly string[] | undefined): Tool[] {
  const listedByName = new Map(listedTools.map((tool) => [tool.name, tool]))
  const names = includedTools ?? listedTools.map((tool) => tool.name)
  const missing = names.filter((toolName) => !listedByName.has(toolName))
  if (missing.length > 0) throw new Error(`Child MCP ${name} is missing configured tools: ${missing.join(", ")}`)

  return names.map((toolName) => listedByName.get(toolName)!)
}

function passThroughSchema(schema: Record<string, unknown>): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "shellby-child-mcp",
      validate: (value) => ({ value: value as Record<string, unknown> }),
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  }
}

function mergeMeta(upstream: Record<string, unknown> | undefined, local: Record<string, unknown> | undefined): { _meta?: Record<string, unknown> } {
  if (!upstream && !local) return {}
  return { _meta: { ...upstream, ...local } }
}
