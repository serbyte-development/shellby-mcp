import { readFile } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"

import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { encodeImageForMcp, formatBytes, ImageEncodingError } from "./image-encoding.js"

export function registerImageTools(server: McpServer, workspace: string): void {
  server.registerTool(
    "image_view",
    {
      title: "View image",
      description: "View a local image file. Relative paths resolve from the default workspace.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Local image path. Relative paths resolve from the default workspace."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ path }, ctx) => {
      const imagePath = isAbsolute(path) ? path : resolve(workspace, path)
      try {
        const encoded = await encodeImageForMcp(await readFile(imagePath, { signal: ctx.mcpReq.signal }))
        return {
          content: [
            {
              type: "text" as const,
              text: `${basename(imagePath)} — ${encoded.width}×${encoded.height} — ${formatBytes(encoded.sizeBytes)}`,
            },
            {
              type: "image" as const,
              data: encoded.data,
              mimeType: encoded.mimeType,
            },
          ],
        }
      } catch (error) {
        const text =
          error instanceof ImageEncodingError
            ? `${error.code}: ${error.message}`
            : `IMAGE_VIEW_FAILED: ${error instanceof Error ? error.message : String(error)}`
        return {
          isError: true,
          content: [{ type: "text" as const, text }],
        }
      }
    }
  )
}
