import assert from "node:assert/strict"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { ParallelCommandScheduler } from "../src/tools/shell/parallel-runner.js"
import { PersistentShellSession, ShellSessionError } from "../src/tools/shell/session.js"
import { isProcessAlive, pollToCompletion, quote, runToCompletion, waitForProcessExit } from "./helpers/shell.js"
import { tempDir } from "./helpers/temp.js"

test("runs parallel command batches from one root with relative paths and retained exported environment", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-root-")
  const repoDirectory = join(directory, "workspace", "repo")
  const apiDirectory = join(repoDirectory, "packages", "api")
  const sharedDirectory = join(directory, "shared")
  await mkdir(apiDirectory, { recursive: true })
  await mkdir(sharedDirectory, { recursive: true })
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  await runToCompletion(shell, "parallel-env", "export MCP_PARALLEL_RETAINED=present")
  const batch = await runToCompletion(
    shell,
    "parallel-root",
    [
      "*** Run: .",
      `printf 'root:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"`,
      "*** Run: ./packages/api",
      `printf 'api:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"`,
      "*** Run: ../../shared",
      `printf 'shared:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"`,
    ].join("\n"),
    { cwd: repoDirectory }
  )

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 0)
  assert.deepEqual(
    batch.snapshot.commands?.map(({ run, path, status, exit_code }) => ({ run, path, status, exit_code })),
    [
      { run: 1, path: ".", status: "completed", exit_code: 0 },
      { run: 2, path: "./packages/api", status: "completed", exit_code: 0 },
      { run: 3, path: "../../shared", status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, /\[run 1 path="\." exit=0\]/)
  assert.match(batch.output, /\[run 2 path="\.\/packages\/api" exit=0\]/)
  assert.match(batch.output, /\[run 3 path="\.\.\/\.\.\/shared" exit=0\]/)
  assert.match(batch.output, new RegExp(`root:${escapeRegExp(repoDirectory)}:present`))
  assert.match(batch.output, /api:.*\/packages\/api:present/)
  assert.match(batch.output, /shared:.*\/shared:present/)

  const after = await runToCompletion(shell, "parallel-root-retained", `printf '%s' "$PWD"`)
  assert.equal(after.output, repoDirectory)
})

test("runs at most four parallel children and queues the rest", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-limit-")
  const releaseFile = join(directory, "release")
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  const command = Array.from({ length: 6 }, (_, index) => ["*** Run: .", `while [[ ! -e ${quote(releaseFile)} ]]; do sleep 0.01; done; printf ${index + 1}`])
    .flat()
    .join("\n")
  const first = await shell.runCommand({ requestId: "parallel-limit", command, waitMs: 50 })

  assert.equal(first.status, "running")
  assert.equal(first.commands?.filter((run) => run.status === "running").length, 4)
  assert.equal(first.commands?.filter((run) => run.status === "queued").length, 2)

  await writeFile(releaseFile, "go")
  const completed = await pollToCompletion(shell, first)
  assert.equal(completed.snapshot.status, "completed")
  assert.deepEqual(
    completed.snapshot.commands?.map((run) => run.exit_code),
    [0, 0, 0, 0, 0, 0]
  )
})

test("keeps parallel siblings running when one command exits nonzero", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-nonzero", ["*** Run: .", "false", "*** Run: ./", "printf survived"].join("\n"))

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 1)
  assert.deepEqual(
    batch.snapshot.commands?.map(({ status, exit_code }) => ({ status, exit_code })),
    [
      { status: "completed", exit_code: 1 },
      { status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, /survived/)
})

test("times out a hung parallel child without blocking its siblings", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({
    parallelScheduler: new ParallelCommandScheduler(4),
    parallelCommandTimeoutMs: 100,
  })
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-timeout", ["*** Run: .", "sleep 5", "*** Run: ./", "printf fast"].join("\n"))

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 1)
  assert.deepEqual(
    batch.snapshot.commands?.map(({ status, exit_code }) => ({ status, exit_code })),
    [
      { status: "timed_out", exit_code: null },
      { status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, /\[run 1 path="\." status=timed_out\]/)
  assert.match(batch.output, /\[run 2 path="\.\/" exit=0\]\nfast/)
  assert.match(batch.output, /fast/)
})

test("labels permanently dropped parallel output", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({
    parallelScheduler: new ParallelCommandScheduler(4),
    commandTranscriptBytes: 7,
    defaultOutputTokens: 64,
    maxOutputTokens: 64,
  })
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-output-cap", ["*** Run: .", "printf '🙂éAB'"].join("\n"))

  assert.equal(batch.snapshot.dropped_output_bytes, 1)
  assert.match(batch.output, /\[run 1 path="\." exit=0 dropped_bytes=1\]\n🙂éA/)
})

test("requires a run directory and accepts absolute paths", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  const absolute = await runToCompletion(shell, "parallel-absolute", ["*** Run: /tmp", `printf '%s' "$PWD"`].join("\n"))
  assert.match(absolute.output, new RegExp(`${escapeRegExp(await realpath("/tmp"))}\\n$`))
  assert.equal(absolute.snapshot.commands?.[0]?.path, "/tmp")

  await assert.rejects(
    shell.runCommand({
      requestId: "parallel-missing-directory",
      command: "*** Run",
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /directory-or-relative-path/.test(error.message)
  )
  await assert.rejects(
    shell.runCommand({
      requestId: "parallel-empty-directory",
      command: ["*** Run: ", "printf should-not-run"].join("\n"),
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /path cannot be empty/.test(error.message)
  )
  await assert.rejects(
    shell.runCommand({
      requestId: "parallel-malformed-later-directory",
      command: ["*** Run: .", "printf first", "*** Run:./wiki", "printf should-not-run"].join("\n"),
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /directory-or-relative-path/.test(error.message)
  )
  await assert.rejects(
    shell.runCommand({
      requestId: "parallel-empty-later-directory",
      command: ["*** Run: .", "printf first", "*** Run:", "printf should-not-run"].join("\n"),
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /directory-or-relative-path/.test(error.message)
  )
})

test("accepts leading whitespace before a parallel batch", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  const batch = await runToCompletion(shell, "parallel-leading-whitespace", ["", "  *** Run: .", "printf first", "*** Run: ./", "printf second"].join("\n"))

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, 0)
  assert.deepEqual(
    batch.snapshot.commands?.map((run) => run.exit_code),
    [0, 0]
  )
  assert.match(batch.output, /first/)
  assert.match(batch.output, /second/)
})

test("reset kills running parallel children and retains the batch as reset", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-reset-")
  const pidFile = join(directory, "pid")
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  const running = await shell.runCommand({
    requestId: "parallel-reset",
    cwd: directory,
    command: ["*** Run: .", `printf '%s' "$$" > ${quote(pidFile)}; while :; do sleep 1; done`].join("\n"),
    waitMs: 25,
  })
  assert.equal(running.status, "running")
  const pid = await readPid(pidFile)
  assert.equal(isProcessAlive(pid), true)

  await shell.reset({ requestId: "reset-parallel", reason: "test parallel reset" })
  const old = await shell.pollCommand({ requestId: "parallel-reset", cursor: running.next_cursor, waitMs: 0 })
  assert.equal(old.status, "reset")
  assert.equal(old.commands?.[0]?.status, "reset")
  assert.match(old.output, /\[run 1 path="\." status=reset\]/)
  assert.equal(await waitForProcessExit(pid), true)
})

test("does not let background descendants escape a completed parallel run", { timeout: 10_000 }, async (t) => {
  const directory = await tempDir(t, "shell-mcp-parallel-background-")
  const pidFile = join(directory, "pid")
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  const batch = await runToCompletion(
    shell,
    "parallel-background",
    ["*** Run: .", `(trap '' TERM; while :; do sleep 1; done) & printf '%s' "$!" > ${quote(pidFile)}`].join("\n"),
    { cwd: directory }
  )
  assert.equal(batch.snapshot.commands?.[0]?.status, "completed")

  const pid = await readPid(pidFile)
  assert.equal(await waitForProcessExit(pid), true)
})

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10)
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`PID file was not created: ${path}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
