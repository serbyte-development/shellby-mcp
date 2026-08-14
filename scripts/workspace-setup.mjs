import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const DEFAULT_WORKSPACE = "~/Desktop/agent-workspace"

const STARTER_AGENTS_MD = `# Workspace Instructions

This file contains persistent instructions for coding work in this workspace. Customize it for your preferences.

- Read and follow project-local \`AGENTS.md\` files and relevant project documentation before editing a repository.
- Keep existing projects in their current locations.
- Create or clone new projects in this workspace unless the user asks for another location.
- Prefer more-specific project instructions when they conflict with this file.
`

function resolveWorkspacePath(configured) {
  if (configured === "~") return homedir()
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2))
  return resolve(configured)
}

export async function initializeWorkspace(configured = process.env.MCP_CWD ?? DEFAULT_WORKSPACE) {
  const workspace = resolveWorkspacePath(configured)
  await mkdir(workspace, { recursive: true })

  const agentsPath = join(workspace, "AGENTS.md")
  try {
    await writeFile(agentsPath, STARTER_AGENTS_MD, { encoding: "utf8", flag: "wx" })
    return { workspace, agentsPath, created: true }
  } catch (error) {
    if (error?.code === "EEXIST") return { workspace, agentsPath, created: false }
    throw error
  }
}
