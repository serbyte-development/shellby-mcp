import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { MIN_OUTPUT_TOKENS, OUTPUT_TOKEN_ENCODING } from "../../tokenizer.js"
import { ShellSessionError, type ParallelCommandSnapshot, type ShellSnapshot } from "./session.js"
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
  exit_code: z.int().nullable().describe("Command exit code. Completed parallel batches return 0 only when every child succeeded, otherwise 1."),
  cwd: z.string().describe("The shell working directory for this command, or the root cwd for a parallel batch."),
  output: z.string().describe("Command output. Parallel batches return completed run output in labeled blocks"),
  commands: z
    .array(
      z.object({
        run: z.int().positive(),
        path: z.string().describe("Declared working directory for this run. Relative paths resolve from the batch cwd; absolute paths are used directly."),
        status: z.enum(["queued", "running", "completed", "timed_out", "failed", "reset"]),
        exit_code: z.int().nullable(),
        output_dropped: z.literal(true).optional().describe("Present when this child permanently discarded output at its capture ceiling."),
        dropped_output_bytes: z.int().positive().optional(),
      })
    )
    .optional()
    .describe("Present only for a parallel batch, in submission order."),
  request_id: z.string().optional().describe("Present when the command is still running or this response was truncated and can be continued with shell_poll."),
  next_cursor: z
    .int()
    .nonnegative()
    .optional()
    .describe("Continuation cursor for shell_poll when the command is still running or this response was truncated."),
  cursor_expired: z.literal(true).optional().describe("Present when output before the requested cursor is no longer retained."),
  output_truncated: z
    .literal(true)
    .optional()
    .describe("Present response stopped at max_output_tokens while additional retained output remains. The omitted output is recoverable with shell_poll."),
  output_dropped: z
    .literal(true)
    .optional()
    .describe("Present when the per-command capture ceiling permanently discarded output. Polling cannot recover discarded bytes."),
  dropped_output_bytes: z.int().positive().optional().describe("Present when UTF-8 command-output bytes were discarded by the per-command capture ceiling."),
})

export function registerShellExecutionTools(server: McpServer, shells: ShellSessionManager, workspace: string): void {
  const workspaceDescription = JSON.stringify(workspace)
  const maxOutputTokensInput = z
    .int()
    .min(MIN_OUTPUT_TOKENS)
    .max(shells.maximumReadTokens)
    .optional()
    .default(shells.defaultReadTokens)
    .describe(`Maximum ${OUTPUT_TOKEN_ENCODING} tokens returned in this response. DO NOT pass in max_output_tokens unless the default is too small.`)

  server.registerTool(
    "shell_run",
    {
      title: "Run a local shell command",
      description: `Execute one command or a parallel command batch in a named persistent shell. Reuse shell_id to retain cwd and exported environment. For independent commands, repeat *** Run: <directory-or-relative-path> followed by zsh. Every run must declare a directory. Relative paths such as ., ./api, and ../../shared resolve from the call's cwd/root; absolute paths such as /tmp are used directly. Prefer RTK for supported reads. New shells start in ${workspaceDescription}.`,
      inputSchema: z.object({
        shell_id: shellIdInput,
        request_id: requestIdInput.describe(
          "Short command or step label, unique within this shell, such as scan-routes-1. Reuse only to retry the exact same command."
        ),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Optional absolute directory switch. It persists for normal commands and becomes the anchor for relative paths in a parallel batch."),
        command: z
          .string()
          .min(1)
          .max(262_144)
          .describe(
            "Exact zsh command or multiline script. For parallel work, repeat `*** Run: <directory-or-relative-path>` followed by the zsh for that run."
          ),
        wait_ms: z
          .int()
          .min(0)
          .max(MCP_CONFIG.shell.maxWaitMs)
          .optional()
          .default(MCP_CONFIG.shell.defaultWaitMs)
          .describe("Returns earlier if the output token cap is reached."),
        max_output_tokens: maxOutputTokensInput,
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
    async ({ shell_id, request_id, cwd, command, wait_ms, max_output_tokens }, ctx) => {
      try {
        const shell = shells.getOrCreate(shell_id)
        const snapshot = await shell.runCommand({
          requestId: request_id,
          command,
          cwd,
          waitMs: wait_ms,
          maxOutputTokens: max_output_tokens,
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
        "Read additional output or updated state for a previous shell_run. For a parallel batch, poll only the same outer shell_id and request_id using next_cursor; child runs appear in commands and are never polled separately. Poll while status is running. If a completed result has output_truncated, only continue when the omitted output is needed to complete the task.",
      inputSchema: z.object({
        shell_id: shellIdInput.describe("The same shell_id used for the original shell_run call."),
        request_id: requestIdInput.describe("The same request_id used for the original shell_run call."),
        cursor: z
          .int()
          .nonnegative()
          .describe("The next_cursor returned by the previous result. Only pass in this cursor when the omitted output is needed to complete the task."),
        wait_ms: z.int().min(0).max(MCP_CONFIG.shell.maxWaitMs).optional().default(2_000),
        max_output_tokens: maxOutputTokensInput,
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
    async ({ shell_id, request_id, cursor, wait_ms, max_output_tokens }, ctx) => {
      try {
        const shell = shells.getExisting(shell_id)
        const snapshot = await shell.pollCommand({
          requestId: request_id,
          cursor,
          waitMs: wait_ms,
          maxOutputTokens: max_output_tokens,
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
  cursor_expired?: true
  output_truncated?: true
  output_dropped?: true
  dropped_output_bytes?: number
  commands?: ParallelCommandSnapshot[]
}

function compactShellSnapshot(snapshot: ShellSnapshot, shellId: string): CompactShellSnapshot {
  const compact: CompactShellSnapshot = {
    status: snapshot.status,
    exit_code: snapshot.exit_code,
    cwd: snapshot.cwd,
    output: snapshot.output,
  }
  if (shellId !== DEFAULT_SHELL_ID) compact.shell_id = shellId
  if (snapshot.status === "running" || snapshot.output_truncated) {
    compact.request_id = snapshot.request_id
    compact.next_cursor = snapshot.next_cursor
  }
  if (snapshot.cursor_expired) compact.cursor_expired = true
  if (snapshot.output_truncated) compact.output_truncated = true
  if (snapshot.output_dropped) compact.output_dropped = true
  if (snapshot.dropped_output_bytes > 0) compact.dropped_output_bytes = snapshot.dropped_output_bytes
  if (snapshot.commands) compact.commands = snapshot.commands
  return compact
}

function shellResultSummary(snapshot: CompactShellSnapshot): string {
  if (snapshot.commands) {
    const finished = snapshot.commands.filter((command) => command.status !== "queued" && command.status !== "running").length
    const issues = snapshot.commands.filter(
      (command) => command.status === "timed_out" || command.status === "failed" || (command.status === "completed" && command.exit_code !== 0)
    ).length
    if (snapshot.status === "running") {
      return `shell parallel running; ${finished}/${snapshot.commands.length} finished; poll request=${snapshot.request_id} cursor=${snapshot.next_cursor}`
    }
    if (snapshot.output_truncated) {
      return `shell parallel ${snapshot.status}; ${issues} issue${issues === 1 ? "" : "s"}; response output truncated; cursor=${snapshot.next_cursor}`
    }
    return `shell parallel ${snapshot.status}; ${issues} issue${issues === 1 ? "" : "s"}`
  }
  const exit = snapshot.exit_code ?? "n/a"
  if (snapshot.status === "running") return `shell running; poll request=${snapshot.request_id} cursor=${snapshot.next_cursor}`
  if (snapshot.output_truncated) return `shell ${snapshot.status}, exit=${exit}; response output truncated; cursor=${snapshot.next_cursor}`
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
