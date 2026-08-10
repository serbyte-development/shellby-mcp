import { createServer, type Server as HttpServer } from "node:http"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node"
import type { Request, Response } from "express"

import { ShellyAuthError, type ShellyAuthStore } from "./auth.js"
import { ChatGptSubagentModule, DEFAULT_CHATGPT_CDP_ENDPOINT, type ChatGptSubagentService } from "./chatgpt-subagent.js"
import { createMcpServer } from "./mcp-server.js"
import { characterCount, extractResultCharacterCounts, McpAuditLogger } from "./mcp-audit-log.js"
import { FeedbackStore } from "./feedback.js"
import { PeekabooClient } from "./peekaboo.js"
import { PersistentShellSession } from "./shell-session.js"
import { ShellSessionManager } from "./shell-session-manager.js"
import { WebPageOpener } from "./web-open.js"

interface InFlightMcpRequest {
  server: ReturnType<typeof createMcpServer>
  transport: NodeStreamableHTTPServerTransport
  close: () => Promise<void>
}

export interface RunningMcpServer {
  host: string
  port: number
  url: string
  shells: ShellSessionManager
  shell: PersistentShellSession
  peekaboo: PeekabooClient
  chatGptSubagents: ChatGptSubagentService
  close: () => Promise<void>
}

export interface StartMcpServerOptions {
  host?: string
  port?: number
  shell?: PersistentShellSession
  shellManager?: ShellSessionManager
  peekaboo?: PeekabooClient
  chatGptSubagents?: ChatGptSubagentService
  auditLogger?: McpAuditLogger
  authStore?: ShellyAuthStore
  feedbackStore?: FeedbackStore
  applyPatchExecutable?: string
  webPageOpener?: WebPageOpener
}

export async function startMcpHttpServer(options: StartMcpServerOptions = {}): Promise<RunningMcpServer> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 3333
  const shells = options.shellManager ?? new ShellSessionManager({ defaultShell: options.shell })
  const shell = shells.defaultShell
  const peekaboo = options.peekaboo ?? new PeekabooClient()
  const chatGptSubagents = options.chatGptSubagents ?? new ChatGptSubagentModule({ cdpEndpoint: DEFAULT_CHATGPT_CDP_ENDPOINT })
  const auditLogger = options.auditLogger
  const authStore = options.authStore
  const feedbackStore = options.feedbackStore ?? new FeedbackStore()
  const applyPatchExecutable = options.applyPatchExecutable ?? "apply_patch"
  const webPageOpener = options.webPageOpener ?? new WebPageOpener()
  const inFlightRequests = new Set<InFlightMcpRequest>()

  const app = createMcpExpressApp({ host, jsonLimit: "1mb" })
  const mcpRoute = /^\/mcp$/

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
  })

  const handleMcpPost = async (req: Request, res: Response): Promise<void> => {
    const auditCalls = auditLogger?.startToolCalls(req.body) ?? []
    const responseChunks: string[] = []
    if (auditCalls.length > 0) captureResponseBody(res, responseChunks)
    let auditFinished = false
    const finishAudit = (state: "finished" | "closed") => {
      if (auditFinished) return
      auditFinished = true
      const responseText = responseChunks.join("")
      const resultCharacterCounts = extractResultCharacterCounts(responseText)
      const fallbackOutputChars = characterCount(responseText)
      for (const auditCall of auditCalls) {
        auditCall.finish({
          httpStatus: res.statusCode,
          state,
          outputChars: resultCharacterCounts.get(auditCall.requestIdKey) ?? fallbackOutputChars,
        })
      }
    }
    res.once("finish", () => finishAudit("finished"))
    res.once("close", () => finishAudit("closed"))

    const mcpServer = createMcpServer(shells, {
      chatGptSubagents,
      feedbackStore,
      applyPatchExecutable,
      peekaboo,
      webPageOpener,
    })
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    let connected = false
    let closePromise: Promise<void> | undefined
    const request: InFlightMcpRequest = {
      server: mcpServer,
      transport,
      close: () => {
        closePromise ??= (async () => {
          try {
            if (connected) await mcpServer.close()
            else await transport.close()
          } finally {
            inFlightRequests.delete(request)
          }
        })()
        return closePromise
      },
    }
    inFlightRequests.add(request)

    const closeRequest = () => {
      void request.close().catch((error: unknown) => {
        console.error("Could not close MCP request:", error)
      })
    }
    res.once("finish", closeRequest)
    res.once("close", closeRequest)

    try {
      await mcpServer.connect(transport)
      connected = true
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error("MCP request failed:", error)
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal MCP server error.")
      } else if (!res.writableEnded) {
        res.end()
      }
    } finally {
      if (res.writableEnded || res.destroyed) {
        await request.close().catch((error: unknown) => {
          console.error("Could not close MCP request:", error)
        })
      }
    }
  }

  app.post(mcpRoute, async (req: Request, res: Response) => {
    if (authStore && isTrustedRemoteRequest(req) && containsToolCall(req.body)) {
      try {
        await authStore.authorizeToolCall(req.get("x-openai-subject"))
      } catch (error) {
        remoteAuthError(res, error)
        return
      }
    }
    await handleMcpPost(req, res)
  })

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST")
    jsonRpcError(res, 405, -32000, "Method not allowed.")
  }
  app.get(mcpRoute, methodNotAllowed)
  app.delete(mcpRoute, methodNotAllowed)

  const httpServer = createServer(app)
  let boundPort: number
  try {
    await shells.startDefault()
    await listen(httpServer, port, host)

    const address = httpServer.address()
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address.")
    }
    boundPort = address.port
  } catch (error) {
    const httpClose = closeHttpServerIfListening(httpServer)
    await Promise.allSettled([...inFlightRequests].map((request) => request.close()))
    await Promise.allSettled([httpClose, shells.close(), peekaboo.close(), chatGptSubagents.dispose()])
    throw error
  }

  let closed = false
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}/mcp`,
    shells,
    shell,
    peekaboo,
    chatGptSubagents,
    close: async () => {
      if (closed) return
      closed = true

      const httpClose = closeHttpServerIfListening(httpServer)
      try {
        await Promise.allSettled([...inFlightRequests].map((request) => request.close()))
        await httpClose
      } finally {
        await Promise.allSettled([shells.close(), peekaboo.close(), chatGptSubagents.dispose()])
      }
    },
  }
}

function containsToolCall(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload]
  return requests.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const request = value as { method?: unknown; params?: { name?: unknown } }
    return request.method === "tools/call" && typeof request.params?.name === "string" && request.params.name.length > 0
  })
}

function isTrustedRemoteRequest(req: Request): boolean {
  return req.get("x-shelly-remote") === "1"
}

function remoteAuthError(res: Response, error: unknown): void {
  if (error instanceof ShellyAuthError) {
    if (error.code === "subject_missing" || error.code === "subject_mismatch") {
      jsonRpcError(res, 403, -32002, "Remote MCP access denied.")
      return
    }
    jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
    return
  }

  console.error("Remote MCP authentication failed:", error)
  jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
}

function captureResponseBody(res: Response, chunks: string[]): void {
  const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response

  res.write = ((...args: unknown[]) => {
    captureResponseChunk(chunks, args[0], args[1])
    return originalWrite(...args)
  }) as typeof res.write

  res.end = ((...args: unknown[]) => {
    captureResponseChunk(chunks, args[0], args[1])
    return originalEnd(...args)
  }) as typeof res.end
}

function captureResponseChunk(chunks: string[], chunk: unknown, encoding: unknown): void {
  if (typeof chunk === "string") {
    chunks.push(chunk)
    return
  }
  if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return
  const normalizedEncoding = typeof encoding === "string" && Buffer.isEncoding(encoding) ? (encoding as BufferEncoding) : "utf8"
  chunks.push(Buffer.from(chunk).toString(normalizedEncoding))
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  })
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

function closeHttpServerIfListening(server: HttpServer): Promise<void> {
  return server.listening ? closeHttpServer(server) : Promise.resolve()
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
