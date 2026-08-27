import { constants } from "node:fs"
import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_WORKSPACE = "~/Desktop/agent-workspace"
const STARTER_SKILL_SOURCE = fileURLToPath(new URL("../skills/create-skill/SKILL.md", import.meta.url))

const STARTER_AGENTS_MD = `# Workspace Instructions

This file contains persistent instructions for coding work in this workspace. Customize it for your preferences.

- Read and follow project-local \`AGENTS.md\` files and relevant project documentation before editing a repository.
- Keep existing projects in their current locations.
- Create or clone new projects in this workspace unless the user asks for another location.
- Prefer more-specific project instructions when they conflict with this file.
`

export function resolveWorkspacePath(configured) {
  if (configured === "~") return homedir()
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2))
  return resolve(configured)
}

export async function initializeWorkspace(configured = process.env.MCP_CWD ?? DEFAULT_WORKSPACE) {
  const workspace = resolveWorkspacePath(configured)
  await mkdir(workspace, { recursive: true })

  const agentsPath = join(workspace, "AGENTS.md")
  const starterSkillPath = join(workspace, "skills", "create-skill", "SKILL.md")
  await mkdir(dirname(starterSkillPath), { recursive: true })

  let agentsCreated = false
  try {
    await writeFile(agentsPath, STARTER_AGENTS_MD, { encoding: "utf8", flag: "wx" })
    agentsCreated = true
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }

  let starterSkillCreated = false
  try {
    await copyFile(STARTER_SKILL_SOURCE, starterSkillPath, constants.COPYFILE_EXCL)
    starterSkillCreated = true
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }

  return { workspace, agentsPath, starterSkillPath, created: agentsCreated, starterSkillCreated }
}
