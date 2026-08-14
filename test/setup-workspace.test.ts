import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

// @ts-expect-error scripts are plain ESM entrypoints without declaration files.
import { initializeWorkspace } from "../scripts/workspace-setup.mjs"
import { tempDir } from "./helpers/temp.js"

test("workspace setup creates starter AGENTS.md without overwriting existing instructions", async (t) => {
  const workspace = await tempDir(t, "mcp-setup-workspace-")

  assert.equal((await initializeWorkspace(workspace)).created, true)
  const agentsPath = join(workspace, "AGENTS.md")
  assert.match(await readFile(agentsPath, "utf8"), /# Workspace Instructions/)

  await writeFile(agentsPath, "# My Instructions\n", "utf8")
  assert.equal((await initializeWorkspace(workspace)).created, false)
  assert.equal(await readFile(agentsPath, "utf8"), "# My Instructions\n")
})
