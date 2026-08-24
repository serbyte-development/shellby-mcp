import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { ChildMcpClient, type ChildMcpClientOptions } from "../../src/server/child-mcp.js"
import { PEEKABOO_UPSTREAM_TOOL_NAMES } from "../../src/tools/computer/peekaboo-mcp.js"

export const fakeChildMcpFixture = fileURLToPath(new URL("../fixtures/fake-child-mcp.mjs", import.meta.url))

export function createFakeChildMcp(
  tools: readonly string[] = PEEKABOO_UPSTREAM_TOOL_NAMES,
  env: Record<string, string> = {},
  options: Pick<ChildMcpClientOptions, "transformTool" | "transformResult"> = {}
): ChildMcpClient {
  return new ChildMcpClient({
    name: "fake-child",
    command: process.execPath,
    args: [fakeChildMcpFixture],
    cwd: dirname(fakeChildMcpFixture),
    env: environment({ FAKE_CHILD_TOOLS: tools.join(","), ...env }),
    stderr: "pipe",
    tools,
    ...options,
  })
}

function environment(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...extra,
  }
}
