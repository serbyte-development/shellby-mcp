import assert from "node:assert/strict"
import { chmod, mkdtemp, readlink, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

import { DEFAULT_CODEX_BINARY, prepareApplyPatch, resolveWorkspacePath } from "../src/workspace-tools.js"

test("resolves configured workspace paths to absolute paths", () => {
  assert.equal(resolveWorkspacePath(), join(homedir(), "Desktop", "chatgpt-workspace"))
  assert.equal(resolveWorkspacePath("~"), homedir())
  assert.equal(resolveWorkspacePath("~/custom-workspace"), join(homedir(), "custom-workspace"))
  assert.equal(resolveWorkspacePath("relative-workspace"), resolve("relative-workspace"))
  assert.equal(resolveWorkspacePath(tmpdir()), tmpdir())
})

test("creates a stable workspace apply_patch symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-apply-patch-"))
  const codexBinary = join(directory, "codex")
  await writeFile(codexBinary, "#!/bin/sh\nexit 0\n")
  await chmod(codexBinary, 0o755)
  t.after(() => rm(directory, { recursive: true, force: true }))

  const setup = await prepareApplyPatch(join(directory, "workspace"), codexBinary)

  assert.equal(setup.available, true)
  assert.equal(await readlink(setup.executable), codexBinary)
})

test("uses the vendored apply_patch executable by default", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-vendored-apply-patch-"))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const setup = await prepareApplyPatch(join(directory, "workspace"))

  assert.equal(setup.available, true)
  assert.equal(await readlink(setup.executable), DEFAULT_CODEX_BINARY)
})

test("replaces a stale workspace apply_patch symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-apply-patch-stale-"))
  const firstBinary = join(directory, "codex-old")
  const secondBinary = join(directory, "codex-new")
  await writeFile(firstBinary, "#!/bin/sh\nexit 0\n")
  await writeFile(secondBinary, "#!/bin/sh\nexit 0\n")
  await chmod(firstBinary, 0o755)
  await chmod(secondBinary, 0o755)
  t.after(() => rm(directory, { recursive: true, force: true }))

  const workspace = join(directory, "workspace")
  const first = await prepareApplyPatch(workspace, firstBinary)
  const second = await prepareApplyPatch(workspace, secondBinary)

  assert.equal(first.available, true)
  assert.equal(second.available, true)
  assert.equal(await readlink(second.executable), secondBinary)
})

test("warns without preventing startup when the Codex binary is absent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-apply-patch-missing-"))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const missingBinary = join(directory, "missing-codex")
  const setup = await prepareApplyPatch(join(directory, "workspace"), missingBinary)

  assert.equal(setup.available, false)
  assert.match(setup.warning ?? "", /Codex binary is not executable/)
})
