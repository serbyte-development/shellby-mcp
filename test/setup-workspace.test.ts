import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("workspace setup creates starter AGENTS.md without overwriting existing instructions", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-setup-workspace-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))

  assert.equal(runWorkspaceSetup(workspace).created, true)
  const agentsPath = join(workspace, "AGENTS.md")
  assert.match(await readFile(agentsPath, "utf8"), /# Workspace Instructions/)

  await writeFile(agentsPath, "# My Instructions\n", "utf8")
  assert.equal(runWorkspaceSetup(workspace).created, false)
  assert.equal(await readFile(agentsPath, "utf8"), "# My Instructions\n")
})

function runWorkspaceSetup(workspace: string): { created: boolean } {
  const helperUrl = pathToFileURL(join(process.cwd(), "scripts", "workspace-setup.mjs")).href
  const script = `import { initializeWorkspace } from ${JSON.stringify(helperUrl)}; console.log(JSON.stringify(await initializeWorkspace(process.argv[1])))`
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, workspace], {
    encoding: "utf8",
  })

  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
