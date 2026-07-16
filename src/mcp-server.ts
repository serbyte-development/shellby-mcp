import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  PersistentShellSession,
  ShellSessionError,
  type ShellSnapshot,
} from "./shell-session.js";

const noAuthMeta = {
  securitySchemes: [{ type: "noauth" }],
};

const shellSnapshotSchema = {
  request_id: z.string(),
  status: z.enum(["running", "completed", "shell_exited", "reset"]),
  exit_code: z.number().int().nullable(),
  output: z.string(),
  cursor: z.number().int().nonnegative(),
  next_cursor: z.number().int().nonnegative(),
  has_more: z.boolean(),
  cursor_expired: z.boolean(),
  state_lost: z.boolean(),
  shell_generation: z.number().int().positive(),
  active_request_id: z.string().nullable(),
};

export function createMcpServer(shell: PersistentShellSession): McpServer {
  const workspace = JSON.stringify(shell.initialCwd);
  const server = new McpServer(
    {
      name: "chatgpt-local-shell",
      version: "0.1.0",
    },
    {
      instructions: [
        `Default workspace: ${workspace}. Unless the user explicitly gives another location, clone repositories and create new project directories only as children of this workspace. Keep work for an existing project inside that project. Before cloning or creating, return to the default workspace if necessary. Do not create projects inside the MCP server source tree or /tmp. Other paths may be used when the user or task requires them.`,
        "Run local commands with shell_run. Generate a unique request_id for every new shell_run or shell_reset operation, and reuse it only when retrying the exact same operation. If status is running or has_more is true, call shell_poll with next_cursor. Only one foreground command can run at once. Use normal shell '&' syntax for background processes. shell_reset destroys all current shell state and returns to the default workspace.",
      ].join(" "),
    },
  );

  server.registerTool(
    "shell_run",
    {
      title: "Run a local shell command",
      description: `Execute a command in the persistent local login shell. Use this for terminal work on the connected computer. The command may read or modify any local or network-accessible resource. Commands share working directory and environment. The default workspace for new projects and clones is ${workspace}; use another location only when the user or task requires it. Generate a unique request_id for every new command; reuse it only to safely retry the exact same call.`,
      inputSchema: {
        request_id: z
          .string()
          .min(1)
          .max(128)
          .describe("Unique idempotency key chosen by the caller."),
        command: z
          .string()
          .min(1)
          .max(262_144)
          .describe("The exact zsh command or multiline script to execute."),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .default(1_500)
          .describe("How long to wait for output or completion before returning."),
      },
      outputSchema: shellSnapshotSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: noAuthMeta,
    },
    async ({ request_id, command, wait_ms }, extra) => {
      try {
        const snapshot = await shell.runCommand({
          requestId: request_id,
          command,
          waitMs: wait_ms,
          signal: extra.signal,
        });
        return snapshotResult(snapshot);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "shell_poll",
    {
      title: "Poll local shell output",
      description:
        "Read new terminal output for a command using the cursor returned by shell_run or a previous shell_poll call. This reads the shared shell transcript, so output from background processes may be included. Continue while has_more is true or when waiting for a running/background process.",
      inputSchema: {
        request_id: z
          .string()
          .min(1)
          .max(128)
          .describe("The request_id originally passed to shell_run."),
        cursor: z
          .number()
          .int()
          .nonnegative()
          .describe("The next_cursor returned by the previous result."),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .default(5_000)
          .describe("How long to wait when no new output is available."),
      },
      outputSchema: shellSnapshotSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async ({ request_id, cursor, wait_ms }, extra) => {
      try {
        const snapshot = await shell.pollCommand({
          requestId: request_id,
          cursor,
          waitMs: wait_ms,
          signal: extra.signal,
        });
        return snapshotResult(snapshot);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Reset the local shell",
      description:
        "Kill the persistent shell and its process group, discard its working directory and environment state, and start a clean shell. Use this to recover from a stuck foreground command. This can terminate running processes. Generate a unique request_id for each new reset; reuse it only to safely retry the exact same reset.",
      inputSchema: {
        request_id: z
          .string()
          .min(1)
          .max(128)
          .describe("Unique idempotency key chosen by the caller."),
        reason: z.string().max(256).optional(),
      },
      outputSchema: {
        request_id: z.string(),
        shell_generation: z.number().int().positive(),
        state_lost: z.literal(true),
        status: z.literal("ready"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async ({ request_id, reason }) => {
      try {
        const result = await shell.reset({ requestId: request_id, reason });
        return {
          structuredContent: result,
          content: [
            {
              type: "text",
              text: `Shell reset ${result.request_id} complete. Generation ${result.shell_generation} is ready; previous shell state was lost.`,
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

function snapshotResult(snapshot: ShellSnapshot) {
  const exit = snapshot.exit_code === null ? "n/a" : String(snapshot.exit_code);
  return {
    structuredContent: snapshot,
    content: [
      {
        type: "text" as const,
        text: `Shell request ${snapshot.request_id}: status=${snapshot.status}, exit_code=${exit}, output_chars=${snapshot.output.length}, next_cursor=${snapshot.next_cursor}, has_more=${snapshot.has_more}.`,
      },
    ],
  };
}

function toolError(error: unknown) {
  const text =
    error instanceof ShellSessionError
      ? `${error.code}: ${error.message}`
      : `internal_error: ${error instanceof Error ? error.message : String(error)}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}
