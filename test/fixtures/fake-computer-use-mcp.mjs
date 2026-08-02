import { appendFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const logPath = process.env.FAKE_COMPUTER_USE_LOG;
const schemaMode = process.env.FAKE_COMPUTER_USE_SCHEMA_MODE;
const exitBeforeResponseTool = process.env.FAKE_EXIT_BEFORE_RESPONSE_TOOL;
const errorTool = process.env.FAKE_ERROR_TOOL;
const delayMs = Number.parseInt(
  process.env.FAKE_COMPUTER_USE_DELAY_MS ?? "0",
  10,
);

log("process:start");
process.on("SIGTERM", () => {
  log("process:sigterm");
  process.exit(0);
});

const server = new McpServer(
  { name: "fake-computer-use", version: "1.0.0" },
  { instructions: "Fake Computer Use child for tests." },
);

register("list_apps", {}, async () => result("list_apps", {}), {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

register(
  "get_app_state",
  { app: z.string() },
  async ({ app }) => ({
    content: [
      { type: "text", text: `state:${app}` },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    structuredContent: { app, accessibilityTree: [{ index: "42" }] },
    _meta: { fake: true },
  }),
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
);

if (schemaMode !== "missing-click") {
  register(
    "click",
    {
      app: z.string(),
      click_count: z.number().int().optional(),
      element_index: z.string().optional(),
      mouse_button: z.enum(["left", "right", "middle"]).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    async (args) => result("click", args),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  );
}

register(
  "type_text",
  { app: z.string(), text: z.string() },
  async (args) => result("type_text", args),
  {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
);

register(
  "scroll",
  {
    app: z.string(),
    direction: z.string(),
    element_index: z.string(),
    pages: z.number().optional(),
  },
  async (args) => result("scroll", args),
  {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
);

register(
  "press_key",
  { app: z.string(), key: z.string() },
  async (args) => result("press_key", args),
  {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
);

await server.connect(new StdioServerTransport());

function register(name, inputSchema, callback, annotations) {
  server.registerTool(
    name,
    {
      description: `Fake ${name}`,
      inputSchema,
      annotations,
    },
    async (args) => {
      log(`tool:start:${name}`);
      if (exitBeforeResponseTool === name) {
        process.exit(9);
      }
      if (errorTool === name) {
        log(`tool:end:${name}`);
        return {
          content: [
            {
              type: "text",
              text: "Computer Use server error -10000: Sender process is not authenticated",
            },
          ],
          isError: true,
        };
      }
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const value = await callback(args);
      log(`tool:end:${name}`);
      return value;
    },
  );
}

function result(name, args) {
  return {
    content: [{ type: "text", text: `${name}:ok` }],
    structuredContent: { name, args },
    _meta: { fake: true },
  };
}

function log(value) {
  if (logPath) appendFileSync(logPath, `${value}\n`);
}
