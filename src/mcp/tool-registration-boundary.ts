import { randomUUID } from "node:crypto"
import type {
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolCallback,
} from "@modelcontextprotocol/server"

import { getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import { log, withLogContext } from "../logging.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import type { ReviewPromptTracker } from "../tools/review/review-tool.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import { isRecord } from "../utils.js"
import { appendToolEvents, compactToolResult } from "./tool-output.js"
import { prepareToolRegistration } from "./tool-schema-presentation.js"

export interface ToolRegistrationBoundaryOptions {
  structuredOutput: boolean
  drainPendingEvents?: () => string[]
  agentObserver?: AgentObserver
  reviewPromptTracker?: ReviewPromptTracker
  auditRequest?: McpAuditRequest
}

type ToolConfig<Input extends StandardSchemaWithJSON | undefined> = Omit<
  Parameters<McpServer["registerTool"]>[1],
  "inputSchema" | "outputSchema"
> & {
  inputSchema?: Input
  outputSchema?: StandardSchemaWithJSON
  /** Preserve this tool's native content and output schema in compact mode. */
  nativeContent?: true
}

export type ToolRegistrar = <Input extends StandardSchemaWithJSON | undefined = undefined>(
  name: string,
  config: ToolConfig<Input>,
  callback: ToolCallback<Input>
) => ReturnType<McpServer["registerTool"]>

interface RegisteredTool {
  acceptsInput: boolean
  nativeContent: boolean
  callback: (...args: unknown[]) => unknown
}

/** Register tools through Shellby's execution policy while leaving the SDK server untouched. */
export function createToolRegistrar(
  server: McpServer,
  options: ToolRegistrationBoundaryOptions
): ToolRegistrar {
  const { structuredOutput } = options

  const dispatchTool = async (
    name: string,
    tool: RegisteredTool,
    inputValue: unknown,
    context: ServerContext
  ): Promise<unknown> => {
    return withLogContext(
      { tool: name, mcp_request_id: context.mcpReq.id, tool_call_id: randomUUID() },
      async () => {
        const started = performance.now()
        log("info", "tool.started")
        const input = isRecord(inputValue) ? inputValue : {}
        const auditCall = options.auditRequest?.claimTool(context.mcpReq.id, name)
        let observedCallId: string | undefined

        try {
          const agent = getAgentIdentity()
          if (agent && name !== START_HERE_TOOL_NAME && !agent.taskSlug) {
            log("warn", "tool.rejected", { reason: "initialization_required" })
            const result = startupRequiredResult()
            auditCall?.finish({ toolResult: result, modelResult: result })
            return result
          }

          observedCallId = options.agentObserver?.startTool(agent, name, input)
          const result = await (tool.acceptsInput
            ? tool.callback(inputValue, context)
            : tool.callback(context))
          options.agentObserver?.finishTool(agent, observedCallId)

          const projected =
            !tool.nativeContent && !structuredOutput ? compactToolResult(name, result) : result
          const events = collectToolEvents(name, input, agent, options)
          const finalResult = appendToolEvents(projected, events)
          auditCall?.finish({ toolResult: result, modelResult: finalResult })
          logToolCompletion(result, started)
          return finalResult
        } catch (error) {
          log("error", "tool.failed", {
            err: error,
            duration_ms: Math.round(performance.now() - started),
          })
          const agent = getAgentIdentity()
          options.agentObserver?.failTool(agent, observedCallId)
          const result = toolError(error instanceof Error ? error.message : String(error))
          auditCall?.finish({ error, modelResult: result })
          return result
        }
      }
    )
  }

  const registerTool: ToolRegistrar = (name, config, callback) => {
    const { nativeContent = false, ...sdkConfig } = config
    prepareToolRegistration(sdkConfig, nativeContent || structuredOutput)
    const tool: RegisteredTool = {
      callback: (...args) => Reflect.apply(callback, undefined, args),
      acceptsInput: sdkConfig.inputSchema !== undefined,
      nativeContent,
    }
    const wrapped = tool.acceptsInput
      ? (inputValue: unknown, context: ServerContext) =>
          dispatchTool(name, tool, inputValue, context)
      : (context: ServerContext) => dispatchTool(name, tool, undefined, context)
    // Preserve the SDK's inputless/input callback conventions after generic type erasure.
    return Reflect.apply(server.registerTool, server, [name, sdkConfig, wrapped])
  }
  return registerTool
}

function logToolCompletion(result: unknown, started: number): void {
  const failed = isRecord(result) && result.isError === true
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : []
  const firstText = content.find((item) => isRecord(item) && item.type === "text")
  log(failed ? "warn" : "info", "tool.finished", {
    outcome: failed ? "error" : "completed",
    duration_ms: Math.round(performance.now() - started),
    error_message:
      failed && isRecord(firstText) && typeof firstText.text === "string"
        ? firstText.text.slice(0, 2048)
        : undefined,
  })
}

function collectToolEvents(
  name: string,
  input: Record<string, unknown>,
  agent: ReturnType<typeof getAgentIdentity>,
  options: ToolRegistrationBoundaryOptions
): string[] {
  return [
    ...(name === "shell_run" ? shellRunFileEditNotices(input) : []),
    ...(options.drainPendingEvents?.() ?? []),
    ...(options.agentObserver?.drainInstructions(agent) ?? []),
    ...(options.reviewPromptTracker?.() ?? []),
  ]
}

function toolError(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}

function startupRequiredResult() {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "Shellby has not been initialized for this conversation. Call `start_here` first, and follow the instructions.",
      },
    ],
  }
}
