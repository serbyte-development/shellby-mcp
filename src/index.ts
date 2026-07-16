import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { PersistentShellSession } from "./shell-session.js";
import { startMcpHttpServer } from "./http-server.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePositiveInteger(process.env.PORT, 3333);
const logCommands = parseBoolean(process.env.MCP_LOG_COMMANDS, true);
const cwd =
  process.env.MCP_CWD ?? join(homedir(), "Desktop", "chatgpt-workspace");
await mkdir(cwd, { recursive: true });

const shell = new PersistentShellSession({
  shellPath: process.env.MCP_SHELL ?? "/bin/zsh",
  cwd,
  transcriptLimit: parsePositiveInteger(
    process.env.MCP_TRANSCRIPT_CHARS,
    1024 * 1024,
  ),
  readLimit: parsePositiveInteger(process.env.MCP_OUTPUT_CHARS, 64 * 1024),
  recordLimit: parsePositiveInteger(process.env.MCP_RECORD_LIMIT, 1024),
  logCommands,
});

const running = await startMcpHttpServer({ host, port, shell });
console.log(`Local shell MCP server: ${running.url}`);
console.log(`Shell: ${process.env.MCP_SHELL ?? "/bin/zsh"}`);
console.log(`Default workspace: ${cwd}`);

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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`Expected a boolean, received ${JSON.stringify(value)}.`);
}
