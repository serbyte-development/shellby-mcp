import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ParallelCommandScheduler } from "../src/tools/shell/parallel-runner.js"
import { PersistentShellSession, ShellSessionError, type ShellSnapshot } from "../src/tools/shell/session.js"

test("retains cwd and environment across commands", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-state-"))
  const shell = new PersistentShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const first = await runToCompletion(shell, "state-1", `cd ${quote(directory)}; export MCP_RETAINED=present`)
  assert.equal(first.snapshot.exit_code, 0)

  const second = await runToCompletion(shell, "state-2", `printf '%s|%s' "$PWD" "$MCP_RETAINED"`)
  assert.equal(second.output, `${directory}|present`)
  assert.equal(second.snapshot.exit_code, 0)
})

test("starts in an explicit cwd, reports it, and retains it", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-explicit-cwd-"))
  const shell = new PersistentShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const first = await runToCompletion(shell, "explicit-cwd", "printf '%s' \"$PWD\"", {
    cwd: directory,
  })
  assert.equal(first.output, directory)
  assert.equal(first.snapshot.cwd, directory)

  const second = await runToCompletion(shell, "retained-explicit-cwd", "printf '%s' \"$PWD\"")
  assert.equal(second.output, directory)
  assert.equal(second.snapshot.cwd, directory)
})

test("rejects invalid explicit working directories", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-invalid-cwd-"))
  const file = join(directory, "file.txt")
  await writeFile(file, "not a directory")
  const shell = new PersistentShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    shell.runCommand({
      requestId: "relative-cwd",
      command: "printf blocked",
      cwd: "relative/path",
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /absolute path/.test(error.message)
  )

  await assert.rejects(
    shell.runCommand({
      requestId: "file-cwd",
      command: "printf blocked",
      cwd: file,
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /not a directory/.test(error.message)
  )
})

test("isolates protocol stdin and restores redirected descriptors", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-fds-"))
  const redirected = join(directory, "redirected.txt")
  const shell = new PersistentShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const catResult = await runToCompletion(shell, "stdin", "cat; printf protocol-safe")
  assert.equal(catResult.output, "protocol-safe")

  const redirectResult = await runToCompletion(shell, "redirect", `exec >${quote(redirected)}; printf hidden`)
  assert.equal(redirectResult.output, "")
  assert.equal(await readFile(redirected, "utf8"), "hidden")

  const after = await runToCompletion(shell, "after-redirect", "printf visible")
  assert.equal(after.output, "visible")
})

test("deduplicates retries and rejects request id conflicts", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-dedupe-"))
  const outputFile = join(directory, "count.txt")
  const shell = new PersistentShellSession()
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const command = `printf x >> ${quote(outputFile)}`
  await runToCompletion(shell, "dedupe", command)
  await runToCompletion(shell, "dedupe", command)
  assert.equal(await readFile(outputFile, "utf8"), "x")

  await assert.rejects(
    shell.runCommand({
      requestId: "dedupe",
      command: "printf different",
      waitMs: 0,
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "request_conflict"
  )
})

test("does not leak errexit into later commands", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  await runToCompletion(shell, "enable-errexit", "set -e")
  const after = await runToCompletion(shell, "after-errexit", "false; printf survived")

  assert.equal(after.output, "survived")
  assert.equal(after.snapshot.exit_code, 0)
})

test("keeps a completed retry bounded after later commands", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const first = await runToCompletion(shell, "bounded-retry", "printf first")
  await runToCompletion(shell, "later-command", "printf later")

  const retry = await shell.runCommand({
    requestId: "bounded-retry",
    command: "printf first",
    waitMs: 0,
  })
  assert.equal(retry.output, "first")
  assert.equal(retry.next_cursor, first.snapshot.next_cursor)
  assert.equal(retry.output_truncated, false)
})

test("admits only one concurrent command without corrupting the active record", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const commands = new Map([
    ["concurrent-a", "sleep 0.1; printf A"],
    ["concurrent-b", "sleep 0.1; printf B"],
  ])
  const attempts = await Promise.allSettled([...commands].map(([requestId, command]) => shell.runCommand({ requestId, command, waitMs: 0 })))
  const admitted = attempts.filter((result): result is PromiseFulfilledResult<ShellSnapshot> => result.status === "fulfilled")
  const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected")

  assert.equal(admitted.length, 1)
  assert.equal(rejected.length, 1)
  const admittedAttempt = admitted[0]
  const rejectedAttempt = rejected[0]
  assert.ok(admittedAttempt)
  assert.ok(rejectedAttempt)
  assert.ok(rejectedAttempt.reason instanceof ShellSessionError && rejectedAttempt.reason.code === "busy")

  const completed = await pollToCompletion(shell, admittedAttempt.value)
  const expectedOutput = admittedAttempt.value.request_id === "concurrent-a" ? "A" : "B"
  assert.equal(completed.output, expectedOutput)
  assert.equal(completed.snapshot.status, "completed")

  const next = await runToCompletion(shell, "after-concurrent", "printf clean")
  assert.equal(next.output, "clean")
})

test("polls bounded output without duplicates", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({
    defaultOutputBytes: 7,
    maxOutputBytes: 7,
  })
  t.after(() => shell.close())

  const result = await runToCompletion(shell, "chunks", "printf abcdefghijklmnopqrstuvwxyz")
  assert.equal(result.output, "abcdefghijklmnopqrstuvwxyz")
  assert.equal(result.snapshot.status, "completed")
  assert.equal(result.snapshot.exit_code, 0)
})

test("caps UTF-8 bytes without splitting characters and allows an override", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({
    defaultOutputBytes: 4,
    maxOutputBytes: 16,
  })
  t.after(() => shell.close())

  const first = await shell.runCommand({
    requestId: "utf8-byte-cap",
    command: "printf '🙂éA'",
    waitMs: 1_000,
  })
  assert.equal(first.output, "🙂")
  assert.equal(Buffer.byteLength(first.output, "utf8"), 4)
  assert.equal(first.output_truncated, true)

  const rest = await shell.pollCommand({
    requestId: "utf8-byte-cap",
    cursor: first.next_cursor,
    waitMs: 0,
    maxOutputBytes: 16,
  })
  assert.equal(rest.output, "éA")
  assert.equal(Buffer.byteLength(rest.output, "utf8"), 3)
  assert.equal(rest.output_truncated, false)
})

test("drops output beyond the per-command transcript ceiling", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({
    commandTranscriptBytes: 7,
    defaultOutputBytes: 16,
    maxOutputBytes: 16,
  })
  t.after(() => shell.close())

  const result = await runToCompletion(shell, "command-transcript-cap", "printf '🙂éAB'")
  assert.equal(result.output, "🙂éA")
  assert.equal(result.snapshot.output_dropped, true)
  assert.equal(result.snapshot.dropped_output_bytes, 1)

  const after = await runToCompletion(shell, "after-command-transcript-cap", "printf healthy")
  assert.equal(after.output, "healthy")
  assert.equal(after.snapshot.output_dropped, false)
  assert.equal(after.snapshot.dropped_output_bytes, 0)
})

test("keeps surrogate pairs intact while scanning for a delayed marker", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({
    commandTranscriptBytes: 4,
    defaultOutputBytes: 16,
    maxOutputBytes: 16,
  })
  t.after(() => shell.close())

  const result = await runToCompletion(shell, "surrogate-marker-boundary", `printf '${"🙂"}${"a".repeat(45)}'; sleep 0.1`)

  assert.equal(result.output, "🙂")
  assert.equal(result.snapshot.output_dropped, true)
  assert.equal(result.snapshot.dropped_output_bytes, 45)
})

test("drops a whole surrogate pair at the rolling transcript boundary", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({
    transcriptLimit: 1,
    defaultOutputBytes: 16,
    maxOutputBytes: 16,
  })
  t.after(() => shell.close())

  const evicted = await runToCompletion(shell, "surrogate-transcript-boundary", "printf '🙂'")
  assert.equal(evicted.output, "")
  assert.equal(evicted.snapshot.cursor_expired, true)

  const after = await runToCompletion(shell, "after-surrogate-transcript-boundary", "printf A")
  assert.equal(after.output, "A")
})

test("contains readonly wrapper variables to one command", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const poisoned = await runToCompletion(shell, "readonly-wrapper-variable", "readonly __mcp_command; printf contained")
  assert.equal(poisoned.output, "contained")
  assert.equal(poisoned.snapshot.status, "completed")

  const after = await runToCompletion(shell, "after-readonly-wrapper-variable", "printf healthy")
  assert.equal(after.output, "healthy")
})

test("waits for a quick command to complete instead of returning on its first output", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const result = await shell.runCommand({
    requestId: "wait-for-completion",
    command: "printf first; sleep 0.05; printf second",
    waitMs: 1_000,
  })

  assert.equal(result.status, "completed")
  assert.equal(result.output, "firstsecond")
  assert.equal(result.exit_code, 0)
})

test("keeps completed command polling bounded after later commands", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const first = await runToCompletion(shell, "poll-boundary-first", "printf first")
  await runToCompletion(shell, "poll-boundary-second", "printf second")

  const stalePoll = await shell.pollCommand({
    requestId: "poll-boundary-first",
    cursor: first.snapshot.next_cursor,
    waitMs: 0,
  })

  assert.equal(stalePoll.output, "")
  assert.equal(stalePoll.output_truncated, false)
})

test("rejects poll cursors before the requested command", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  await runToCompletion(shell, "poll-before-first", "printf first-secret")
  await runToCompletion(shell, "poll-before-second", "printf second")

  await assert.rejects(
    shell.pollCommand({
      requestId: "poll-before-second",
      cursor: 0,
      waitMs: 0,
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_cursor"
  )
})

test("wakes a foreground long-poll when delayed output arrives", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const running = await shell.runCommand({
    requestId: "delayed-foreground",
    command: "sleep 0.1; printf awakened",
    waitMs: 0,
  })
  assert.equal(running.status, "running")

  const startedAt = Date.now()
  const awakened = await shell.pollCommand({
    requestId: "delayed-foreground",
    cursor: running.next_cursor,
    waitMs: 3_000,
  })
  assert.ok(Date.now() - startedAt < 1_500, "poll should wake before its timeout")

  const completed = await pollToCompletion(shell, awakened)
  assert.equal(completed.output, "awakened")
  assert.equal(completed.snapshot.status, "completed")
})

test("handles multiline commands, quotes, and redirected background output", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const quoted = await runToCompletion(shell, "quoted", ["value=$(cat <<'VALUE_EOF'", "a'b", "VALUE_EOF", ")", `printf '%s' "$value"`].join("\n"))
  assert.equal(quoted.output, "a'b")

  const backgroundFile = `/tmp/chatgpt-shell-background-${process.pid}`
  const background = await shell.runCommand({
    requestId: "background",
    command: `(sleep 0.1; printf background-finished > ${quote(backgroundFile)}) &`,
    waitMs: 500,
  })
  assert.equal(background.status, "completed")
  const readBackground = await runToCompletion(
    shell,
    "background-output",
    `sleep 0.2; value=$(<${quote(backgroundFile)}); rm ${quote(backgroundFile)}; printf '%s' "$value"`
  )
  assert.equal(readBackground.output, "background-finished")
})

test("reports shell loss and automatically starts a clean generation", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  await runToCompletion(shell, "before-exit", "printf initial")
  const exited = await runUntilTerminal(shell, "exit-shell", "exit 7")
  assert.equal(exited.snapshot.status, "shell_exited")

  const recovered = await runToCompletion(shell, "after-exit", "printf recovered")
  assert.equal(recovered.output, "recovered")
  assert.equal(recovered.snapshot.status, "completed")
})

test("recovers when process-group cleanup is denied", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const originalKill = process.kill
  let injected = false
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (!injected && pid < 0 && signal === "SIGKILL") {
      injected = true
      const error = new Error("kill EPERM") as NodeJS.ErrnoException
      error.code = "EPERM"
      throw error
    }
    return originalKill(pid, signal)
  }) as typeof process.kill

  let exited: Awaited<ReturnType<typeof runUntilTerminal>>
  try {
    exited = await runUntilTerminal(shell, "eperm-exit", "exit 7")
  } finally {
    process.kill = originalKill
  }

  assert.equal(injected, true)
  assert.equal(exited.snapshot.status, "shell_exited")
  const recovered = await runToCompletion(shell, "after-eperm", "printf recovered")
  assert.equal(recovered.output, "recovered")
})

test("reset cancels a stuck command and creates a clean shell", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession()
  t.after(() => shell.close())

  const running = await shell.runCommand({
    requestId: "stuck",
    command: "export SHOULD_DISAPPEAR=yes; sleep 30",
    waitMs: 25,
  })
  assert.equal(running.status, "running")

  const reset = await shell.reset({
    requestId: "reset-stuck",
    reason: "test reset",
  })
  assert.equal(reset.status, "ready")

  const retriedReset = await shell.reset({
    requestId: "reset-stuck",
    reason: "test reset",
  })
  assert.deepEqual(retriedReset, reset)

  await assert.rejects(
    shell.reset({ requestId: "reset-stuck", reason: "different reset" }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "request_conflict"
  )

  const old = await shell.pollCommand({
    requestId: "stuck",
    cursor: running.next_cursor,
    waitMs: 0,
  })
  assert.equal(old.status, "reset")

  const recovered = await runToCompletion(shell, "after-reset", "printf '%s' \"${SHOULD_DISAPPEAR-unset}\"")
  assert.equal(recovered.output, "unset")
})

test("reset kills a TERM-resistant background descendant", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("process-group signaling is POSIX-specific")
    return
  }

  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-resistant-"))
  const readyFile = join(directory, "ready")
  const shell = new PersistentShellSession()
  let descendantPid: number | undefined
  // eslint-disable-next-line prefer-const -- assigned after cleanup registration so early failures can still clean up the old process group.
  let oldProcessGroup: number | undefined
  t.after(async () => {
    await shell.close()
    if (oldProcessGroup && isProcessAlive(-oldProcessGroup)) {
      try {
        process.kill(-oldProcessGroup, "SIGKILL")
      } catch (error) {
        if (!isMissingProcess(error)) throw error
      }
    }
    await rm(directory, { recursive: true, force: true })
  })

  const started = await runToCompletion(
    shell,
    "resistant-background",
    [
      `(trap '' TERM; printf ready > ${quote(readyFile)}; while :; do sleep 1; done) &`,
      "descendant=$!",
      `while [[ ! -s ${quote(readyFile)} ]]; do sleep 0.01; done`,
      `printf '%s|%s' "$descendant" "$$"`,
    ].join("; ")
  )
  // eslint-disable-next-line prefer-const -- destructured assignment happens after cleanup registration.
  ;[descendantPid, oldProcessGroup] = started.output.split("|").map((value) => Number.parseInt(value, 10))
  assert.ok(descendantPid !== undefined && Number.isSafeInteger(descendantPid))
  assert.ok(oldProcessGroup !== undefined && Number.isSafeInteger(oldProcessGroup))
  assert.equal(isProcessAlive(descendantPid), true)
  assert.equal(isProcessAlive(-oldProcessGroup), true)

  await shell.reset({
    requestId: "reset-resistant-background",
    reason: "kill resistant descendant",
  })

  assert.equal(await waitForProcessExit(descendantPid), true)
  assert.equal(await waitForProcessExit(-oldProcessGroup), true)
})

test("runs parallel command batches from one root with relative paths and retained exported environment", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-parallel-root-"))
  const apiDirectory = join(directory, "packages", "api")
  await mkdir(apiDirectory, { recursive: true })
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  await runToCompletion(shell, "parallel-env", "export MCP_PARALLEL_RETAINED=present")
  const batch = await runToCompletion(
    shell,
    "parallel-root",
    [
      "*** Begin Commands",
      "*** Run",
      `printf 'root:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"`,
      "*** Run: packages/api",
      `printf 'api:%s:%s' "$PWD" "$MCP_PARALLEL_RETAINED"`,
      "*** End Commands",
    ].join("\n"),
    { cwd: directory }
  )

  assert.equal(batch.snapshot.status, "completed")
  assert.equal(batch.snapshot.exit_code, null)
  assert.deepEqual(
    batch.snapshot.commands?.map(({ run, path, status, exit_code }) => ({ run, path, status, exit_code })),
    [
      { run: 1, path: undefined, status: "completed", exit_code: 0 },
      { run: 2, path: "packages/api", status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, new RegExp(`root:${escapeRegExp(directory)}:present`))
  assert.match(batch.output, /api:.*\/packages\/api:present/)

  const after = await runToCompletion(shell, "parallel-root-retained", `printf '%s' "$PWD"`)
  assert.equal(after.output, directory)
})

test("runs at most four parallel children and queues the rest", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  const command = [
    "*** Begin Commands",
    ...Array.from({ length: 6 }, (_, index) => ["*** Run", `sleep 0.35; printf ${index + 1}`]).flat(),
    "*** End Commands",
  ].join("\n")
  const first = await shell.runCommand({ requestId: "parallel-limit", command, waitMs: 50 })

  assert.equal(first.status, "running")
  assert.equal(first.commands?.filter((run) => run.status === "running").length, 4)
  assert.equal(first.commands?.filter((run) => run.status === "queued").length, 2)

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

  const batch = await runToCompletion(
    shell,
    "parallel-nonzero",
    ["*** Begin Commands", "*** Run", "false", "*** Run", "sleep 0.05; printf survived", "*** End Commands"].join("\n")
  )

  assert.equal(batch.snapshot.status, "completed")
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

  const batch = await runToCompletion(
    shell,
    "parallel-timeout",
    ["*** Begin Commands", "*** Run", "sleep 5", "*** Run", "printf fast", "*** End Commands"].join("\n")
  )

  assert.equal(batch.snapshot.status, "completed")
  assert.deepEqual(
    batch.snapshot.commands?.map(({ status, exit_code }) => ({ status, exit_code })),
    [
      { status: "timed_out", exit_code: null },
      { status: "completed", exit_code: 0 },
    ]
  )
  assert.match(batch.output, /fast/)
})

test("rejects malformed parallel envelopes and absolute run paths", { timeout: 10_000 }, async (t) => {
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(() => shell.close())

  await assert.rejects(
    shell.runCommand({
      requestId: "parallel-absolute",
      command: ["*** Begin Commands", "*** Run: /tmp", "pwd", "*** End Commands"].join("\n"),
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /relative to cwd/.test(error.message)
  )
  await assert.rejects(
    shell.runCommand({
      requestId: "parallel-missing-end",
      command: ["*** Begin Commands", "*** Run", "pwd"].join("\n"),
    }),
    (error: unknown) => error instanceof ShellSessionError && error.code === "invalid_command" && /End Commands/.test(error.message)
  )
})

test("reset kills running parallel children and retains the batch as reset", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-parallel-reset-"))
  const lateFile = join(directory, "late.txt")
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const running = await shell.runCommand({
    requestId: "parallel-reset",
    cwd: directory,
    command: ["*** Begin Commands", "*** Run", `sleep 0.5; printf late > ${quote(lateFile)}`, "*** End Commands"].join("\n"),
    waitMs: 25,
  })
  assert.equal(running.status, "running")

  await shell.reset({ requestId: "reset-parallel", reason: "test parallel reset" })
  const old = await shell.pollCommand({ requestId: "parallel-reset", cursor: running.next_cursor, waitMs: 0 })
  assert.equal(old.status, "reset")
  assert.equal(old.commands?.[0]?.status, "reset")

  await new Promise((resolve) => setTimeout(resolve, 650))
  await assert.rejects(readFile(lateFile, "utf8"), (error: unknown) => isMissingProcessOrFile(error))
})

test("does not let background descendants escape a completed parallel run", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shell-mcp-parallel-background-"))
  const lateFile = join(directory, "late.txt")
  const shell = new PersistentShellSession({ parallelScheduler: new ParallelCommandScheduler(4) })
  t.after(async () => {
    await shell.close()
    await rm(directory, { recursive: true, force: true })
  })

  const batch = await runToCompletion(
    shell,
    "parallel-background",
    ["*** Begin Commands", "*** Run", `(sleep 0.2; printf leaked > ${quote(lateFile)}) &`, "*** End Commands"].join("\n"),
    { cwd: directory }
  )
  assert.equal(batch.snapshot.commands?.[0]?.status, "completed")

  await new Promise((resolve) => setTimeout(resolve, 350))
  await assert.rejects(readFile(lateFile, "utf8"), (error: unknown) => isMissingProcessOrFile(error))
})

async function runToCompletion(
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

async function pollToCompletion(shell: PersistentShellSession, first: ShellSnapshot): Promise<{ output: string; snapshot: ShellSnapshot }> {
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

async function runUntilTerminal(shell: PersistentShellSession, requestId: string, command: string): Promise<{ output: string; snapshot: ShellSnapshot }> {
  const result = await runToCompletion(shell, requestId, command)
  return result
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isMissingProcessOrFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isMissingProcess(error)) return false
    throw error
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
}
