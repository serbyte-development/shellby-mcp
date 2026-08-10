import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ShellSessionError, type ShellSnapshot } from "./session.js"
import { DEFAULT_SHELL_ID, ShellSessionManager } from "./session-manager.js"

const requestIdInput = z.string().min(1).max(128).describe("Short operation label, unique within this shell. Reuse only to retry the exact same operation.")

const shellIdInput = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .default(DEFAULT_SHELL_ID)
  .describe(
    "Short task or project label for a persistent shell, such as api-audit. Use to retain cwd and environment, or use a different ID for concurrent work."
  )

const closableShellIdInput = z
  .string()
  .min(1)
  .max(64)
  .describe(`Named non-default shell to close. The ${DEFAULT_SHELL_ID} shell is protected and can only be reset.`)

const shellSnapshotSchema = z.object({
  shell_id: z.string().optional().describe("Present only when the command uses a non-default shell."),
  status: z.enum(["running", "completed", "shell_exited", "reset"]),
  exit_code: z.int().nullable(),
  cwd: z.string().describe("The shell working directory for this command. Completed results report the resulting persistent directory."),
  output: z.string(),
  request_id: z.string().optional().describe("Present only when shell_poll may be needed."),
  next_cursor: z.int().nonnegative().optional().describe("Present only when shell_poll may be needed."),
  has_more: z.literal(true).optional().describe("Present when retained output remains unread."),
  cursor_expired: z.literal(true).optional().describe("Present when output before the requested cursor is no longer retained."),
  output_truncated: z
    .literal(true)
    .optional()
    .describe("Present when the per-command capture ceiling discarded output. Polling cannot recover discarded bytes."),
  dropped_output_bytes: z.int().positive().optional().describe("Present when UTF-8 command-output bytes were discarded by the per-command capture ceiling."),
})

export function registerShellExecutionTools(server: McpServer, shells: ShellSessionManager, workspace: string): void {
  const workspaceDescription = JSON.stringify(workspace)
  const maxOutputBytesInput = z
    .int()
    .min(256)
    .max(shells.maximumReadBytes)
    .optional()
    .default(shells.defaultReadBytes)
    .describe("Maximum UTF-8 bytes returned in this response. DO NOT pass in max_output_bytes unless the default is too small.")

  server.registerTool(
    "shell_run",
    {
      title: "Run a local shell command",
      description: `Execute a command in a named persistent shell. Use short contextual IDs: shell_id labels the task or project, and request_id labels the command or step. Reuse shell_id to retain cwd and environment. Change directories once with cd or cwd, then omit cwd until intentionally switching. Prefer RTK whenever available for reads. Use different shell IDs for parallel work; start long commands with wait_ms: 0 and poll. Responses are byte-capped, do not pass in max_output_bytes unless the default is too small. New shells start in ${workspaceDescription}.`,
      inputSchema: z.object({
        shell_id: shellIdInput,
        request_id: requestIdInput.describe(
          "Short command or step label, unique within this shell, such as scan-routes-1. Reuse only to retry the exact same command."
        ),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Optional absolute directory switch. Use when starting or intentionally moving a shell; it persists, so omit it from later calls."),
        command: z
          .string()
          .min(1)
          .max(262_144)
          .describe(
            "Exact zsh command or multiline script. Prefer RTK whenever available for reads, such as rtk read, rtk ls, rtk tree, rtk rg, rtk git diff, and rtk test npm test. Use raw shell for unsupported behavior, exact unfiltered output, or persistent state changes."
          ),
        wait_ms: z.int().min(0).max(10_000).optional().default(1_500).describe("Returns earlier if the output byte cap is reached."),
        max_output_bytes: maxOutputBytesInput,
      }),
      outputSchema: shellSnapshotSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ shell_id, request_id, cwd, command, wait_ms, max_output_bytes }, ctx) => {
      try {
        const shell = shells.getOrCreate(shell_id)
        const snapshot = await shell.runCommand({
          requestId: request_id,
          command,
          cwd,
          waitMs: wait_ms,
          maxOutputBytes: max_output_bytes,
          signal: ctx.mcpReq.signal,
        })
        return snapshotResult(snapshot, shell_id)
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "shell_poll",
    {
      title: "Poll local shell output",
      description:
        "Read more output for a command using the cursor returned by shell_run or a previous shell_poll call. Output is bounded to that command after it completes. Continue while a foreground command is running. When a completed command has_more, request more only if the omitted output is needed.",
      inputSchema: z.object({
        shell_id: shellIdInput.describe("The same shell_id used for the original shell_run call."),
        request_id: requestIdInput.describe("The same request_id used for the original shell_run call."),
        cursor: z.int().nonnegative().describe("The next_cursor returned by the previous result."),
        wait_ms: z.int().min(0).max(10_000).optional().default(2_000),
        max_output_bytes: maxOutputBytesInput,
      }),
      outputSchema: shellSnapshotSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ shell_id, request_id, cursor, wait_ms, max_output_bytes }, ctx) => {
      try {
        const shell = shells.getExisting(shell_id)
        const snapshot = await shell.pollCommand({
          requestId: request_id,
          cursor,
          waitMs: wait_ms,
          maxOutputBytes: max_output_bytes,
          signal: ctx.mcpReq.signal,
        })
        return snapshotResult(snapshot, shell_id)
      } catch (error) {
        return toolError(error)
      }
    }
  )
}

export function registerShellManagementTools(server: McpServer, shells: ShellSessionManager): void {
  server.registerTool(
    "shell_reset",
    {
      title: "Reset the local shell",
      description:
        "Attempt to terminate the persistent shell process group, discard its working directory and environment state, and start a clean shell. Use this to recover from a stuck foreground command. Process-group cleanup is best effort if signaling is denied.",
      inputSchema: z.object({
        shell_id: shellIdInput,
        request_id: requestIdInput,
        reason: z.string().max(256).optional(),
      }),
      outputSchema: z.object({
        request_id: z.string(),
        shell_generation: z.int().positive(),
        state_lost: z.literal(true),
        status: z.literal("ready"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ shell_id, request_id, reason }) => {
      try {
        const shell = shells.getOrCreate(shell_id)
        const result = await shell.reset({ requestId: request_id, reason })
        return {
          structuredContent: result,
          content: [
            {
              type: "text" as const,
              text: `Shell ${shell_id} reset ${result.request_id} complete. Generation ${result.shell_generation} is ready; previous shell state was lost.`,
            },
          ],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "shell_list",
    {
      title: "List local shells",
      description: "List currently open persistent shells, their activity state, idle duration, and whether they may be closed.",
      outputSchema: z.object({
        shells: z.array(
          z.object({
            shell_id: z.string(),
            status: z.enum(["idle", "active"]),
            is_default: z.boolean(),
            can_close: z.boolean(),
            idle_ms: z.int().nonnegative(),
          })
        ),
        count: z.int().nonnegative(),
        limit: z.int().positive(),
        idle_timeout_ms: z.int().nonnegative(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async () => {
      try {
        const result = {
          shells: shells.listShells(),
          count: shells.shellCount,
          limit: shells.maximumShells,
          idle_timeout_ms: shells.idleTimeoutMilliseconds,
        }
        return {
          structuredContent: result,
          content: [
            {
              type: "text" as const,
              text: `${result.count} shell${result.count === 1 ? "" : "s"} open; limit ${result.limit}.`,
            },
          ],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "shell_close",
    {
      title: "Close a local shell",
      description: `Terminate a named shell, discard its state and retained records, and immediately free its slot. The ${DEFAULT_SHELL_ID} shell is protected; use shell_reset if it freezes.`,
      inputSchema: z.object({
        shell_id: closableShellIdInput,
      }),
      outputSchema: z.object({
        shell_id: z.string(),
        closed: z.literal(true),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ shell_id }) => {
      try {
        await shells.closeShell(shell_id)
        const result = { shell_id, closed: true as const }
        return {
          structuredContent: result,
          content: [
            {
              type: "text" as const,
              text: `Shell ${shell_id} closed and its slot was released.`,
            },
          ],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )
}

function snapshotResult(snapshot: ShellSnapshot, shellId: string) {
  const structuredContent = compactShellSnapshot(snapshot, shellId)
  return {
    structuredContent,
    content: [
      {
        type: "text" as const,
        text: shellResultSummary(structuredContent),
      },
    ],
  }
}

interface CompactShellSnapshot extends Record<string, unknown> {
  shell_id?: string
  status: ShellSnapshot["status"]
  exit_code: number | null
  cwd: string
  output: string
  request_id?: string
  next_cursor?: number
  has_more?: true
  cursor_expired?: true
  output_truncated?: true
  dropped_output_bytes?: number
}

function compactShellSnapshot(snapshot: ShellSnapshot, shellId: string): CompactShellSnapshot {
  const compact: CompactShellSnapshot = {
    status: snapshot.status,
    exit_code: snapshot.exit_code,
    cwd: snapshot.cwd,
    output: snapshot.output,
  }
  if (shellId !== DEFAULT_SHELL_ID) compact.shell_id = shellId
  if (snapshot.status === "running" || snapshot.has_more) {
    compact.request_id = snapshot.request_id
    compact.next_cursor = snapshot.next_cursor
  }
  if (snapshot.has_more) compact.has_more = true
  if (snapshot.cursor_expired) compact.cursor_expired = true
  if (snapshot.output_truncated) compact.output_truncated = true
  if (snapshot.dropped_output_bytes > 0) compact.dropped_output_bytes = snapshot.dropped_output_bytes
  return compact
}

function shellResultSummary(snapshot: CompactShellSnapshot): string {
  const exit = snapshot.exit_code ?? "n/a"
  if (snapshot.status === "running") return `shell running; poll request=${snapshot.request_id} cursor=${snapshot.next_cursor}`
  if (snapshot.has_more) return `shell ${snapshot.status}, exit=${exit}; more output at request=${snapshot.request_id} cursor=${snapshot.next_cursor}`
  if (snapshot.dropped_output_bytes) return `shell ${snapshot.status}, exit=${exit}; dropped=${snapshot.dropped_output_bytes} bytes`
  return `shell ${snapshot.status}, exit=${exit}`
}

function toolError(error: unknown) {
  const text =
    error instanceof ShellSessionError ? `${error.code}: ${error.message}` : `internal_error: ${error instanceof Error ? error.message : String(error)}`
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}
