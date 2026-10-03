import { existsSync, statSync } from "node:fs"
import { createServer, request as requestHttp } from "node:http"
import { networkInterfaces } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { MCP_CONFIG } from "../src/config.js"

const HOST = "0.0.0.0"
const DEFAULT_PORT = 6001
const PORT = Number(process.env.SHELLBY_UI_PHONE_PORT ?? DEFAULT_PORT)
const UPSTREAM_HOST = "127.0.0.1"
const UPSTREAM_PORT = MCP_CONFIG.port
const UI_DIST = fileURLToPath(new URL("../ui/dist/", import.meta.url))

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("SHELLBY_UI_PHONE_PORT must be an integer from 1 to 65535.")
}
if (!MCP_CONFIG.ui.enabled) {
  throw new Error("Shellby UI is disabled. Enable [ui].enabled before using ui:phone.")
}
if (!existsSync(resolve(UI_DIST, "index.html"))) {
  throw new Error("Built Shellby UI is missing. Run npm run ui:build first.")
}

await assertDashboardAvailable()

const server = createServer((req, res) => {
  const method = req.method ?? "GET"
  const url = new URL(req.url ?? "/", "http://localhost")

  if (!isAllowedDashboardRequest(method, url.pathname)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Not found")
    return
  }

  const upstream = requestHttp(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method,
      path: url.pathname + url.search,
      headers: {
        ...req.headers,
        host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      },
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    }
  )

  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
    }
    res.end(`Shellby UI upstream unavailable: ${error.message}`)
  })

  req.pipe(upstream)
})

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen)
  server.listen(PORT, HOST, () => {
    server.off("error", rejectListen)
    resolveListen()
  })
})

const addresses = lanIpv4Addresses()
console.log(`Shellby UI phone proxy: http://localhost:${PORT}`)
for (const address of addresses) console.log(`Phone URL: http://${address}:${PORT}`)
console.log(`Dashboard upstream: http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`)
console.log("Only dashboard UI/API routes are exposed; /mcp is blocked.")

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
  })
}

function isAllowedDashboardRequest(method: string, pathname: string): boolean {
  if (method === "GET" && (pathname === "/api/agents" || pathname === "/api/events")) return true
  if (method === "POST" && /^\/api\/agents\/[^/]+\/steer$/u.test(pathname)) return true
  if (method === "DELETE" && /^\/api\/agents\/[^/]+\/instructions\/[^/]+$/u.test(pathname))
    return true

  if (method !== "GET" && method !== "HEAD") return false
  if (pathname === "/" || pathname === "/editor" || pathname === "/ui" || pathname === "/ui/")
    return true

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return false
  }

  const candidate = resolve(UI_DIST, `.${decodedPath}`)
  const childPath = relative(UI_DIST, candidate)
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) return false
  return existsSync(candidate) && statSync(candidate).isFile()
}

async function assertDashboardAvailable(): Promise<void> {
  let response: Response
  try {
    response = await fetch(`http://${UPSTREAM_HOST}:${UPSTREAM_PORT}/`, {
      signal: AbortSignal.timeout(1000),
    })
  } catch (error) {
    throw new Error(
      "Shellby is not reachable at http://" +
        UPSTREAM_HOST +
        ":" +
        UPSTREAM_PORT +
        ". Start it before running ui:phone.",
      { cause: error }
    )
  }
  if (!response.ok) {
    throw new Error(
      `Shellby dashboard returned HTTP ${response.status}. Ensure the UI is enabled and built.`
    )
  }
}

function lanIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
}
