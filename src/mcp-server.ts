import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PersistentShellSession, ShellSessionError, type ShellSnapshot } from "./shell-session.js";

const noAuthMeta = {
	securitySchemes: [{ type: "noauth" }],
};

const requestIdInput = z
	.string()
	.min(1)
	.max(128)
	.describe("Unique idempotency key. A short six-character lowercase alphanumeric value such as a7k2q9 is recommended, but not required.");

const shellSnapshotSchema = {
	request_id: z.string(),
	status: z.enum(["running", "completed", "shell_exited", "reset"]),
	exit_code: z.number().int().nullable(),
	output: z.string(),
	next_cursor: z.number().int().nonnegative(),
	has_more: z.boolean(),
	cursor_expired: z.boolean(),
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
				`Protect context aggressively. Use targeted searches, scoped file reads, focused diffs, capped logs, and the smallest output needed to make a decision. Scope commands before printing content: search specific paths, limit matches, list filenames before reading them, and inspect relevant sections. Avoid unbounded cat, broad rg or find, ls -R, git diff, test or build logs, large JSON or JSONL, and database output. Do not rely only on line caps because one line may be very large. Prefer RTK equivalents whenever RTK supports a potentially noisy command, especially tests, builds, diffs, logs, searches, file reads, JSON, and package-manager output. Use the raw persistent shell for cd, exports, shell functions, background-process management, heredocs, and unsupported commands. RTK use is guidance only; the server does not rewrite commands. Output defaults to ${shell.defaultReadBytes} UTF-8 bytes per response, so prefer max_output_bytes over adding head or tail solely to limit returned output. Increase it only when required, up to ${shell.maximumReadBytes}; redirect very large output to files and inspect targeted sections. When manually truncating a command whose exit status matters, preserve that status inside a subshell; never use a top-level exit because this shell is persistent. Do not truncate agent instructions, tool documentation, or policy files unless they are unexpectedly large.`,
				"Prefer apply_patch for manual source-file edits. Invoke it through shell_run with a single-quoted heredoc, run it from the relevant project root, and use relative paths. Use formatters or generators for generated files instead of patching generated output manually. apply_patch is a shell executable here, not a separate MCP tool.",
				`Default workspace: ${workspace}. Reusable local tools live in ${workspace}/tools and are cataloged in ${workspace}/TOOLS.md. Before building a repeatable workflow, inspect the catalog and prefer an existing tool. Create a tool only when reuse is likely; follow ${workspace}/tools/README.md, validate it, then update the catalog. Run generated tools through shell_run. New filesystem tools do not require MCP metadata refresh.`,
				`Unless the user explicitly gives another location, clone repositories and create new project directories only as children of ${workspace}. Keep work for an existing project inside that project. Before cloning or creating, return to the default workspace if necessary. Do not create projects inside the MCP server source tree or /tmp. Other paths may be used when the user or task requires them.`,
				"Run local commands with shell_run. Prefer a unique six-character lowercase alphanumeric request_id, such as a7k2q9, for every new shell_run or shell_reset operation, but other unique nonempty IDs are accepted. Reuse an ID only when polling or retrying that exact operation. If status is running, call shell_poll with next_cursor. If has_more is true after completion, poll again only when the omitted output is needed; otherwise use a targeted follow-up command. Only one foreground command can run at once. Redirect background-process output to a file and inspect it with a later command; completed-command polling is bounded and will not read subsequent shell output. shell_reset destroys all current shell state and returns to the default workspace.",
			].join("\n\n"),
		}
	);

	server.registerTool(
		"shell_run",
		{
			title: "Run a local shell command",
			description: `Execute a command in the persistent local login shell. Use this for terminal work on the connected computer. The command may read or modify any local or network-accessible resource. Commands share working directory and environment. The default workspace for new projects and clones is ${workspace}; use another location only when the user or task requires it. Prefer a unique six-character lowercase alphanumeric request_id for every new command; other unique nonempty IDs are accepted. Reuse an ID only to safely retry the exact same call.`,
			inputSchema: {
				request_id: requestIdInput,
				command: z.string().min(1).max(262_144).describe("The exact zsh command or multiline script to execute."),
				wait_ms: z.number().int().min(0).max(10_000).optional().default(1_500).describe("Maximum time to wait for command completion. Returns earlier if the output byte cap is reached."),
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
				"Read more output for a command using the cursor returned by shell_run or a previous shell_poll call. Output is bounded to that command after it completes. Continue while a foreground command is running. When a completed command has_more, request more only if the omitted output is needed.",
			inputSchema: {
				request_id: requestIdInput.describe("The six-character request_id originally passed to shell_run."),
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
				"Kill the persistent shell and its process group, discard its working directory and environment state, and start a clean shell. Use this to recover from a stuck foreground command. This can terminate running processes. Prefer a unique six-character lowercase alphanumeric request_id for each new reset; other unique nonempty IDs are accepted. Reuse an ID only to safely retry the exact same reset.",
			inputSchema: {
				request_id: requestIdInput,
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
