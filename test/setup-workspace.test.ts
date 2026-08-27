import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

// @ts-expect-error scripts are plain ESM entrypoints without declaration files.
import { initializeWorkspace } from "../scripts/workspace-setup.mjs"
import { SkillCatalog } from "../src/tools/skills.js"
import { tempDir } from "./helpers/temp.js"

test("workspace setup creates starter instructions and create-skill without overwriting either", async (t) => {
  const workspace = await tempDir(t, "mcp-setup-workspace-")

  const initial = await initializeWorkspace(workspace)
  assert.equal(initial.created, true)
  assert.equal(initial.starterSkillCreated, true)
  const agentsPath = join(workspace, "AGENTS.md")
  assert.match(await readFile(agentsPath, "utf8"), /# Workspace Instructions/)
  const skillPath = join(workspace, "skills", "create-skill", "SKILL.md")
  assert.match(await readFile(skillPath, "utf8"), /name: create-skill/)

  const catalog = new SkillCatalog(join(workspace, "skills"))
  assert.deepEqual(
    (await catalog.list()).map(({ name }) => name),
    ["create-skill"]
  )

  await writeFile(agentsPath, "# My Instructions\n", "utf8")
  await writeFile(skillPath, "---\nname: create-skill\ndescription: My custom skill.\n---\n", "utf8")
  const repeated = await initializeWorkspace(workspace)
  assert.equal(repeated.created, false)
  assert.equal(repeated.starterSkillCreated, false)
  assert.equal(await readFile(agentsPath, "utf8"), "# My Instructions\n")
  assert.match(await readFile(skillPath, "utf8"), /My custom skill/)
})
