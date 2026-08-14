import assert from "node:assert/strict"
import { readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"

import { UnhingedAgentAuthError, UnhingedAgentAuthStore } from "../src/auth/auth.js"
import { tempDir } from "./helpers/temp.js"

test("creates durable auth state with owner-only permissions", async (t) => {
  const root = await tempDir(t, "unhinged-agent-auth-")
  const filePath = join(root, ".unhinged-agent", "auth.json")
  const auth = new UnhingedAgentAuthStore(filePath)

  const first = await auth.ensureState()
  const second = await new UnhingedAgentAuthStore(filePath).ensureState()

  assert.deepEqual(first, { version: 1, subject: null })
  assert.deepEqual(second, first)
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), first)

  if (process.platform !== "win32") {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(filePath))).mode & 0o777, 0o700)
  }
})

test("first tool call binds one subject and later calls require it", async (t) => {
  const root = await tempDir(t, "unhinged-agent-auth-bind-")
  const auth = new UnhingedAgentAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  assert.equal((await auth.authorizeToolCall("subject-a")).subject, "subject-a")
  assert.equal((await auth.authorizeToolCall("subject-a")).subject, "subject-a")
  await assert.rejects(
    () => auth.authorizeToolCall("subject-b"),
    (error: unknown) => error instanceof UnhingedAgentAuthError && error.code === "subject_mismatch"
  )
})

test("concurrent first tool calls bind exactly one subject", async (t) => {
  const root = await tempDir(t, "unhinged-agent-auth-race-")
  const auth = new UnhingedAgentAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  const results = await Promise.allSettled([auth.authorizeToolCall("subject-a"), auth.authorizeToolCall("subject-b")])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
})

test("reset clears the bound subject", async (t) => {
  const root = await tempDir(t, "unhinged-agent-auth-reset-")
  const auth = new UnhingedAgentAuthStore(join(root, "auth.json"))
  await auth.ensureState()
  await auth.authorizeToolCall("subject-a")

  assert.deepEqual(await auth.reset(), { version: 1, subject: null })
})

test("malformed auth state fails closed instead of being replaced", async (t) => {
  const root = await tempDir(t, "unhinged-agent-auth-invalid-")
  const filePath = join(root, "auth.json")
  await writeFile(filePath, "not-json\n", { mode: 0o600 })
  const auth = new UnhingedAgentAuthStore(filePath)

  await assert.rejects(
    () => auth.ensureState(),
    (error: unknown) => error instanceof UnhingedAgentAuthError && error.code === "state_invalid"
  )
  assert.equal(await readFile(filePath, "utf8"), "not-json\n")
})
