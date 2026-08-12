import assert from "node:assert/strict"
import test from "node:test"

import { PersistentShellSession } from "../src/tools/shell/session.js"
import { DEFAULT_SHELL_ID, ShellSessionManager } from "../src/tools/shell/session-manager.js"

test("creates named shells lazily and keeps their state isolated", async (t) => {
  const manager = new ShellSessionManager()
  t.after(() => manager.close())

  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])

  const alpha = manager.getOrCreate("alpha")
  const beta = manager.getOrCreate("beta")
  assert.notEqual(alpha, beta)
  assert.equal(manager.getOrCreate("alpha"), alpha)
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "alpha", "beta"])

  await alpha.runCommand({
    requestId: "state1",
    command: "cd /tmp && export NAMED_SHELL_STATE=alpha",
  })
  const alphaState = await alpha.runCommand({
    requestId: "state2",
    command: `printf '%s|%s' "$PWD" "$NAMED_SHELL_STATE"`,
  })
  const betaState = await beta.runCommand({
    requestId: "state2",
    command: `printf '%s|%s' "$PWD" "\${NAMED_SHELL_STATE-unset}"`,
  })

  assert.equal(alphaState.output, "/tmp|alpha")
  assert.match(betaState.output, /\|unset$/)
})

test("enforces the configured named-shell limit", async (t) => {
  const manager = new ShellSessionManager({ maxShells: 2 })
  t.after(() => manager.close())

  manager.getOrCreate("second")
  assert.throws(
    () => manager.getOrCreate("third"),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("2-shell limit has been reached") &&
      error.message.includes("use shell_list and shell_close to free an unused named shell")
  )
})

test("lists shells without refreshing their idle timers", async (t) => {
  let now = 0
  const manager = new ShellSessionManager({
    idleTimeoutMs: 100,
    now: () => now,
  })
  t.after(() => manager.close())

  manager.getOrCreate("alpha")
  now = 75
  assert.deepEqual(manager.listShells(), [
    {
      shell_id: DEFAULT_SHELL_ID,
      status: "idle",
      is_default: true,
      can_close: false,
      idle_ms: 75,
    },
    {
      shell_id: "alpha",
      status: "idle",
      is_default: false,
      can_close: true,
      idle_ms: 75,
    },
  ])

  now = 100
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])
})

test("closes named shells and immediately releases their slot", async (t) => {
  const manager = new ShellSessionManager({ maxShells: 2 })
  t.after(() => manager.close())

  const alpha = manager.getOrCreate("alpha")
  await manager.closeShell("alpha")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])
  manager.getOrCreate("beta")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "beta"])
  await assert.rejects(
    () => alpha.start(),
    (error: unknown) => error instanceof Error && error.message.includes("closed")
  )
})

test("protects the default shell from close while allowing reset", async (t) => {
  const manager = new ShellSessionManager()
  t.after(() => manager.close())

  await assert.rejects(
    () => manager.closeShell(DEFAULT_SHELL_ID),
    (error: unknown) => error instanceof Error && error.message.includes("cannot be closed") && error.message.includes("shell_reset")
  )

  const reset = await manager.defaultShell.reset({
    requestId: "reset-default",
  })
  assert.equal(reset.status, "ready")
  assert.equal(manager.getOrCreate(DEFAULT_SHELL_ID), manager.defaultShell)
})

test("closing a named shell terminates its active foreground command", async (t) => {
  const manager = new ShellSessionManager()
  t.after(() => manager.close())
  const alpha = manager.getOrCreate("alpha")

  const running = await alpha.runCommand({
    requestId: "long-running",
    command: "sleep 5; printf should-not-complete",
    waitMs: 0,
  })
  assert.equal(running.status, "running")

  await manager.closeShell("alpha")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])
  await assert.rejects(
    () => alpha.start(),
    (error: unknown) => error instanceof Error && error.message.includes("closed")
  )
})

test("evicts idle named shells while keeping the default shell", async (t) => {
  let now = 0
  const manager = new ShellSessionManager({
    idleTimeoutMs: 100,
    now: () => now,
  })
  t.after(() => manager.close())

  const alpha = manager.getOrCreate("alpha")
  now = 99
  assert.deepEqual(await manager.cleanupIdle(), [])
  now = 100
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID])
  manager.getOrCreate("beta")
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "beta"])
  await assert.rejects(
    () => alpha.start(),
    (error: unknown) => error instanceof Error && error.message.includes("closed")
  )
})

test("does not evict a named shell while it has active work", async (t) => {
  let now = 0
  const manager = new ShellSessionManager({
    idleTimeoutMs: 100,
    now: () => now,
  })
  t.after(() => manager.close())

  const alpha = manager.getOrCreate("alpha")
  const running = await alpha.runCommand({
    requestId: "active",
    command: "sleep 0.15; printf done",
    waitMs: 0,
  })
  assert.equal(running.status, "running")

  now = 100
  assert.deepEqual(await manager.cleanupIdle(), [])
  assert.deepEqual(manager.listShellIds(), [DEFAULT_SHELL_ID, "alpha"])

  let snapshot = running
  for (let attempt = 0; attempt < 20 && snapshot.status === "running"; attempt += 1) {
    snapshot = await alpha.pollCommand({
      requestId: "active",
      cursor: snapshot.next_cursor,
      waitMs: 100,
    })
  }
  assert.equal(snapshot.status, "completed")
  now = 201
  assert.deepEqual(await manager.cleanupIdle(), ["alpha"])
})

test("closes every created shell", async () => {
  const created: PersistentShellSession[] = []
  const manager = new ShellSessionManager({
    createShell: () => {
      const shell = new PersistentShellSession()
      created.push(shell)
      return shell
    },
  })
  manager.getOrCreate("alpha")
  manager.getOrCreate("beta")

  await manager.close()

  for (const shell of created) {
    await assert.rejects(
      () => shell.start(),
      (error: unknown) => error instanceof Error && error.message.includes("closed")
    )
  }
})
