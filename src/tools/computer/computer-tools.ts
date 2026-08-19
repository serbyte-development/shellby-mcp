import { McpServer } from "@modelcontextprotocol/server"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { asRecord, booleanValue, finiteNumber as numberValue } from "../../utils.js"
import { PeekabooClient, PeekabooError, type PeekabooObservation, type PeekabooResult, type PeekabooSnapshotTarget } from "./peekaboo.js"

const appInput = z.string().min(1).describe("Application name, bundle identifier, or PID:12345 token.")
const snapshotInput = z.string().min(1).describe("Snapshot ID returned by computer_observe.")
const windowIdInput = z.number().int().positive().describe("CoreGraphics window ID.")

const targetFields = {
  app: appInput.optional(),
  window_id: windowIdInput.optional(),
  snapshot_id: snapshotInput.optional(),
}

const interactionRequirement =
  "Call computer_observe first and pass its snapshot_id when targeting an element. Element IDs and coordinates are valid only for the observed UI state."

export function registerComputerUseTools(server: McpServer, peekaboo: PeekabooClient): void {
  const listSchema = z
    .object({
      kind: z.enum(["apps", "windows", "screens", "permissions"]).default("apps"),
      app: appInput.optional().describe("Required when kind is windows."),
      include_hidden: z.boolean().optional(),
      include_background: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (value.kind === "windows" && !value.app) {
        context.addIssue({
          code: "custom",
          message: "app is required for windows.",
        })
      }
      if (value.kind !== "apps" && (value.include_hidden !== undefined || value.include_background !== undefined)) {
        context.addIssue({
          code: "custom",
          message: "include_hidden and include_background are valid only for apps.",
        })
      }
    })

  server.registerTool(
    "computer_list",
    {
      title: "List computer state",
      description: "List running applications, an application's renderable windows, connected displays, or Peekaboo permission status.",
      inputSchema: listSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ kind, app, include_hidden, include_background }, ctx) => {
      let args: string[]
      if (kind === "apps") {
        args = ["app", "list"]
        if (include_hidden) args.push("--include-hidden")
        if (include_background) args.push("--include-background")
      } else if (kind === "windows") {
        args = ["window", "list", "--app", app!]
      } else if (kind === "screens") {
        args = ["screen", "list"]
      } else {
        args = ["permissions", "status", "--all-sources"]
      }
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, `Listed computer ${kind}.`)
    }
  )

  const observeSchema = z
    .object({
      app: appInput.optional(),
      window_id: windowIdInput.optional(),
      screen_index: z.number().int().nonnegative().optional().describe("Zero-based display index. Omit to observe the frontmost window."),
      annotate: z.boolean().default(false).describe("Overlay element IDs on the returned screenshot."),
    })
    .superRefine((value, context) => {
      const targetCount = [value.app, value.window_id, value.screen_index].filter((item) => item !== undefined).length
      if (targetCount > 1) {
        context.addIssue({
          code: "custom",
          message: "Supply only one of app, window_id, or screen_index.",
        })
      }
    })

  server.registerTool(
    "computer_observe",
    {
      title: "Observe the computer",
      description:
        "Return a screenshot and fresh snapshot ID for an app, window, display, or the frontmost window. Accessibility elements are omitted to conserve context; call computer_inspect only when visual targeting is insufficient. Observe again after the UI changes.",
      inputSchema: observeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ app, window_id, screen_index, annotate }, ctx) => {
      const args: string[] = []
      if (app !== undefined) args.push("--app", app)
      else if (window_id !== undefined) args.push("--window-id", String(window_id))
      else if (screen_index !== undefined) {
        args.push("--mode", "screen", "--screen-index", String(screen_index))
      } else {
        args.push("--mode", "frontmost")
      }
      args.push("--no-web-focus")

      try {
        const observation = await peekaboo.observe(args, { annotate }, ctx.mcpReq.signal)
        return observationResult(observation)
      } catch (error) {
        return peekabooToolError(error)
      }
    }
  )

  server.registerTool(
    "computer_inspect",
    {
      title: "Inspect accessible UI",
      description:
        "Return a bounded accessibility-tree text view for an existing observation snapshot. Use only when its screenshot is insufficient; prefer small limits and inspect again after the UI changes.",
      inputSchema: z.object({
        snapshot_id: snapshotInput,
        max_depth: z.number().int().min(1).max(20).default(8),
        max_elements: z.number().int().min(1).max(500).default(100),
        max_children: z.number().int().min(1).max(100).default(25),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ snapshot_id, max_depth, max_elements, max_children }, ctx) => {
      try {
        const target = requireSnapshotTarget(peekaboo, snapshot_id)
        const args = ["see"]
        addObservationTargetArgs(args, target)
        args.push("--tree", "--no-screenshot", "--depth", String(max_depth), "--max-elements", String(max_elements), "--max-children", String(max_children))
        const result = await peekaboo.run(args, ctx.mcpReq.signal)
        return inspectionResult(result)
      } catch (error) {
        return peekabooToolError(error)
      }
    }
  )

  const clickSchema = z
    .object({
      snapshot_id: snapshotInput,
      element_id: z.string().min(1).optional(),
      query: z.string().min(1).optional().describe("Visible label or text query."),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      button: z.enum(["left", "right"]).optional(),
      click_count: z.number().int().min(1).max(2).optional(),
      long_press: z.boolean().optional(),
      foreground: z.boolean().optional(),
      wait_ms: z.number().int().min(0).max(30_000).optional(),
    })
    .superRefine((value, context) => {
      const hasCoordinates = value.x !== undefined && value.y !== undefined
      if ((value.x === undefined) !== (value.y === undefined)) {
        context.addIssue({
          code: "custom",
          message: "x and y must be supplied together.",
        })
      }
      const targetCount = [value.element_id, value.query, hasCoordinates ? true : undefined].filter((item) => item !== undefined).length
      if (targetCount !== 1) {
        context.addIssue({
          code: "custom",
          message: "Supply exactly one target: element_id, query, or x and y.",
        })
      }
      if (value.long_press && (value.button === "right" || value.click_count === 2)) {
        context.addIssue({
          code: "custom",
          message: "long_press cannot be combined with right-click or double-click.",
        })
      }
    })

  server.registerTool(
    "computer_click",
    {
      title: "Click the computer",
      description: `Click an observed element, text query, or coordinate. ${interactionRequirement}`,
      inputSchema: clickSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      const args = ["click"]
      let forceForeground = false
      if (input.element_id) {
        args.push("--on", input.element_id, "--snapshot", input.snapshot_id)
      } else if (input.query) {
        args.push(input.query, "--snapshot", input.snapshot_id)
      } else {
        try {
          const target = requireSnapshotTarget(peekaboo, input.snapshot_id)
          const coordinates = clickCoordinates(target, input.x!, input.y!)
          args.push("--at", `${coordinates.x},${coordinates.y}`)
          addSnapshotTargetArgs(args, target)
          forceForeground = true
          if (coordinates.global) {
            args.push("--global")
          }
        } catch (error) {
          return peekabooToolError(error)
        }
      }
      if (input.button === "right") args.push("--right")
      if (input.click_count === 2) args.push("--double")
      if (input.long_press) args.push("--long-press")
      if (input.foreground || input.click_count === 2 || input.long_press || forceForeground) {
        args.push("--foreground")
      }
      if (input.wait_ms !== undefined) args.push("--wait-for", String(input.wait_ms))
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Click completed.")
    }
  )

  server.registerTool(
    "computer_type",
    {
      title: "Type on the computer",
      description: "Type literal text into a targeted or focused app. Use snapshot_id or app to avoid typing into the wrong window.",
      inputSchema: z.object({
        ...targetFields,
        text: z.string().min(1).describe("Literal text to type."),
        clear: z.boolean().optional(),
        press_return: z.boolean().optional(),
        foreground: z.boolean().optional(),
        delay_ms: z.number().int().min(0).max(1_000).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      const args = ["type", "--text", input.text]
      addTargetArgs(args, input)
      if (input.clear) args.push("--clear")
      if (input.press_return) args.push("--return")
      if (input.foreground) args.push("--foreground")
      if (input.delay_ms !== undefined) args.push("--delay", String(input.delay_ms))
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Typing completed.")
    }
  )

  const keyToken = z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .describe("Key token such as return, tab, escape, cmd, shift, or a letter.")

  server.registerTool(
    "computer_press",
    {
      title: "Press computer keys",
      description: "Press one or more special keys sequentially, such as tab, tab, return. Use computer_hotkey for simultaneous shortcuts.",
      inputSchema: z.object({
        ...targetFields,
        keys: z.array(keyToken).min(1).max(16),
        count: z.number().int().min(1).max(100).optional(),
        foreground: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      const args = ["press", ...input.keys]
      addTargetArgs(args, input)
      if (input.count !== undefined) args.push("--count", String(input.count))
      if (input.foreground) args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Key press completed.")
    }
  )

  server.registerTool(
    "computer_hotkey",
    {
      title: "Press a computer shortcut",
      description: "Press one simultaneous keyboard shortcut, such as cmd+shift+t. Use computer_press for sequential keys.",
      inputSchema: z.object({
        ...targetFields,
        keys: z.array(keyToken).min(1).max(8),
        foreground: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      const args = ["press", input.keys.join("+")]
      addTargetArgs(args, input)
      if (input.foreground) args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Shortcut completed.")
    }
  )

  const scrollSchema = z
    .object({
      ...targetFields,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(100).optional(),
      element_id: z.string().min(1).optional(),
      smooth: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (value.element_id && !value.snapshot_id) {
        context.addIssue({
          code: "custom",
          message: "snapshot_id is required when element_id is supplied.",
        })
      }
    })

  server.registerTool(
    "computer_scroll",
    {
      title: "Scroll the computer",
      description: `Scroll at the pointer or on an observed element. ${interactionRequirement}`,
      inputSchema: scrollSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      const args = ["scroll", "--direction", input.direction]
      if (input.amount !== undefined) args.push("--amount", String(input.amount))
      if (input.element_id) args.push("--on", input.element_id)
      addTargetArgs(args, input)
      if (input.smooth) args.push("--smooth")
      if (!input.element_id || input.smooth) args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Scroll completed.")
    }
  )

  const dragPoint = z.union([z.object({ element_id: z.string().min(1) }).strict(), z.object({ x: z.number().finite(), y: z.number().finite() }).strict()])
  const dragDestination = z.union([dragPoint, z.object({ app: appInput }).strict()])
  const dragSchema = z.object({
    snapshot_id: snapshotInput,
    from: dragPoint,
    to: dragDestination,
    duration_ms: z.number().int().min(50).max(10_000).optional(),
    steps: z.number().int().min(2).max(96).optional(),
    modifiers: z
      .array(z.enum(["cmd", "shift", "option", "ctrl"]))
      .max(4)
      .optional(),
  })

  server.registerTool(
    "computer_drag",
    {
      title: "Drag on the computer",
      description: `Drag between observed elements, coordinates, or an application. ${interactionRequirement}`,
      inputSchema: dragSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      let target: PeekabooSnapshotTarget
      try {
        target = requireSnapshotTarget(peekaboo, input.snapshot_id)
      } catch (error) {
        return peekabooToolError(error)
      }

      const args = ["drag", "--snapshot", input.snapshot_id]
      addDragPointArgs(args, "from", input.from, target)
      if ("app" in input.to) args.push("--to-app", input.to.app)
      else addDragPointArgs(args, "to", input.to, target)
      addSnapshotTargetArgs(args, target)
      if (input.duration_ms !== undefined) args.push("--duration", String(input.duration_ms))
      if (input.steps !== undefined) args.push("--steps", String(input.steps))
      if (input.modifiers?.length) args.push("--modifiers", input.modifiers.join(","))
      args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Drag completed.")
    }
  )

  const appSchema = z
    .object({
      action: z.enum(["launch", "switch", "quit", "relaunch", "hide", "unhide"]),
      app: appInput,
      open: z.array(z.string().min(1)).max(10).default([]).describe("Files or URLs to open when launching."),
      force: z.boolean().default(false).describe("Force quit or relaunch without saving."),
    })
    .superRefine((value, context) => {
      if (value.open.length > 0 && value.action !== "launch") {
        context.addIssue({
          code: "custom",
          message: "open is valid only for launch.",
        })
      }
      if (value.force && value.action !== "quit" && value.action !== "relaunch") {
        context.addIssue({
          code: "custom",
          message: "force is valid only for quit or relaunch.",
        })
      }
    })

  server.registerTool(
    "computer_app",
    {
      title: "Manage a computer app",
      description:
        "Launch, switch to, quit, relaunch, hide, or unhide a Mac application. Launch and relaunch wait until the app is ready; switch verifies focus.",
      inputSchema: appSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ action, app, open, force }, ctx) => {
      const args = appCommandArgs(action, app, open, force)
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, `Application ${action} completed.`)
    }
  )

  const windowSchema = z
    .object({
      action: z.enum(["focus", "close", "minimize", "maximize", "move", "resize", "set_bounds"]),
      app: appInput.optional(),
      window_id: windowIdInput.optional(),
      window_title: z.string().min(1).optional(),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .superRefine((value, context) => {
      if ((value.app === undefined) === (value.window_id === undefined)) {
        context.addIssue({
          code: "custom",
          message: "Supply exactly one window anchor: app or window_id.",
        })
      }
      if (value.window_title && !value.app) {
        context.addIssue({
          code: "custom",
          message: "window_title requires app.",
        })
      }
      const requiredGeometry: Record<typeof value.action, Array<keyof typeof value>> = {
        focus: [],
        close: [],
        minimize: [],
        maximize: [],
        move: ["x", "y"],
        resize: ["width", "height"],
        set_bounds: ["x", "y", "width", "height"],
      }
      const geometryFields = ["x", "y", "width", "height"] as const
      for (const field of requiredGeometry[value.action]) {
        if (value[field] === undefined) {
          context.addIssue({
            code: "custom",
            message: `${String(field)} is required for ${value.action}.`,
          })
        }
      }
      for (const field of geometryFields) {
        if (value[field] !== undefined && !requiredGeometry[value.action].includes(field)) {
          context.addIssue({
            code: "custom",
            message: `${field} is not valid for ${value.action}.`,
          })
        }
      }
    })

  server.registerTool(
    "computer_window",
    {
      title: "Manage a computer window",
      description:
        "Focus, close, minimize, maximize, move, resize, or set the bounds of an app window. Use computer_list with kind=windows to obtain exact window IDs.",
      inputSchema: windowSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async (input, ctx) => {
      const subcommand = input.action === "set_bounds" ? "set-bounds" : input.action
      const args = ["window", subcommand]
      if (input.app) args.push("--app", input.app)
      if (input.window_id !== undefined) args.push("--window-id", String(input.window_id))
      if (input.window_title) args.push("--window-title", input.window_title)
      if (input.x !== undefined) args.push("--x", String(input.x))
      if (input.y !== undefined) args.push("--y", String(input.y))
      if (input.width !== undefined) args.push("--width", String(input.width))
      if (input.height !== undefined) args.push("--height", String(input.height))
      if (input.action === "focus") args.push("--verify")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, `Window ${input.action} completed.`)
    }
  )
}

function addTargetArgs(args: string[], target: { app?: string; window_id?: number; snapshot_id?: string }): void {
  if (target.app !== undefined) args.push("--app", target.app)
  if (target.window_id !== undefined) args.push("--window-id", String(target.window_id))
  if (target.snapshot_id !== undefined) args.push("--snapshot", target.snapshot_id)
}

function addDragPointArgs(args: string[], side: "from" | "to", point: { element_id: string } | { x: number; y: number }, target: PeekabooSnapshotTarget): void {
  if ("element_id" in point) args.push(`--${side}`, point.element_id)
  else {
    const coordinates = clickCoordinates(target, point.x, point.y)
    args.push(`--${side}`, `${coordinates.x},${coordinates.y}`)
  }
}

function requireSnapshotTarget(peekaboo: PeekabooClient, snapshotId: string): PeekabooSnapshotTarget {
  const target = peekaboo.getSnapshotTarget(snapshotId)
  if (target) return target
  throw new PeekabooError("SNAPSHOT_TARGET_MISSING", "The observation target is no longer available. Call computer_observe again.")
}

function clickCoordinates(target: PeekabooSnapshotTarget, x: number, y: number): { x: number; y: number; global: boolean } {
  const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
  const needsGlobalCoordinates = screenCapture || (target.windowId === undefined && !target.app)
  if (!needsGlobalCoordinates) return { x, y, global: false }
  if (!target.bounds) {
    throw new PeekabooError("SNAPSHOT_BOUNDS_MISSING", "The observation bounds are unavailable. Call computer_observe again.")
  }
  return {
    x: x + target.bounds.x,
    y: y + target.bounds.y,
    global: true,
  }
}

function addSnapshotTargetArgs(args: string[], target: PeekabooSnapshotTarget): void {
  const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
  if (screenCapture) return
  if (target.windowId !== undefined) {
    args.push("--window-id", String(target.windowId))
  } else if (target.app) {
    args.push("--app", target.app)
  }
}

function addObservationTargetArgs(args: string[], target: PeekabooSnapshotTarget): void {
  const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
  if (screenCapture) {
    args.push("--mode", "screen", "--screen-index", String(target.screenIndex ?? 0))
  } else if (target.app && target.windowTitle) {
    args.push("--app", target.app, "--window-title", target.windowTitle)
  } else if (target.windowId !== undefined) {
    args.push("--window-id", String(target.windowId))
  } else if (target.app) {
    args.push("--app", target.app)
  } else {
    args.push("--mode", "frontmost")
  }
}

function appCommandArgs(
  action: "launch" | "switch" | "quit" | "relaunch" | "hide" | "unhide",
  app: string,
  open: string[],
  force: boolean
): string[] {
  if (action === "launch") {
    const args = ["app", "launch", app, "--wait-ready"]
    for (const item of open) args.push("--open", item)
    return args
  }
  if (action === "switch") return ["app", "switch", "--to", app, "--verify"]
  if (action === "quit") {
    return ["app", "quit", "--app", app, ...(force ? ["--force"] : [])]
  }
  if (action === "relaunch") {
    return ["app", "relaunch", app, "--wait-until-ready", ...(force ? ["--force"] : [])]
  }
  return ["app", action, "--app", app]
}

async function callPeekaboo(peekaboo: PeekabooClient, args: string[], signal: AbortSignal, fallbackSummary: string): Promise<CallToolResult> {
  try {
    return commandResult(await peekaboo.run(args, signal), fallbackSummary)
  } catch (error) {
    return peekabooToolError(error)
  }
}

function commandResult(result: PeekabooResult, fallbackSummary: string): CallToolResult {
  const summary = typeof result.summary === "string" ? result.summary : (result.messages?.find((message) => message.trim()) ?? fallbackSummary)
  const structuredContent = asStructuredContent(result.data)
  return {
    content: [{ type: "text", text: summary }],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

function observationResult(observation: PeekabooObservation): CallToolResult {
  const data = asRecord(observation.data) ?? {}
  const application = stringValue(data.application_name)
  const windowTitle = stringValue(data.window_title)
  const structuredContent = omitUndefined({
    snapshot_id: stringValue(data.snapshot_id),
    application_name: application,
    window_title: windowTitle,
    is_dialog: booleanValue(data.is_dialog),
    capture_mode: stringValue(data.capture_mode),
    element_count: numberValue(data.element_count),
    interactable_count: numberValue(data.interactable_count),
  })
  const target = [application, windowTitle].filter(Boolean).join(" — ") || "computer"

  return {
    content: [
      {
        type: "text",
        text: `Observed ${target}.`,
      },
      {
        type: "image",
        data: observation.imageData,
        mimeType: observation.mimeType,
      },
    ],
    structuredContent,
  }
}

function inspectionResult(result: PeekabooResult): CallToolResult {
  const data = asRecord(result.data)
  const embeddedText = Array.isArray(data?.content)
    ? data.content
        .map(asRecord)
        .map((item) => stringValue(item?.text))
        .find((value) => value !== undefined)
    : undefined
  const elements = Array.isArray(data?.ui_elements)
    ? data.ui_elements
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => {
          const id = stringValue(item.id)
          const role = stringValue(item.role) ?? stringValue(item.role_description) ?? "element"
          const label = stringValue(item.label) ?? stringValue(item.title) ?? stringValue(item.value)
          return `${id ? `[${id}] ` : ""}${role}${label ? ` ${JSON.stringify(label)}` : ""}`
        })
        .filter(Boolean)
    : []
  const text =
    stringValue(data?.text) ??
    embeddedText ??
    (elements.length ? elements.join("\n") : undefined) ??
    (typeof result.summary === "string" ? result.summary : undefined) ??
    result.messages?.find((message) => message.trim()) ??
    "Inspected accessible UI."
  return { content: [{ type: "text", text }] }
}

function peekabooToolError(error: unknown): CallToolResult {
  if (error instanceof PeekabooError) {
    return {
      content: [
        {
          type: "text",
          text: `${error.code}: ${error.message}${error.details ? ` (${error.details})` : ""}`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  }
}

function asStructuredContent(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null
  return asRecord(value) ?? { value }
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
