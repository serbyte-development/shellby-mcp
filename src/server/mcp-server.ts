import { McpServer } from "@modelcontextprotocol/server"

import { buildMcpInstructions, MCP_CONFIG } from "../config.js"
import { registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerComputerUseTools } from "../tools/computer/computer-tools.js"
import { PeekabooClient } from "../tools/computer/peekaboo.js"
import { FeedbackStore, registerFeedbackTool } from "../tools/feedback.js"
// import { registerIosShellTool } from "../tools/ios/ios-shell.js"
import { registerShellExecutionTools, registerShellManagementTools } from "../tools/shell/shell-tools.js"
import { ShellSessionManager } from "../tools/shell/session-manager.js"
import { registerSkillTools } from "../tools/skills.js"
import { type ChatGptSubagentService } from "../tools/subagent/chatgpt-subagent.js"
import { registerSubagentTools } from "../tools/subagent/subagent-tools.js"
import { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"

export interface CreateMcpServerOptions {
  chatGptSubagents: ChatGptSubagentService
  feedbackStore: FeedbackStore
  peekaboo: PeekabooClient
  webPageOpener: WebPageOpener
  applyPatchExecutable?: string
}

export function createMcpServer(shells: ShellSessionManager, options: CreateMcpServerOptions): McpServer {
  const workspace = shells.initialCwd
  const server = new McpServer(MCP_CONFIG.server, {
    instructions: buildMcpInstructions(workspace),
  })

  registerShellExecutionTools(server, shells, workspace)
  // iOS shell is experimental and intentionally disabled until the bridge is revisited.
  // registerIosShellTool(server)
  registerApplyPatchTool(server, options.applyPatchExecutable)
  registerShellManagementTools(server, shells)
  registerSubagentTools(server, options.chatGptSubagents)
  registerWebTool(server, options.webPageOpener)
  registerSkillTools(server, workspace)
  registerComputerUseTools(server, options.peekaboo)
  registerFeedbackTool(server, options.feedbackStore)

  return server
}
