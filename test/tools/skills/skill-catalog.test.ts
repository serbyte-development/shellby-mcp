import assert from "node:assert/strict"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import {
  MAX_SKILL_BYTES,
  SkillCatalog,
  SkillCatalogError,
} from "../../../src/tools/skills/skill-catalog.js"
import { tempDir } from "../../helpers/temp.js"

test("lists workspace skills from frontmatter and loads the complete SKILL.md", async (t) => {
  const workspace = await tempDir(t, "mcp-skills-")
  const skillDirectory = join(workspace, "skills", "create-wiki")
  await mkdir(skillDirectory, { recursive: true })
  const content = [
    "---",
    "name: create-wiki",
    "description: Build and maintain a project wiki.",
    "---",
    "",
    "# Create Wiki",
    "",
    "Complete instructions.",
  ].join("\n")
  await writeFile(join(skillDirectory, "SKILL.md"), content)

  const catalog = new SkillCatalog(join(workspace, "skills"))

  assert.deepEqual(await catalog.list(), [
    {
      name: "create-wiki",
      description: "Build and maintain a project wiki.",
    },
  ])
  assert.deepEqual(await catalog.read("create-wiki"), {
    name: "create-wiki",
    path: join(skillDirectory, "SKILL.md"),
    content,
  })
})

test("lists and loads workspace-local skills with a leading underscore", async (t) => {
  const workspace = await tempDir(t, "mcp-skills-local-")
  const skillDirectory = join(workspace, "skills", "_web-search")
  await mkdir(skillDirectory, { recursive: true })
  const content =
    "---\nname: _web-search\ndescription: Local web search workflow.\n---\n\n# Web Search\n"
  await writeFile(join(skillDirectory, "SKILL.md"), content)

  const catalog = new SkillCatalog(join(workspace, "skills"))

  assert.deepEqual(await catalog.list(), [
    { name: "_web-search", description: "Local web search workflow." },
  ])
  assert.deepEqual(await catalog.read("_web-search"), {
    name: "_web-search",
    path: join(skillDirectory, "SKILL.md"),
    content,
  })
})

test("returns an empty catalog when the workspace has no skills directory", async (t) => {
  const workspace = await tempDir(t, "mcp-skills-empty-")

  const catalog = new SkillCatalog(join(workspace, "skills"))
  assert.deepEqual(await catalog.list(), [])
})

test("parses YAML descriptions and keeps malformed metadata discoverable", async (t) => {
  const workspace = await tempDir(t, "mcp-skills-yaml-")
  const cases = [
    {
      name: "folded",
      yaml: "description: >\n  Multi-line\n  description.",
      description: "Multi-line description.",
    },
    {
      name: "literal",
      yaml: "description: |\n  First line.\n  Second line.",
      description: "First line.\nSecond line.",
    },
    { name: "quoted", yaml: "description: 'It''s readable.'", description: "It's readable." },
    { name: "comment", yaml: "description: Simple. # metadata", description: "Simple." },
    { name: "numeric", yaml: "description: 42", description: undefined },
    { name: "malformed", yaml: 'description: "unterminated', description: undefined },
    { name: "sequence", yaml: "- description", description: undefined },
  ]
  for (const item of cases) {
    const directory = join(workspace, item.name)
    await mkdir(directory)
    await writeFile(join(directory, "SKILL.md"), `---\n${item.yaml}\n---\n# Instructions\n`)
  }
  const catalog = new SkillCatalog(workspace)
  const summaries = await catalog.list()
  assert.equal(summaries.length, cases.length)
  for (const item of cases) {
    assert.equal(
      summaries.find((summary) => summary.name === item.name)?.description,
      item.description
    )
    assert.match((await catalog.read(item.name)).content, /# Instructions/u)
  }
})

test("rejects unknown skill names", async (t) => {
  const workspace = await tempDir(t, "mcp-skills-errors-")
  const catalog = new SkillCatalog(join(workspace, "skills"))

  await assert.rejects(
    catalog.read("missing"),
    (error: unknown) => error instanceof SkillCatalogError && error.code === "unknown_skill"
  )
})

test("validates skill names at the catalog boundary", async (t) => {
  const workspace = await tempDir(t, "mcp-skills-invalid-name-")
  const catalog = new SkillCatalog(join(workspace, "skills"))

  await assert.rejects(
    catalog.read("../outside"),
    (error: unknown) => error instanceof SkillCatalogError && error.code === "unknown_skill"
  )
})

test("bounds SKILL.md size", async (t) => {
  const workspace = await tempDir(t, "mcp-skills-large-")
  const skillDirectory = join(workspace, "skills", "large-skill")
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, "SKILL.md"), "x".repeat(MAX_SKILL_BYTES + 1))

  const catalog = new SkillCatalog(join(workspace, "skills"))
  await assert.rejects(
    catalog.read("large-skill"),
    (error: unknown) => error instanceof SkillCatalogError && error.code === "skill_too_large"
  )
})

test("supports a skill directory symlink for future shared catalogs", {
  skip: process.platform === "win32",
}, async (t) => {
  const workspace = await tempDir(t, "mcp-skills-link-")
  const source = await tempDir(t, "mcp-skill-source-")
  await mkdir(join(workspace, "skills"), { recursive: true })
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: linked\ndescription: Linked skill.\n---\n\n# Linked\n"
  )
  await symlink(source, join(workspace, "skills", "linked"), "dir")

  const catalog = new SkillCatalog(join(workspace, "skills"))
  assert.equal((await catalog.list())[0]?.name, "linked")
  assert.match((await catalog.read("linked")).content, /# Linked/u)
})
