import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { CallToolResult, Tool } from "@modelcontextprotocol/client"

import { ChildMcpClient } from "../../server/child-mcp.js"
import { asRecord, finiteNumber } from "../../utils.js"
import { encodeImageForMcp } from "../image/image-encoding.js"

export const PEEKABOO_UPSTREAM_TOOL_NAMES = ["permissions", "see", "inspect_ui", "click", "type", "press", "scroll", "drag", "app", "window"] as const
type PeekabooUpstreamToolName = (typeof PEEKABOO_UPSTREAM_TOOL_NAMES)[number]
type PeekabooPublicToolName = `computer_${PeekabooUpstreamToolName}`

interface ToolOverlay {
  name: PeekabooPublicToolName
  description: string
  parameters?: Record<string, string>
}

const AX_LIMIT_DESCRIPTIONS = {
  max_depth: "Maximum AX traversal depth; defaults to 8. Raise only when output reports depth truncation.",
  max_elements: "Maximum AX elements; defaults to 100. Raise only when more controls are needed.",
  max_children: "Maximum AX children per node; defaults to 25. Raise for wide Qt or Electron control groups.",
}

const PEEKABOO_TOOL_OVERLAYS: Record<PeekabooUpstreamToolName, ToolOverlay> = {
  permissions: {
    name: "computer_permissions",
    description: "Check whether Screen Recording, Accessibility, and action-specific Event Synthesizing permissions are available.",
  },
  see: {
    name: "computer_see",
    description:
      "Capture a compressed screenshot and compact snapshot receipt. The accessibility tree is omitted; use computer_inspect_ui with the snapshot when visual targeting is insufficient.",
    parameters: {
      ...AX_LIMIT_DESCRIPTIONS,
      app_target: "Capture target: screen:INDEX, frontmost, app name, or PID:1234. Omit for all screens.",
      roi: "Window-local x,y,width,height crop. Requires window_id and creates ROI-local coordinates.",
      snapshot: "Existing snapshot to update. Omit to create one.",
      window_id: "Exact CoreGraphics window ID; optionally verify its owner with app_target.",
    },
  },
  inspect_ui: {
    name: "computer_inspect_ui",
    description: "Read accessible text, controls, and state without a screenshot. Use computer_see when visual layout or inaccessible content matters.",
    parameters: {
      ...AX_LIMIT_DESCRIPTIONS,
      app_target: "Target frontmost UI, an app name, PID:1234, or app/PID plus window title.",
      snapshot: "Existing snapshot to update. Omit to create one.",
      window_id: "Exact window ID; requires an app or PID app_target and verifies ownership.",
    },
  },
  click: {
    name: "computer_click",
    description:
      "Click exactly one element ID, text query, or coordinate target. Coordinates default to global display points; use image_pixels with a fresh exact-window coordinate_reference for pixels in a computer_see image. Use foreground only for intentional shared-pointer input.",
    parameters: {
      background: "Deprecated inverse alias; prefer foreground.",
      coordinate_reference: "Reference from a fresh exact-window see; required for background image-pixel or normalized coordinates.",
      coordinate_space:
        "Coordinate basis. Defaults to global_display_points, even with an exact-window snapshot. Use image_pixels with coordinate_reference for coordinates relative to the returned computer_see image.",
      coords:
        "Coordinate pair formatted as x,y. With omitted coordinate_space, values are global screen points. For pixels in the returned computer_see image, set coordinate_space=image_pixels and provide coordinate_reference or snapshot.",
      foreground: "Use the shared physical pointer instead of background delivery.",
      on: "Opaque element ID copied from current computer_see or computer_inspect_ui output.",
      pid: "Optional process consistency check; never replaces a capture reference.",
      query: "Visible text or element query.",
      snapshot: "Snapshot from computer_see or computer_inspect_ui; required for background coordinates unless coordinate_reference is supplied.",
    },
  },
  type: {
    name: "computer_type",
    description:
      "Type literal text using a fresh snapshot for background delivery, or use an explicit foreground target when foreground authority is enabled. Use computer_press for keys or shortcuts.",
    parameters: {
      on: "Element ID from the supplied snapshot. Omit to type into its captured window.",
      profile: "Typing profile: linear or human.",
      snapshot: "Fresh exact non-dialog snapshot from computer_see or computer_inspect_ui; required for background delivery.",
      text: "Literal text to type.",
      wpm: "Human typing speed from 80 to 220 WPM; overrides delay.",
    },
  },
  press: {
    name: "computer_press",
    description:
      "Press either a chord sequence in keys or one key with modifiers. Background delivery requires a fresh snapshot; observe afterward because raw chords cannot verify their effect.",
    parameters: {
      key: "Single primary key used with modifiers; mutually exclusive with keys.",
      keys: 'Chord sequence such as ["cmd+c", "Return"]; mutually exclusive with key and modifiers.',
      modifiers: "Modifiers for the single-key form.",
      snapshot: "Fresh exact non-dialog snapshot from computer_see or computer_inspect_ui; required for background delivery.",
    },
  },
  scroll: {
    name: "computer_scroll",
    description: "Scroll an observed element in the background, or set foreground=true to scroll at the current pointer. Background mode requires on.",
    parameters: {
      amount: "Number of scroll ticks or lines.",
      foreground: "Focus the target and use global wheel events at the physical pointer.",
      on: "Element ID from computer_see or computer_inspect_ui; required in background mode.",
      smooth: "Use smooth synthetic scrolling; requires foreground=true.",
      snapshot: "Snapshot from computer_see or computer_inspect_ui; omit to use the latest snapshot.",
    },
  },
  drag: {
    name: "computer_drag",
    description: "Drag from one element, query, or coordinate to another. Always moves the shared physical pointer and requires foreground=true.",
    parameters: {
      foreground: "Confirm intentional use of the shared physical pointer.",
      from: "Start element ID or query; use instead of from_coords.",
      from_coords: "Start coordinate pair formatted as x,y; use instead of from.",
      profile: "Movement profile: linear or human.",
      snapshot: "Snapshot from computer_see or computer_inspect_ui; omit to use the latest snapshot.",
      to: "End element ID or query; exclusive with to_coords and to_app.",
      to_app: "Destination application; exclusive with to and to_coords.",
      to_coords: "End coordinate pair formatted as x,y; exclusive with to and to_app.",
    },
  },
  app: {
    name: "computer_app",
    description: "List or control applications. Cold launch, open, relaunch, new-instance, and unhide actions require foreground=true.",
    parameters: {
      all: "Apply quit to all applications.",
      except: "Applications excluded when all=true.",
      foreground: "Required for cold launch, open, newInstance, relaunch, and unhide.",
      name: "Target app name, bundle identifier, or PID:1234.",
      openTargets: "URLs or file paths; required for open and optional for launch.",
      to: "Target application for switch.",
    },
  },
  window: {
    name: "computer_window",
    description:
      "List or control windows. Prefer window_id from action=list. move requires x and y; resize requires width and height; set-bounds requires all four.",
    parameters: {
      app: "Target app name, bundle identifier, or PID:1234.",
      foreground: "For close only, allow a focused fallback if Accessibility close fails.",
      index: "Zero-based window index.",
      title: "Partial window-title match.",
      window_id: "Stable window ID returned by action=list.",
    },
  },
}

const BACKGROUND_ONLY_OMITTED_PARAMETERS: Partial<Record<PeekabooUpstreamToolName, readonly string[]>> = {
  app: ["foreground", "openTargets", "to"],
  window: ["foreground"],
}

export const PEEKABOO_TOOL_NAMES = PEEKABOO_UPSTREAM_TOOL_NAMES.map((name) => PEEKABOO_TOOL_OVERLAYS[name].name)

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
export const PEEKABOO_EXECUTABLE = resolve(repositoryRoot, "vendor/peekaboo/peekaboo")

export function createPeekabooMcp(): ChildMcpClient {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  const allowForeground = process.env.PEEKABOO_ALLOW_FOREGROUND === "1"
  const upstreamToolNames = allowForeground ? PEEKABOO_UPSTREAM_TOOL_NAMES : PEEKABOO_UPSTREAM_TOOL_NAMES.filter((name) => name !== "drag")
  env.PEEKABOO_ALLOW_TOOLS = upstreamToolNames.join(",")
  env.PEEKABOO_AX_MAX_DEPTH ??= "8"
  env.PEEKABOO_AX_MAX_ELEMENTS ??= "100"
  env.PEEKABOO_AX_MAX_CHILDREN ??= "25"
  delete env.PEEKABOO_DISABLE_TOOLS

  return new ChildMcpClient({
    name: "peekaboo",
    command: PEEKABOO_EXECUTABLE,
    args: ["mcp", "serve", ...(allowForeground ? ["--allow-foreground"] : [])],
    env,
    tools: upstreamToolNames,
    transformTool: (tool) => applyPeekabooToolOverlay(tool, allowForeground),
    transformResult: transformPeekabooResult,
  })
}

export async function transformPeekabooResult(toolName: string, result: CallToolResult): Promise<CallToolResult> {
  const transformed = {
    ...result,
    content: await Promise.all(
      result.content.map(async (block) => {
        if (block.type !== "image") return block
        const image = await encodeImageForMcp(Buffer.from(block.data, "base64"))
        return { ...block, data: image.data, mimeType: image.mimeType }
      })
    ),
  }

  if (toolName !== "computer_see" || transformed.isError || !transformed.content.some((block) => block.type === "image")) return transformed

  const coordinateContext = asRecord(asRecord(transformed._meta)?.coordinate_context)
  const snapshot = coordinateContext?.reference_id
  if (typeof snapshot !== "string" || !snapshot) return transformed

  const imageSize = asRecord(coordinateContext.delivered_image_size)
  const width = finiteNumber(imageSize?.width)
  const height = finiteNumber(imageSize?.height)
  const originalText = transformed.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
  const notices = originalText
    .split("\n")
    .filter(
      (line) =>
        /^\s*(?:warnings?|⚠)|AX tree truncated|ACCESSIBILITY_INCOMPLETE|accessibility incomplete/i.test(line) ||
        /^(?:Screenshot|Annotated screenshot|Saved(?: screenshot)?):/i.test(line)
    )

  return {
    ...transformed,
    content: [
      {
        type: "text",
        text: [
          `Snapshot / coordinate_reference: ${snapshot}`,
          ...(width !== undefined && height !== undefined ? [`Image: ${width}x${height} pixels`] : []),
          ...notices,
        ].join("\n"),
      },
      ...transformed.content.filter((block) => block.type !== "text"),
    ],
  }
}

function applyPeekabooToolOverlay(tool: Tool, allowForeground: boolean): Tool {
  const overlay = PEEKABOO_TOOL_OVERLAYS[tool.name as PeekabooUpstreamToolName]
  if (!overlay) throw new Error(`No tool overlay configured for Peekaboo tool ${tool.name}.`)

  const inputSchema = stripDescriptions(tool.inputSchema) as Tool["inputSchema"]
  const properties = inputSchema.properties as Record<string, unknown> | undefined
  for (const [name, description] of Object.entries(overlay.parameters ?? {})) {
    const property = properties?.[name]
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      if (!allowForeground && BACKGROUND_ONLY_OMITTED_PARAMETERS[tool.name as PeekabooUpstreamToolName]?.includes(name)) continue
      throw new Error(`Description overlay for Peekaboo tool ${tool.name} references missing parameter ${name}.`)
    }
    properties![name] = { ...(property as Record<string, unknown>), description }
  }

  return {
    ...tool,
    name: overlay.name,
    description: overlay.description,
    inputSchema,
    ...(tool.outputSchema ? { outputSchema: stripDescriptions(tool.outputSchema) as Tool["outputSchema"] } : {}),
  }
}

function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, child]) => [key, stripDescriptions(child)])
  )
}
