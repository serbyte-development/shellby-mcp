import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PersistentShellSession, ShellSessionError, type ShellSnapshot } from "./shell-session.js";

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
	const maxOutputBytesInput = z
		.number()
		.int()
		.min(256)
		.max(shell.maximumReadBytes)
		.optional()
		.default(shell.defaultReadBytes)
		.describe(`Maximum UTF-8 bytes returned in this response. Omit for ${shell.defaultReadBytes}; increase only when necessary, up to ${shell.maximumReadBytes}.`);
	const server = new McpServer(
		{
			name: "chatgpt-local-shell",
			version: "0.1.0",
		},
		{
			instructions: [
				`Prefer RTK equivalents whenever RTK supports a potentially noisy command, especially tests, builds, diffs, logs, searches, file reads, JSON, and package-manager output. Use the raw persistent shell for cd, exports, shell functions, background-process management, heredocs, and unsupported commands. RTK use is guidance only; the server does not rewrite commands. Output defaults to ${shell.defaultReadBytes} UTF-8 bytes per response. Increase max_output_bytes only when required, up to ${shell.maximumReadBytes}; redirect very large output to files and inspect targeted sections. It is very important that you protect context by using rtk and max_output_bytes when running commands.`,
				`Default workspace: ${workspace}. Reusable local tools live in ${workspace}/tools and are cataloged in ${workspace}/TOOLS.md. Before building a repeatable workflow, inspect the catalog and prefer an existing tool. Create a tool only when reuse is likely; follow ${workspace}/tools/README.md, validate it, then update the catalog. Run generated tools through shell_run. New filesystem tools do not require MCP metadata refresh.`,
				`Unless the user explicitly gives another location, clone repositories and create new project directories only as children of ${workspace}. Keep work for an existing project inside that project. Before cloning or creating, return to the default workspace if necessary. Do not create projects inside the MCP server source tree or /tmp. Other paths may be used when the user or task requires them.`,
				"Run local commands with shell_run. Generate a unique request_id for every new shell_run or shell_reset operation, and reuse it only when retrying the exact same operation. If status is running, call shell_poll with next_cursor. If has_more is true after completion, poll again only when the omitted output is needed; otherwise use a targeted follow-up command. Only one foreground command can run at once. Use normal shell '&' syntax for background processes. shell_reset destroys all current shell state and returns to the default workspace.",
			].join("\n\n"),
		}
	);

	server.registerTool(
		"shell_run",
		{
			title: "Run a local shell command",
			description: `Execute a command in the persistent local login shell. Use this for terminal work on the connected computer. The command may read or modify any local or network-accessible resource. Commands share working directory and environment. The default workspace for new projects and clones is ${workspace}; use another location only when the user or task requires it. Generate a unique request_id for every new command; reuse it only to safely retry the exact same call.`,
			inputSchema: {
				request_id: z.string().min(1).max(128).describe("Unique idempotency key chosen by the caller."),
				command: z.string().min(1).max(262_144).describe("The exact zsh command or multiline script to execute."),
				wait_ms: z.number().int().min(0).max(10_000).optional().default(1_500).describe("How long to wait for output or completion before returning."),
				max_output_bytes: maxOutputBytesInput,
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
		async ({ request_id, command, wait_ms, max_output_bytes }, extra) => {
			try {
				const snapshot = await shell.runCommand({
					requestId: request_id,
					command,
					waitMs: wait_ms,
					maxOutputBytes: max_output_bytes,
					signal: extra.signal,
				});
				return snapshotResult(snapshot);
			} catch (error) {
				return toolError(error);
			}
		}
	);

	server.registerTool(
		"shell_poll",
		{
			title: "Poll local shell output",
			description:
				"Read new terminal output for a command using the cursor returned by shell_run or a previous shell_poll call. This reads the shared shell transcript, so output from background processes may be included. Continue while a foreground command is running. When a completed command has_more, request more only if the omitted output is needed.",
			inputSchema: {
				request_id: z.string().min(1).max(128).describe("The request_id originally passed to shell_run."),
				cursor: z.number().int().nonnegative().describe("The next_cursor returned by the previous result."),
				wait_ms: z.number().int().min(0).max(10_000).optional().default(5_000).describe("How long to wait when no new output is available."),
				max_output_bytes: maxOutputBytesInput,
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
		async ({ request_id, cursor, wait_ms, max_output_bytes }, extra) => {
			try {
				const snapshot = await shell.pollCommand({
					requestId: request_id,
					cursor,
					waitMs: wait_ms,
					maxOutputBytes: max_output_bytes,
					signal: extra.signal,
				});
				return snapshotResult(snapshot);
			} catch (error) {
				return toolError(error);
			}
		}
	);

	server.registerTool(
		"shell_reset",
		{
			title: "Reset the local shell",
			description:
				"Kill the persistent shell and its process group, discard its working directory and environment state, and start a clean shell. Use this to recover from a stuck foreground command. This can terminate running processes. Generate a unique request_id for each new reset; reuse it only to safely retry the exact same reset.",
			inputSchema: {
				request_id: z.string().min(1).max(128).describe("Unique idempotency key chosen by the caller."),
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
		}
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
	const text = error instanceof ShellSessionError ? `${error.code}: ${error.message}` : `internal_error: ${error instanceof Error ? error.message : String(error)}`;
	return {
		isError: true,
		content: [{ type: "text" as const, text }],
	};
}
