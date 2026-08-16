import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ShellSessionError, type ShellSnapshot } from "./session.js"
import { DEFAULT_SHELL_ID, ShellSessionManager } from "./session-manager.js"

const requestIdInput = z.string().min(3).max(128).describe("Short operation label, unique within this shell. Reuse only to retry the exact same operation.")

const shellIdInput = z
  .string()
  .min(3)
  .max(64)
  .default(DEFAULT_SHELL_ID)
  .describe(
    "Short task or project label for a persistent shell, such as api-audit. Reusing an idle/evicted ID restores its cached cwd and exported environment when available."
  )

const closableShellIdInput = z
  .string()
  .min(3)
  .max(64)
  .describe(`Named shell to close. \`${DEFAULT_SHELL_ID}\` shell is protected and cannot be closed; use shell_reset instead.`)

const exitCodeSchema = z.int().min(0).max(255)
const maxOutputTokensInput = z
  .int()
  .min(1)
  .max(MCP_CONFIG.shell.maxOutputTokens)
  .default(MCP_CONFIG.shell.defaultOutputTokens)
  .describe("DO NOT pass in max_output_tokens unless the default is too small.")

const shellSnapshotSchema = z.object({
  shell_id: z.string().optional().describe("Present only when the command uses a non-default shell."),
  status: z.enum(["running", "completed", "shell_exited", "reset"]),
  exit_code: exitCodeSchema.optional().describe("Present when complete. Parallel batches return 0 only when every child succeeded, otherwise 1."),
  cwd: z.string().describe("The shell working directory for this command, or the root cwd for a parallel batch."),
  output: z.string().describe("Command output. Parallel runs are labeled with run number, path, status or exit code, and dropped bytes."),
  request_id: z.string().optional().describe("Present when the command is still running or this response was truncated and can be continued with shell_poll."),
  next_cursor: z
    .int()
    .nonnegative()
    .optional()
    .describe("Continuation cursor for shell_poll when the command is still running or this response was truncated."),
  cursor_expired: z.literal(true).optional(),
  output_truncated: z
    .literal(true)
    .optional()
    .describe("Present response stopped at max_output_tokens, additional retained output remains. Recoverable with shell_poll."),
  dropped_output_bytes: z
    .int()
    .positive()
    .optional()
    .describe("Present when command-output bytes were permanently discarded. A parallel run's label identifies its dropped-byte count."),
})

const shellPollSnapshotSchema = z.object({
  status: z.enum(["running", "completed", "shell_exited", "reset"]),
  exit_code: exitCodeSchema.optional().describe("Present when complete. Parallel batches return 0 only when every child succeeded, otherwise 1."),
  output: z.string().describe("Command output. Parallel runs are returned as labeled blocks."),
  next_cursor: z.int().nonnegative().optional().describe("Present while the command is running or additional retained output remains."),
  dropped_output_bytes: z.int().positive().optional().describe("Present when command-output bytes were permanently discarded."),
})

export function registerShellExecutionTools(server: McpServer, shells: ShellSessionManager, workspace: string): void {
  const workspaceDescription = JSON.stringify(workspace)

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
          .describe(
            "Exact zsh command or multiline script. For parallel work, repeat `*** Run: <directory-or-relative-path>` followed by the zsh for that run."
          ),
        wait_ms: z
          .int()
          .min(0)
          .max(MCP_CONFIG.shell.maxWaitMs)
          .default(MCP_CONFIG.shell.defaultWaitMs)
          .describe("Maximum time to wait. Returns sooner if the command finishes or the output token cap is reached."),
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
        const snapshot = await shells.withShell(shell_id, (shell) =>
          shell.runCommand({
            requestId: request_id,
            command,
            cwd,
            waitMs: wait_ms,
            maxOutputTokens: max_output_tokens,
            signal: ctx.mcpReq.signal,
          })
        )
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
        "Read additional output or updated state for a previous shell_run. For a parallel batch, poll only the same outer shell_id and request_id using next_cursor; labeled child results share that one output stream. Continue while status is running, or while next_cursor is present when omitted output is still needed.",
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
      outputSchema: shellPollSnapshotSchema,
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
        const snapshot = await shells.withExistingShell(shell_id, (shell) =>
          shell.pollCommand({
            requestId: request_id,
            cursor,
            waitMs: wait_ms,
            maxOutputTokens: max_output_tokens,
            signal: ctx.mcpReq.signal,
          })
        )
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
        "Attempt to terminate the persistent shell process group, discard live or cached working-directory/environment state, and start a clean shell. Use this to recover from a stuck foreground command. Process-group cleanup is best effort if signaling is denied.",
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
        const result = await shells.withShell(shell_id, (shell) => shell.reset({ requestId: request_id, reason }), { restoreCached: false })
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
      description:
        "List currently live persistent shells, their activity state, idle duration, live-slot limit, idle hibernation timeout, cache TTL, and whether they may be closed.",
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
        cache_ttl_ms: z.int().positive(),
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
          cache_ttl_ms: shells.cacheTimeoutMilliseconds,
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
      description: `Terminate a named live shell, discard its live and cached state and retained records, and immediately free its slot. The ${DEFAULT_SHELL_ID} shell is protected; use shell_reset if it freezes.`,
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
              text: `Shell ${shell_id} closed and its state was discarded; its live slot was released.`,
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
        text: shellResultSummary(snapshot),
      },
    ],
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

  return {
    structuredContent,
    content: [{ type: "text" as const, text: shellResultSummary(snapshot) }],
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
}

interface CompactShellPollSnapshot extends Record<string, unknown> {
  status: ShellSnapshot["status"]
  exit_code?: number
  output: string
  next_cursor?: number
  dropped_output_bytes?: number
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
  return compact
}

function shellResultSummary(snapshot: ShellSnapshot): string {
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
