import { McpServer } from "@modelcontextprotocol/server"

import { buildMcpInstructions, MCP_CONFIG, type ToolOutputStructuredMode } from "../config.js"
import { registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerImageTools } from "../tools/image/image-tools.js"
// import { registerIosShellTool } from "../tools/ios/ios-shell.js"
import { registerShellExecutionTools, registerShellManagementTools } from "../tools/shell/shell-tools.js"
import type { ShellSessionManager } from "../tools/shell/session-manager.js"
import { registerSkillTools } from "../tools/skills.js"
import type { ChatGptSubagentService } from "../tools/subagent/chatgpt-subagent-contracts.js"
import { registerSubagentTools } from "../tools/subagent/subagent-tools.js"
import { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"
import { registerChildMcpTools, type ChildMcpToolProvider } from "./child-mcp.js"
import { installToolRegistrationBoundary } from "./tool-registration-boundary.js"

export interface CreateMcpServerOptions {
  chatGptSubagents: ChatGptSubagentService
  childMcpServers: readonly ChildMcpToolProvider[]
  webPageOpener: WebPageOpener
  applyPatchExecutable?: string
  toolOutputStructured?: ToolOutputStructuredMode
}

export function createMcpServer(shells: ShellSessionManager, options: CreateMcpServerOptions): McpServer {
  const workspace = shells.initialCwd
  const server = new McpServer(MCP_CONFIG.server, {
    instructions: buildMcpInstructions(workspace),
  })
  installToolRegistrationBoundary(server, {
    toolOutputStructured: options.toolOutputStructured ?? MCP_CONFIG.toolOutputStructured,
    drainPendingEvents: () => options.chatGptSubagents.drainEvents?.() ?? [],
    passthroughToolNames: new Set(options.childMcpServers.flatMap((child) => child.tools.map((tool) => tool.name))),
  })

  registerShellExecutionTools(server, shells, workspace)
  // iOS shell is experimental and intentionally disabled until the bridge is revisited.
  // registerIosShellTool(server)
  registerApplyPatchTool(server, options.applyPatchExecutable)
  registerShellManagementTools(server, shells)
  registerSubagentTools(server, options.chatGptSubagents)
  registerWebTool(server, options.webPageOpener)
  registerSkillTools(server, workspace)
  registerImageTools(server, workspace)
  registerChildMcpTools(server, options.childMcpServers, MCP_CONFIG.toolMeta)

  return server
}
