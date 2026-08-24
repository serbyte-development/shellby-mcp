#!/usr/bin/env node

import { appendFileSync } from "node:fs"

import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

const names = (process.env.FAKE_CHILD_TOOLS || "echo").split(",").filter(Boolean)
const logPath = process.env.FAKE_CHILD_MCP_LOG
const server = new McpServer({ name: "fake-child-mcp", version: "1.0.0" })

log({ event: "start", pid: process.pid })

for (const name of names) {
  server.registerTool(
    name,
    {
      description: `Fixture ${name} tool`,
      inputSchema: z.looseObject({ value: z.string().optional(), action: z.string().optional() }),
      ...(name === "echo" ? { outputSchema: z.object({ echo: z.string() }) } : {}),
      ...(name === "permissions" ? { annotations: { readOnlyHint: true } } : {}),
      _meta: { fixture: name },
    },
    async (args, ctx) => {
      log({ event: "call", pid: process.pid, name, args })

      if (name === "crash") {
        setImmediate(() => process.exit(23))
        return new Promise(() => undefined)
      }

      if (name === "app" && args.action === "fail") {
        return {
          content: [{ type: "text", text: "UPSTREAM_FAILURE: fixture requested failure" }],
          isError: true,
          _meta: { source: "fake-child" },
        }
      }

      if (name === "see") {
        return {
          content: [
            { type: "text", text: "snapshot_id=snapshot-native" },
            { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" },
          ],
          structuredContent: { snapshot_id: "snapshot-native", arguments: args },
          _meta: { source: "fake-child" },
        }
      }

      if (name === "echo") {
        const echo = args.value ?? ""
        return {
          content: [{ type: "text", text: echo }],
          structuredContent: { echo },
          _meta: { request_meta: ctx.mcpReq._meta },
        }
      }

      return {
        content: [{ type: "text", text: `${name}:ok` }],
        structuredContent: { name, arguments: args },
        _meta: { source: "fake-child" },
      }
    }
  )
}

await server.connect(new StdioServerTransport())

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`)
}
