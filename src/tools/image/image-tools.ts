import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { z } from "zod"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import { resolveWorkspacePath } from "../../utils.js"
import { encodeImageForMcp, formatBytes, ImageEncodingError } from "./image-encoding.js"

export function registerImageTools(registerTool: ToolRegistrar): void {
  registerTool(
    "image_view",
    {
      description: "View a local image file.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Local image path. Relative paths resolve from the workspace."),
      }),
      nativeContent: true,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }, ctx) => {
      const imagePath = resolveWorkspacePath(path)
      try {
        const encoded = await encodeImageForMcp(
          await readFile(imagePath, { signal: ctx.mcpReq.signal })
        )
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
