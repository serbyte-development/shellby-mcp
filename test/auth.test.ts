import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import { ShellyAuthError, ShellyAuthStore } from "../src/auth/auth.js"

test("creates durable auth state with owner-only permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shelly-auth-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, ".shelly", "auth.json")
  const auth = new ShellyAuthStore(filePath)

  const first = await auth.ensureState()
  const second = await new ShellyAuthStore(filePath).ensureState()

  assert.deepEqual(first, { version: 1, subject: null })
  assert.deepEqual(second, first)
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), first)

  if (process.platform !== "win32") {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(filePath))).mode & 0o777, 0o700)
  }
})

test("first tool call binds one subject and later calls require it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shelly-auth-bind-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const auth = new ShellyAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  assert.equal((await auth.authorizeToolCall("subject-a")).subject, "subject-a")
  assert.equal((await auth.authorizeToolCall("subject-a")).subject, "subject-a")
  await assert.rejects(
    () => auth.authorizeToolCall("subject-b"),
    (error: unknown) => error instanceof ShellyAuthError && error.code === "subject_mismatch"
  )
})

test("concurrent first tool calls bind exactly one subject", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shelly-auth-race-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const auth = new ShellyAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  const results = await Promise.allSettled([auth.authorizeToolCall("subject-a"), auth.authorizeToolCall("subject-b")])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
})

test("reset clears the bound subject", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shelly-auth-reset-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const auth = new ShellyAuthStore(join(root, "auth.json"))
  await auth.ensureState()
  await auth.authorizeToolCall("subject-a")

  assert.deepEqual(await auth.reset(), { version: 1, subject: null })
})

test("malformed auth state fails closed instead of being replaced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shelly-auth-invalid-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, "auth.json")
  await writeFile(filePath, "not-json\n", { mode: 0o600 })
  const auth = new ShellyAuthStore(filePath)

  await assert.rejects(
    () => auth.ensureState(),
    (error: unknown) => error instanceof ShellyAuthError && error.code === "state_invalid"
  )
  assert.equal(await readFile(filePath, "utf8"), "not-json\n")
})
