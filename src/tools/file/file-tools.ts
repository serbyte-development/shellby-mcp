import { readFile, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { ToolError } from "../../mcp/tool-error.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import { resolveWorkspacePath } from "../../utils.js"

const openAiFileSchema = z.object({
  download_url: z.url(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
})

export function registerFileReadTool(registerTool: ToolRegistrar): void {
  registerTool(
    "file_read",
    {
      description: "Read a local file as binary MCP content.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Local file path. Relative paths resolve from the workspace."),
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
      const filePath = resolveWorkspacePath(path)
      try {
        const data = await readFile(filePath, { signal: ctx.mcpReq.signal })
        return {
          content: [
            {
              type: "resource" as const,
              resource: {
                uri: pathToFileURL(filePath).href,
                mimeType: "application/octet-stream",
                blob: data.toString("base64"),
              },
            },
          ],
        }
      } catch (error) {
        // biome-ignore lint/style/useErrorCause: ToolError forwards ErrorOptions from its third argument.
        throw new ToolError(
          "FILE_READ_FAILED",
          error instanceof Error ? error.message : String(error),
          { cause: error }
        )
      }
    }
  )
}

export function registerFileWriteTool(registerTool: ToolRegistrar): void {
  registerTool(
    "file_write",
    {
      description: "Write a ChatGPT file to the local filesystem.",
      inputSchema: z.object({
        file: openAiFileSchema,
        path: z
          .string()
          .min(1)
          .describe("Local destination path. Relative paths resolve from the workspace."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        "openai/fileParams": ["file"],
      },
    },
    async ({ file, path }, ctx) => {
      const filePath = resolveWorkspacePath(path)
      try {
        const response = await fetch(file.download_url, { signal: ctx.mcpReq.signal })
        if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`)
        const data = Buffer.from(await response.arrayBuffer())
        await writeFile(filePath, data, { signal: ctx.mcpReq.signal })
        return {
          content: [
            {
              type: "text" as const,
              text: `Wrote ${basename(filePath)} (${data.byteLength} bytes) to ${filePath}.`,
            },
          ],
        }
      } catch (error) {
        // biome-ignore lint/style/useErrorCause: ToolError forwards ErrorOptions from its third argument.
        throw new ToolError(
          "FILE_WRITE_FAILED",
          error instanceof Error ? error.message : String(error),
          { cause: error }
        )
      }
    }
  )
}
