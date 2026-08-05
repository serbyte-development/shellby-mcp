import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadEnvFile } from "node:process";

import {
  PersistentShellSession,
  type ShellSessionOptions,
} from "./shell-session.js";
import { ShellSessionManager } from "./shell-session-manager.js";
import { startMcpHttpServer } from "./http-server.js";
import { PeekabooClient } from "./peekaboo.js";
import {
  prepareApplyPatch,
  resolveWorkspacePath,
} from "./workspace-tools.js";

if (existsSync(".env")) loadEnvFile();

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePositiveInteger(process.env.PORT, 3333);
const authToken = process.env.MCP_AUTH_TOKEN;
if (authToken === undefined) {
  throw new Error("MCP_AUTH_TOKEN is required.");
}
const commandLogMode = parseCommandLogMode(process.env.MCP_LOG_COMMANDS);
const defaultOutputBytes = parsePositiveInteger(
  process.env.MCP_OUTPUT_BYTES,
  2 * 1024,
);
const maxOutputBytes = parsePositiveInteger(
  process.env.MCP_MAX_OUTPUT_BYTES,
  32 * 1024,
);
const cwd = resolveWorkspacePath(process.env.MCP_CWD);
await mkdir(cwd, { recursive: true });
const applyPatch = await prepareApplyPatch(cwd, process.env.MCP_CODEX_BIN);
const peekaboo = new PeekabooClient({
  executable: process.env.MCP_PEEKABOO_BIN ?? "peekaboo",
});

const shellOptions: ShellSessionOptions = {
  shellPath: process.env.MCP_SHELL ?? "/bin/zsh",
  cwd,
  pathPrepend: [applyPatch.binDirectory],
  transcriptLimit: parsePositiveInteger(
    process.env.MCP_TRANSCRIPT_CHARS,
    1024 * 1024,
  ),
  commandTranscriptBytes: parsePositiveInteger(
    process.env.MCP_COMMAND_TRANSCRIPT_BYTES,
    256 * 1024,
  ),
  defaultOutputBytes,
  maxOutputBytes,
  recordLimit: parsePositiveInteger(process.env.MCP_RECORD_LIMIT, 1024),
  commandLogMode,
};
const shells = new ShellSessionManager({
  createShell: () => new PersistentShellSession(shellOptions),
  maxShells: parsePositiveInteger(process.env.MCP_MAX_SHELLS, 8),
  idleTimeoutMs: parseNonNegativeInteger(
    process.env.MCP_SHELL_IDLE_TTL_MS,
    30 * 60 * 1000,
  ),
});

const running = await startMcpHttpServer({
  authToken,
  host,
  port,
  shellManager: shells,
  applyPatchExecutable: applyPatch.executable,
  peekaboo,
});
console.log(`Local shell MCP server: ${running.url}`);
console.log(`Shell: ${process.env.MCP_SHELL ?? "/bin/zsh"}`);
console.log(`Default workspace: ${cwd}`);
console.log(`Maximum named shells: ${shells.maximumShells}`);
if (applyPatch.available) {
  console.log(`apply_patch: ${applyPatch.executable}`);
} else {
  console.warn(`apply_patch unavailable: ${applyPatch.warning}`);
}
console.log(`Computer Use: Peekaboo CLI (${running.peekaboo.executable})`);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  await running.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error) => {
        console.error("Shutdown failed:", error);
        process.exit(1);
      },
    );
  });
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Expected a positive integer, received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `Expected a non-negative integer, received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

function parseCommandLogMode(
  value: string | undefined,
): "off" | "summary" | "full" {
  if (value === undefined) return "summary";
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on", "summary"].includes(normalized)) {
    return "summary";
  }
  if (normalized === "full") return "full";
  if (["0", "false", "no", "off"].includes(normalized)) return "off";
  throw new Error(
    `Expected MCP_LOG_COMMANDS to be off, summary, or full; received ${JSON.stringify(value)}.`,
  );
}
