import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { DEFAULT_SHELL_ID, shellCloseInputSchema, shellPollInputSchema, shellResetInputSchema, shellRunInputSchema } from "./shell-contracts.js"
import { ShellSessionError, type ShellSnapshot } from "./session.js"
import { ShellSessionManager } from "./session-manager.js"

const exitCodeSchema = z.int().min(0).max(255)
const batchCommandSchema = z.object({
  run: z.int().positive(),
  command: z.string().describe("First command line, truncated to 20 characters."),
  path: z.string().optional().describe("Present only when this command overrides the inherited cwd."),
  status: z.enum(["queued", "running", "completed", "timed_out", "failed", "reset"]),
  exit_code: exitCodeSchema.nullable(),
  dropped_output_bytes: z.int().positive().optional(),
})
const shellSnapshotSchema = z.object({
  shell_id: z.string().optional(),
  status: z.enum(["running", "completed", "shell_exited", "reset"]),
  exit_code: exitCodeSchema.optional().describe("For batches, 0 only when every command succeeded; otherwise 1."),
  cwd: z.string(),
  output: z.string(),
  request_id: z.string().optional(),
  next_cursor: z.int().nonnegative().optional().describe("Pass to shell_poll to continue."),
  cursor_expired: z.literal(true).optional(),
  output_truncated: z.literal(true).optional().describe("More retained output is available through shell_poll."),
  dropped_output_bytes: z.int().positive().optional().describe("Output permanently discarded."),
  commands: z.array(batchCommandSchema).optional().describe("Per-command results for a batch."),
})

const shellPollSnapshotSchema = z.object({
  status: z.enum(["running", "completed", "shell_exited", "reset"]),
  exit_code: exitCodeSchema.optional().describe("For batches, 0 only when every command succeeded; otherwise 1."),
  output: z.string(),
  next_cursor: z.int().nonnegative().optional().describe("Pass to shell_poll to continue."),
  dropped_output_bytes: z.int().positive().optional().describe("Output permanently discarded."),
  commands: z.array(batchCommandSchema).optional().describe("Per-command results for a batch."),
})

export function registerShellExecutionTools(server: McpServer, shells: ShellSessionManager, workspace: string): void {
  const workspaceDescription = JSON.stringify(workspace)

  server.registerTool(
    "shell_run",
    {
      title: "Run a local shell command",
      description: `Run zsh in a persistent macOS shell. Reuse shell_id to keep cwd or environment. For independent commands, use a batch; batch commands run concurrently and inherit cwd and exported environment variables. Use *** Run: <directory> only to change cwd for that command. Relative directories resolve from cwd; absolute paths are allowed. New shells start in ${workspaceDescription}.`,
      inputSchema: shellRunInputSchema,
      outputSchema: shellSnapshotSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      try {
        const { shell_id, ...commandInput } = input
        const snapshot = await shells.withShell(shell_id, (shell) => shell.runCommand({ ...commandInput, signal: ctx.mcpReq.signal }))
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
        "Continue a shell_run that is still running or has retained output. Reuse the same shell_id and request_id and pass the previous next_cursor. Repeat while status is running, or while next_cursor is present and more output is needed.",
      inputSchema: shellPollInputSchema,
      outputSchema: shellPollSnapshotSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      try {
        const { shell_id, ...pollInput } = input
        const snapshot = await shells.withExistingShell(shell_id, (shell) => shell.pollCommand({ ...pollInput, signal: ctx.mcpReq.signal }))
        return pollSnapshotResult(snapshot)
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
      inputSchema: shellResetInputSchema,
      outputSchema: z.object({
        shell_generation: z.int().positive(),
        state_lost: z.literal(true),
        status: z.literal("ready"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input) => {
      try {
        const { shell_id, ...resetInput } = input
        const result = await shells.withShell(shell_id, (shell) => shell.reset(resetInput), { restoreCached: false })
        return {
          structuredContent: result,
          content: [],
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
          content: [],
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
      inputSchema: shellCloseInputSchema,
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
          content: [],
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
    content: [],
  }
}

function pollSnapshotResult(snapshot: ShellSnapshot) {
  if (snapshot.cursor_expired) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "cursor_expired: Output before the requested cursor is no longer retained. Rerun the command if complete output is required.",
        },
      ],
    }
  }

  const structuredContent: CompactShellPollSnapshot = {
    status: snapshot.status,
    output: snapshot.output,
  }
  if (snapshot.exit_code !== null) structuredContent.exit_code = snapshot.exit_code
  if (snapshot.status === "running" || snapshot.output_truncated) structuredContent.next_cursor = snapshot.next_cursor
  if (snapshot.dropped_output_bytes > 0) structuredContent.dropped_output_bytes = snapshot.dropped_output_bytes
  if (snapshot.commands) structuredContent.commands = compactBatchCommands(snapshot.commands)

  return {
    structuredContent,
    content: [],
  }
}

interface CompactShellSnapshot extends Record<string, unknown> {
  shell_id?: string
  status: ShellSnapshot["status"]
  exit_code?: number
  cwd: string
  output: string
  request_id?: string
  next_cursor?: number
  cursor_expired?: true
  output_truncated?: true
  dropped_output_bytes?: number
  commands?: CompactBatchCommand[]
}

interface CompactShellPollSnapshot extends Record<string, unknown> {
  status: ShellSnapshot["status"]
  exit_code?: number
  output: string
  next_cursor?: number
  dropped_output_bytes?: number
  commands?: CompactBatchCommand[]
}

interface CompactBatchCommand {
  run: number
  command: string
  path?: string
  status: string
  exit_code: number | null
  dropped_output_bytes?: number
}

function compactBatchCommands(commands: NonNullable<ShellSnapshot["commands"]>): CompactBatchCommand[] {
  return commands.map((command) => ({
    run: command.run,
    command: command.command,
    ...(command.path === "." ? {} : { path: command.path }),
    status: command.status,
    exit_code: command.exit_code,
    ...(command.dropped_output_bytes ? { dropped_output_bytes: command.dropped_output_bytes } : {}),
  }))
}

function compactShellSnapshot(snapshot: ShellSnapshot, shellId: string): CompactShellSnapshot {
  const compact: CompactShellSnapshot = {
    status: snapshot.status,
    cwd: snapshot.cwd,
    output: snapshot.output,
  }
  if (snapshot.exit_code !== null) compact.exit_code = snapshot.exit_code
  if (shellId !== DEFAULT_SHELL_ID) compact.shell_id = shellId
  if (snapshot.status === "running" || snapshot.output_truncated) {
    compact.request_id = snapshot.request_id
    compact.next_cursor = snapshot.next_cursor
  }
  if (snapshot.cursor_expired) compact.cursor_expired = true
  if (snapshot.output_truncated) compact.output_truncated = true
  if (snapshot.dropped_output_bytes > 0) compact.dropped_output_bytes = snapshot.dropped_output_bytes
  if (snapshot.commands) compact.commands = compactBatchCommands(snapshot.commands)
  return compact
}

function toolError(error: unknown) {
  const text =
    error instanceof ShellSessionError ? `${error.code}: ${error.message}` : `internal_error: ${error instanceof Error ? error.message : String(error)}`
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}
