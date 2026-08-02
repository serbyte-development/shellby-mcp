import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  ComputerUseManager,
  ComputerUseUnavailableError,
  type ComputerUseChildToolName,
} from "./computer-use-manager.js";

const noAuthMeta = {
  securitySchemes: [{ type: "noauth" }],
};

const appInput = z
  .string()
  .min(1)
  .describe("App name, full app path, or unambiguous bundle identifier.");

const stateRequirement =
  "Call computer_get_app_state for this app once in the current assistant turn before interacting with it. Element indexes and screenshot coordinates are valid only for the app state that produced them.";

export function registerComputerUseTools(
  server: McpServer,
  computerUse: ComputerUseManager,
): void {
  server.registerTool(
    "computer_list_apps",
    {
      title: "List computer apps",
      description:
        "List apps that are currently running or were recently used on this Mac.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async (_args, extra) =>
      callComputerUse(computerUse, "list_apps", {}, extra.signal),
  );

  server.registerTool(
    "computer_get_app_state",
    {
      title: "Get app state",
      description:
        "Start an app-use session if needed, then return the key window screenshot and accessibility tree. Call this once per assistant turn before interacting with the app. Screenshots and accessibility data may contain private information.",
      inputSchema: {
        app: appInput,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async ({ app }, extra) =>
      callComputerUse(computerUse, "get_app_state", { app }, extra.signal),
  );

  const clickSchema = z
    .object({
      app: appInput,
      click_count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of clicks. Defaults to 1."),
      element_index: z
        .string()
        .min(1)
        .optional()
        .describe("Element index from the latest app state."),
      mouse_button: z
        .enum(["left", "right", "middle"])
        .optional()
        .describe("Mouse button. Defaults to left."),
      x: z
        .number()
        .finite()
        .optional()
        .describe("X coordinate in the latest screenshot's pixel coordinates."),
      y: z
        .number()
        .finite()
        .optional()
        .describe("Y coordinate in the latest screenshot's pixel coordinates."),
    })
    .superRefine((value, context) => {
      const usesElement = value.element_index !== undefined;
      const hasX = value.x !== undefined;
      const hasY = value.y !== undefined;
      const usesCoordinates = hasX && hasY;

      if (hasX !== hasY) {
        context.addIssue({
          code: "custom",
          message: "x and y must be supplied together.",
        });
      }
      if (usesElement === usesCoordinates) {
        context.addIssue({
          code: "custom",
          message:
            "Supply either element_index or x and y coordinates, but not both.",
        });
      }
    });

  server.registerTool(
    "computer_click",
    {
      title: "Click in an app",
      description: `Click an element or screenshot coordinate. ${stateRequirement}`,
      inputSchema: clickSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async (args, extra) =>
      callComputerUse(computerUse, "click", args, extra.signal),
  );

  server.registerTool(
    "computer_type_text",
    {
      title: "Type text in an app",
      description: `Type literal text using keyboard input. ${stateRequirement}`,
      inputSchema: {
        app: appInput,
        text: z.string().min(1).describe("Literal text to type."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async ({ app, text }, extra) =>
      callComputerUse(computerUse, "type_text", { app, text }, extra.signal),
  );

  server.registerTool(
    "computer_scroll",
    {
      title: "Scroll in an app",
      description: `Scroll an element in a direction by a number of pages. ${stateRequirement}`,
      inputSchema: {
        app: appInput,
        element_index: z
          .string()
          .min(1)
          .describe("Element index from the latest app state."),
        direction: z.enum(["up", "down", "left", "right"]),
        pages: z
          .number()
          .finite()
          .positive()
          .optional()
          .describe("Number of pages to scroll. Defaults to 1."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async ({ app, element_index, direction, pages }, extra) =>
      callComputerUse(
        computerUse,
        "scroll",
        {
          app,
          element_index,
          direction,
          ...(pages === undefined ? {} : { pages }),
        },
        extra.signal,
      ),
  );

  server.registerTool(
    "computer_press_key",
    {
      title: "Press a key in an app",
      description: `Press a key or key combination in an app. ${stateRequirement}`,
      inputSchema: {
        app: appInput,
        key: z
          .string()
          .min(1)
          .describe(
            'Key or combination, such as "Return", "Tab", "Up", or "super+c".',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: noAuthMeta,
    },
    async ({ app, key }, extra) =>
      callComputerUse(computerUse, "press_key", { app, key }, extra.signal),
  );
}

async function callComputerUse(
  computerUse: ComputerUseManager,
  name: ComputerUseChildToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    return addAppleEventsPermissionHint(
      await computerUse.callTool(name, args, signal),
    );
  } catch (error) {
    const message =
      error instanceof ComputerUseUnavailableError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

function addAppleEventsPermissionHint(result: CallToolResult): CallToolResult {
  const hasBootstrapError = result.content.some(
    (block) =>
      block.type === "text" &&
      (block.text.includes("-1743") ||
        block.text.includes("-10000") ||
        block.text.includes("Sender process is not authenticated")),
  );
  if (
    result.isError !== true ||
    !hasBootstrapError
  ) {
    return result;
  }

  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: "macOS denied or could not authenticate the Computer Use host process. Bootstrap Computer Use from the same Terminal or stable app identity that launches this MCP server, then approve the Automation prompt.",
      },
    ],
  };
}
