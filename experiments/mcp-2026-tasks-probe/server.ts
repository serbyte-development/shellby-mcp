import { randomUUID } from "node:crypto"
import { createServer, type Server as HttpServer } from "node:http"
import { pathToFileURL } from "node:url"

import { createMcpHandler, McpServer, classifyInboundRequest } from "@modelcontextprotocol/server"
import { toNodeHandler } from "@modelcontextprotocol/node"

export const PROTOCOL_VERSION = "2026-07-28"
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
export const PROBE_TOOL = "temporary_2026_tasks_probe"
export const MODERN_ONLY_MARKER = "MCP_2026_OK__TASKS_EXTENSION_NOT_DECLARED"
export const FULL_SUCCESS_MARKER = "MCP_2026_OK__TASKS_EXTENSION_OK"

const SERVER_INFO = {
  name: "temporary-mcp-2026-tasks-probe",
  version: "0.0.0",
}
const SERVER_META = {
  "io.modelcontextprotocol/serverInfo": SERVER_INFO,
}
const TASK_TTL_MS = 60_000
const TASK_POLL_INTERVAL_MS = 25

interface StoredTask {
  taskId: string
  createdAt: string
  lastUpdatedAt: string
}

interface ProbeHandler {
  fetch: (request: Request) => Promise<Response>
  close: () => Promise<void>
}

export interface RunningProbeServer {
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

function createProbeHandler(): ProbeHandler {
  const tasks = new Map<string, StoredTask>()
  const core = createMcpHandler(
    () => {
      const server = new McpServer(SERVER_INFO, {
        capabilities: {
          extensions: {
            [TASKS_EXTENSION]: {},
          },
        },
        instructions: "Temporary compatibility probe. Call only temporary_2026_tasks_probe.",
      })

      server.registerTool(
        PROBE_TOOL,
        {
          description: "Temporary no-op compatibility probe for MCP 2026-07-28 plus io.modelcontextprotocol/tasks. No side effects.",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => ({
          content: [{ type: "text", text: MODERN_ONLY_MARKER }],
        })
      )

      return server
    },
    {
      legacy: "reject",
      responseMode: "auto",
    }
  )

  return {
    fetch: async (request) => {
      if (request.method !== "POST") return core.fetch(request)

      const body = await readJsonClone(request)
      if (!isRecord(body) || body.jsonrpc !== "2.0" || !("id" in body)) return core.fetch(request)

      const params = isRecord(body.params) ? body.params : undefined
      if (body.method === "tools/call" && params?.name === PROBE_TOOL && hasTasksCapability(params)) {
        const classification = classifyInboundRequest({
          httpMethod: request.method,
          protocolVersionHeader: request.headers.get("mcp-protocol-version") ?? undefined,
          mcpMethodHeader: request.headers.get("mcp-method") ?? undefined,
          mcpNameHeader: request.headers.get("mcp-name") ?? undefined,
          body,
        })
        if (classification.kind !== "modern") return core.fetch(request)

        const now = new Date().toISOString()
        const taskId = randomUUID()
        tasks.set(taskId, { taskId, createdAt: now, lastUpdatedAt: now })
        return jsonRpcResult(body.id, {
          _meta: SERVER_META,
          resultType: "task",
          taskId,
          status: "working",
          statusMessage: "Temporary no-op task created; poll tasks/get once.",
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: TASK_TTL_MS,
          pollIntervalMs: TASK_POLL_INTERVAL_MS,
        })
      }

      if (body.method === "tasks/get" || body.method === "tasks/update" || body.method === "tasks/cancel") {
        return handleTaskMethod(request, body.id, body.method, params, tasks)
      }

      return core.fetch(request)
    },
    close: () => core.close(),
  }
}

export async function startProbeServer(options: { host?: string; port?: number } = {}): Promise<RunningProbeServer> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 3333
  const handler = createProbeHandler()
  const nodeHandler = toNodeHandler(handler)

  const httpServer = createServer(async (req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, tasksExtension: TASKS_EXTENSION }))
      return
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("Not found")
      return
    }
    await nodeHandler(req, res)
  })

  await listen(httpServer, port, host)
  const address = httpServer.address()
  if (!address || typeof address === "string") throw new Error("Temporary probe server did not expose a TCP address.")

  let closed = false
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}/mcp`,
    close: async () => {
      if (closed) return
      closed = true
      await Promise.allSettled([handler.close(), closeHttpServer(httpServer)])
    },
  }
}

function handleTaskMethod(
  request: Request,
  id: unknown,
  method: "tasks/get" | "tasks/update" | "tasks/cancel",
  params: Record<string, unknown> | undefined,
  tasks: Map<string, StoredTask>
): Response {
  const envelopeError = validateTaskRequestEnvelope(request, method, params)
  if (envelopeError) return envelopeError(id)

  const taskId = params?.taskId
  if (typeof taskId !== "string") return jsonRpcError(id, 200, -32602, "Invalid taskId.")
  const task = tasks.get(taskId)
  if (!task) return jsonRpcError(id, 200, -32602, "Unknown temporary probe taskId.")

  if (method === "tasks/get") {
    const now = new Date().toISOString()
    task.lastUpdatedAt = now
    return jsonRpcResult(id, {
      _meta: SERVER_META,
      resultType: "complete",
      taskId,
      status: "completed",
      statusMessage: "Temporary compatibility probe completed.",
      createdAt: task.createdAt,
      lastUpdatedAt: now,
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
      result: {
        content: [{ type: "text", text: FULL_SUCCESS_MARKER }],
        isError: false,
      },
    })
  }

  return jsonRpcResult(id, {
    _meta: SERVER_META,
    resultType: "complete",
  })
}

function validateTaskRequestEnvelope(
  request: Request,
  expectedMethod: "tasks/get" | "tasks/update" | "tasks/cancel",
  params: Record<string, unknown> | undefined
): ((id: unknown) => Response) | undefined {
  const taskId = params?.taskId
  const method = request.headers.get("mcp-method")
  const bodyProtocolVersion = requestMeta(params)?.["io.modelcontextprotocol/protocolVersion"]
  const headerProtocolVersion = request.headers.get("mcp-protocol-version")

  if (headerProtocolVersion !== PROTOCOL_VERSION || bodyProtocolVersion !== PROTOCOL_VERSION) {
    return (id) =>
      jsonRpcError(id, 400, -32022, "Temporary probe requires MCP protocol version 2026-07-28.", {
        supported: [PROTOCOL_VERSION],
        requested: typeof bodyProtocolVersion === "string" ? bodyProtocolVersion : headerProtocolVersion,
      })
  }

  const caps = clientCapabilities(params)
  if (!isRecord(caps?.extensions) || !isRecord(caps.extensions[TASKS_EXTENSION])) {
    return (id) =>
      jsonRpcError(id, 400, -32021, "Missing required client capability.", {
        requiredCapabilities: {
          extensions: {
            [TASKS_EXTENSION]: {},
          },
        },
      })
  }

  if (typeof taskId !== "string" || method !== expectedMethod || request.headers.get("mcp-name") !== taskId) {
    return (id) => jsonRpcError(id, 400, -32020, "MCP task routing headers do not match request parameters.")
  }

  return undefined
}

function hasTasksCapability(params: Record<string, unknown>): boolean {
  const caps = clientCapabilities(params)
  return isRecord(caps?.extensions) && isRecord(caps.extensions[TASKS_EXTENSION])
}

function clientCapabilities(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const meta = requestMeta(params)
  const caps = meta?.["io.modelcontextprotocol/clientCapabilities"]
  return isRecord(caps) ? caps : undefined
}

function requestMeta(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const meta = params?._meta
  return isRecord(meta) ? meta : undefined
}

async function readJsonClone(request: Request): Promise<unknown> {
  try {
    return await request.clone().json()
  } catch {
    return undefined
  }
}

function jsonRpcResult(id: unknown, result: Record<string, unknown>): Response {
  return Response.json({ jsonrpc: "2.0", id, result })
}

function jsonRpcError(id: unknown, status: number, code: number, message: string, data?: Record<string, unknown>): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data ? { data } : {}),
      },
    },
    { status }
  )
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return typeof entry === "string" && import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  const port = Number.parseInt(process.env.PORT ?? "3333", 10)
  const host = process.env.HOST ?? "127.0.0.1"
  const running = await startProbeServer({ host, port })
  console.log(`Temporary MCP 2026 Tasks probe: ${running.url}`)
  console.log(`Success marker: ${FULL_SUCCESS_MARKER}`)
}
