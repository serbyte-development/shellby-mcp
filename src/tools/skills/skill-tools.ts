import { join } from "node:path"
import { z } from "zod"
import { createAgentLoadDeduper } from "../../agent/load-deduper.js"
import { MCP_CONFIG } from "../../config.js"
import { ToolError } from "../../mcp/tool-error.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import {
  isValidSkillName,
  type LoadedSkill,
  SkillCatalog,
  SkillCatalogError,
} from "./skill-catalog.js"

const SKILL_LOAD_COOLDOWN_MS = 5_000
const loadSkillOnce = createAgentLoadDeduper<LoadedSkill>(SKILL_LOAD_COOLDOWN_MS)

export function registerSkillTools(registerTool: ToolRegistrar): void {
  const skills = new SkillCatalog(join(MCP_CONFIG.workspace, "skills"))

  registerTool(
    "skill_list",
    {
      description: "List available reusable skills.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        skills: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
          })
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_input, ctx) => {
      try {
        const available = await skills.list(ctx.mcpReq.signal)
        return {
          structuredContent: { skills: available },
          content: [],
        }
      } catch (error) {
        throw skillToolError(error)
      }
    }
  )

  registerTool(
    "skill_use",
    {
      description: "Load a skill's instructions, then follow them using the appropriate tools.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .refine(isValidSkillName, "Invalid skill name.")
          .describe("Skill name returned by skill_list."),
      }),
      outputSchema: z.object({
        path: z.string(),
        instructions: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }, ctx) => {
      try {
        const { value: loaded, reused } = await loadSkillOnce(name, () =>
          skills.read(name, ctx.mcpReq.signal)
        )
        return {
          structuredContent: {
            path: loaded.path,
            instructions: reused
              ? `Skill ${JSON.stringify(name)} was loaded recently by this agent; reuse the previously returned instructions.`
              : loaded.content,
          },
          content: [],
        }
      } catch (error) {
        throw skillToolError(error)
      }
    }
  )
}

function skillToolError(error: unknown): ToolError {
  return new ToolError(
    error instanceof SkillCatalogError ? error.code : "skill_failed",
    error instanceof Error ? error.message : String(error),
    { cause: error }
  )
}
