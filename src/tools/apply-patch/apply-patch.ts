import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { tokenPrefix } from "../../tokenizer.js"

const FAILURE_OUTPUT_TOKENS = 1_024
const STOP_GRACE_MS = 500
const DEFAULT_APPLY_PATCH_BINARY = fileURLToPath(new URL("../../../vendor/apply-patch/apply_patch", import.meta.url))

export function registerApplyPatchTool(server: McpServer, executable = DEFAULT_APPLY_PATCH_BINARY): void {
  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Use the apply_patch tool to add, update, or delete files. The patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope: *** Begin Patch [ one or more file sections ] *** End Patch.",
      inputSchema: z.object({
        patch: z
          .string()
          .describe(
            "The complete patch text, beginning with *** Begin Patch and ending with *** End Patch. Prefer multiple small, focused apply_patch calls over one large patch, especially when editing files that were modified earlier in the task."
          ),
        cwd: z.string().refine(isAbsolute, "cwd must be an absolute path.").describe("Required absolute directory used as the patch root."),
      }),
      outputSchema: z.object({
        status: z.enum(["completed", "failed"]),
        exit_code: z.int().min(0).max(255).nullable(),
        output: z.string().optional().describe("Present only on failure with bounded apply_patch stdout/stderr diagnostics."),
        output_dropped: z
          .literal(true)
          .optional()
          .describe("Present when failure diagnostics exceeded the apply_patch token ceiling and output was permanently discarded."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ patch, cwd }, ctx) => {
      try {
        const result = await applyPatch({ patch, cwd, executable, signal: ctx.mcpReq.signal })
        return {
          ...(result.status === "failed" ? { isError: true } : {}),
          structuredContent: toToolResult(result),
          content: [
            {
              type: "text" as const,
              text:
                result.status === "failed" && result.output
                  ? `apply_patch failed, exit=${result.exit_code ?? "n/a"}\n\n${result.output}`
                  : `apply_patch ${result.status}, exit=${result.exit_code ?? "n/a"}`,
            },
          ],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `apply_patch_failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )
}

interface ApplyPatchInput {
  patch: string
  cwd: string
  executable: string
  signal?: AbortSignal
}

interface ApplyPatchResult extends Record<string, unknown> {
  status: "completed" | "failed"
  exit_code: number | null
  output: string
  output_dropped: boolean
}

interface CompactApplyPatchResult extends Record<string, unknown> {
  status: ApplyPatchResult["status"]
  exit_code: number | null
  output?: string
  output_dropped?: true
}

function toToolResult(result: ApplyPatchResult): CompactApplyPatchResult {
  const compact: CompactApplyPatchResult = {
    status: result.status,
    exit_code: result.exit_code,
  }
  if (result.status === "failed") {
    compact.output = result.output
    if (result.output_dropped) compact.output_dropped = true
  }
  return compact
}

async function applyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult> {
  input.signal?.throwIfAborted()

  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdoutDecoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")
    let output = ""
    let outputDropped = false
    let stdinError: Error | undefined
    let aborted = false
    let settled = false
    let terminateTimer: NodeJS.Timeout | null = null
    let forceSettleTimer: NodeJS.Timeout | null = null

    const appendOutput = (value: string) => {
      if (outputDropped || value.length === 0) return
      const bounded = tokenPrefix(output + value, FAILURE_OUTPUT_TOKENS)
      output = bounded.value
      outputDropped = bounded.truncated
    }
    const cleanup = () => {
      input.signal?.removeEventListener("abort", abort)
      if (terminateTimer) clearTimeout(terminateTimer)
      if (forceSettleTimer) clearTimeout(forceSettleTimer)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const killChild = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch {
        // Cleanup is best effort. Forced settlement below prevents a hung request.
      }
    }
    const abort = () => {
      if (aborted || settled) return
      aborted = true
      killChild("SIGTERM")
      terminateTimer = setTimeout(() => {
        if (settled) return
        killChild("SIGKILL")
        forceSettleTimer = setTimeout(() => {
          if (settled) return
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          fail(new Error("apply_patch request was aborted."))
        }, STOP_GRACE_MS)
      }, STOP_GRACE_MS)
    }

    child.stdout.on("data", (chunk: Buffer) => appendOutput(stdoutDecoder.write(chunk)))
    child.stdout.on("end", () => appendOutput(stdoutDecoder.end()))
    child.stderr.on("data", (chunk: Buffer) => appendOutput(stderrDecoder.write(chunk)))
    child.stderr.on("end", () => appendOutput(stderrDecoder.end()))
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stdinError = error
    })
    child.once("error", (error) => fail(new Error(`apply_patch failed to start: ${error.message}`, { cause: error })))
    child.once("close", (code) => {
      if (settled) return
      if (aborted) {
        fail(new Error("apply_patch request was aborted."))
        return
      }
      if (stdinError) {
        fail(new Error(`apply_patch stdin failed: ${stdinError.message}`, { cause: stdinError }))
        return
      }
      settled = true
      cleanup()
      resolve({
        status: code === 0 ? "completed" : "failed",
        exit_code: code,
        output,
        output_dropped: outputDropped,
      })
    })

    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted) abort()
    child.stdin.end(input.patch)
  })
}
