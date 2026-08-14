import type { PersistentShellSession, ShellSnapshot } from "../../src/tools/shell/session.js"

export async function runToCompletion(
  shell: PersistentShellSession,
  requestId: string,
  command: string,
  options: { cwd?: string } = {}
): Promise<{ output: string; snapshot: ShellSnapshot }> {
  const first = await shell.runCommand({
    requestId,
    command,
    cwd: options.cwd,
    waitMs: 1_000,
  })
  let output = first.output
  let snapshot = first

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && !snapshot.output_truncated) {
      return { output, snapshot }
    }
    snapshot = await shell.pollCommand({
      requestId,
      cursor: snapshot.next_cursor,
      waitMs: 100,
    })
    output += snapshot.output
  }

  throw new Error(`Command ${requestId} did not complete.`)
}

export async function pollToCompletion(shell: PersistentShellSession, first: ShellSnapshot): Promise<{ output: string; snapshot: ShellSnapshot }> {
  let output = first.output
  let snapshot = first

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && !snapshot.output_truncated) {
      return { output, snapshot }
    }
    snapshot = await shell.pollCommand({
      requestId: first.request_id,
      cursor: snapshot.next_cursor,
      waitMs: 100,
    })
    output += snapshot.output
  }

  throw new Error(`Command ${first.request_id} did not complete.`)
}

export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

export async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}
