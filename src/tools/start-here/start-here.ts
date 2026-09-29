import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import {
  type AgentIdentity,
  findAgentIdentity,
  getAgentIdentity,
  setAgentTaskSlug,
} from "../../agent/context.js"
import { createAgentLoadDeduper } from "../../agent/load-deduper.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import { asRecord } from "../../utils.js"

export const START_HERE_TOOL_NAME = "start_here"
const SHARED_PROMPT_NAME = "shared"
const PROMPT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const START_HERE_COOLDOWN_MS = 5_000
const loadStartInstructions = createAgentLoadDeduper<string>(START_HERE_COOLDOWN_MS)

type PromptSource = {
  path: string
  prompt: string
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

export function registerStartHereTool(registerTool: ToolRegistrar): void {
  const modes = discoverPromptModes()
  const [firstMode, ...remainingModes] = modes
  if (firstMode === undefined) throw new Error("start_here requires at least one prompt mode")

  registerTool(
    START_HERE_TOOL_NAME,
    {
      description:
        "Initialize Shellby once per conversation. Loads the selected Deep Work mode and unlocks the other tools",
      inputSchema: z.object({
        mode: z.enum([firstMode, ...remainingModes]),
        task_id: z.string().min(1).max(128),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ mode, task_id }) => {
      const { value: instructions, reused } = await loadStartInstructions(mode, () =>
        buildStartHereInstructions(mode)
      )
      setAgentTaskSlug(task_id)
      const identity = getAgentIdentity()
      const text = reused
        ? `Mode ${JSON.stringify(mode)} was loaded recently by this agent; reuse the previously returned instructions.`
        : instructions
      return {
        content: [
          {
            type: "text",
            // Expose the existing identity for the child browser listener; no extra ID registry.
            text: identity
              ? `${JSON.stringify({ tool: START_HERE_TOOL_NAME, sessionId: identity.sessionId, agent: identity.agent })}\n\n${text}`
              : text,
          },
        ],
      }
    }
  )
}

/** Resolve a successful startup's JSON header, only from a fresh MCP tool response. */
export function readStartHereIdentity(text: string): AgentIdentity | undefined {
  try {
    const header = asRecord(JSON.parse(text.split("\n", 1)[0] ?? ""))
    if (header?.tool !== START_HERE_TOOL_NAME || typeof header.sessionId !== "string")
      return undefined
    return findAgentIdentity(header.sessionId)
  } catch {
    return undefined
  }
}

export async function buildStartHereInstructions(
  mode: string,
  root = repositoryRoot
): Promise<string> {
  const [selected, shared] = await Promise.all([
    readStartPrompt(mode, root),
    readStartPrompt(SHARED_PROMPT_NAME, root),
  ])
  return [shared.prompt.trim(), selected.prompt.trim()].filter(Boolean).join("\n\n")
}

export function discoverPromptModes(root = repositoryRoot): string[] {
  const bundledDirectory = join(root, "src", "tools", "start-here", "prompts")
  const localDirectory = join(root, ".shellby", "prompts")
  const names = new Set([...readPromptSlugs(bundledDirectory), ...readPromptSlugs(localDirectory)])
  names.delete(SHARED_PROMPT_NAME)
  return [...names].sort()
}

export async function readStartPrompt(name: string, root = repositoryRoot): Promise<PromptSource> {
  const localPath = join(root, ".shellby", "prompts", `${name}.md`)
  try {
    return { path: localPath, prompt: await readFile(localPath, "utf8") }
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error
  }

  const bundledPath = join(root, "src", "tools", "start-here", "prompts", `${name}.md`)
  return { path: bundledPath, prompt: await readFile(bundledPath, "utf8") }
}

function readPromptSlugs(directory: string): string[] {
  try {
    const slugs = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3))
    const invalid = slugs.find((slug) => !PROMPT_SLUG_PATTERN.test(slug))
    if (invalid)
      throw new Error(
        `Invalid start_here prompt filename: ${invalid}.md. Use lowercase kebab-case.`
      )
    return slugs
  } catch (error) {
    if (isFsError(error, "ENOENT")) return []
    throw error
  }
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
