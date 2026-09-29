import type {
  CallToolResult,
  ServerContext,
  StandardSchemaWithJSON,
  ToolCallback,
} from "@modelcontextprotocol/server"

import { getAgentIdentity } from "../agent/context.js"
import { stampAgentIdentity } from "../agent/identity-marker.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import { withAuditCall } from "../server/audit/audit-request.js"
import type { ReviewPromptTracker } from "../tools/review/review-tool.js"
import { shellRunFileEditNotices } from "../tools/shell/apply-patch-guidance.js"
import { START_HERE_TOOL_NAME } from "../tools/start-here/start-here.js"
import { asRecord } from "../utils.js"
import type { ObservedMcpServer } from "./observed-server.js"
import { ToolError } from "./tool-error.js"
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
  Parameters<ObservedMcpServer["registerTool"]>[1],
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
) => ReturnType<ObservedMcpServer["registerTool"]>

interface RegisteredTool {
  acceptsInput: boolean
  nativeContent: boolean
  callback: (...args: unknown[]) => unknown
}

/** Register tools through Shellby's execution policy; the SDK owns validation and projection. */
export function createToolRegistrar(
  server: ObservedMcpServer,
  options: ToolRegistrationBoundaryOptions
): ToolRegistrar {
  const { structuredOutput } = options

  const dispatchTool = async (
    name: string,
    tool: RegisteredTool,
    inputValue: unknown,
    context: ServerContext
  ): Promise<unknown> => {
    const auditCall = options.auditRequest?.claimTool(context.mcpReq.id, name)
    return withAuditCall(auditCall, async () => {
      const input = asRecord(inputValue) ?? {}
      let observedCallId: string | undefined
      let result: unknown
      let projected: unknown
      let failure: unknown
      const agent = getAgentIdentity()

      try {
        observedCallId = options.agentObserver?.startTool(agent, name, input)
        if (agent && name !== START_HERE_TOOL_NAME && !agent.taskSlug) {
          throw new ToolError(
            "INITIALIZATION_REQUIRED",
            "Shellby has not been initialized for this conversation. Call `start_here` first, and follow the instructions."
          )
        }

        result = await (tool.acceptsInput
          ? tool.callback(inputValue, context)
          : tool.callback(context))
        projected =
          !tool.nativeContent && !structuredOutput ? compactToolResult(name, result) : result
      } catch (error) {
        failure = error
        result = formatToolError(error, structuredOutput)
        projected = result
      }

      if (options.agentObserver || auditCall) {
        server.observeToolResponse(context, (message) => {
          if (!message) {
            options.agentObserver?.failTool(agent, observedCallId)
            auditCall?.finish({ error: new Error("MCP request ended without a response.") })
            return
          }
          const response =
            "result" in message
              ? message.result
              : { isError: true, content: [{ type: "text", text: message.error.message }] }
          const failed = asRecord(response)?.isError === true
          if (failed) options.agentObserver?.failTool(agent, observedCallId, response)
          else options.agentObserver?.finishTool(agent, observedCallId, response)
          // A schema/protocol rejection replaces a successful handler result. Audit the
          // error the SDK sent, preserving original handler diagnostics for ordinary failures.
          const rejected = failed && asRecord(result)?.isError !== true
          auditCall?.finish({
            toolResult: rejected ? response : result,
            modelResult: response,
            error: failure,
          })
        })
      }

      return stampAgentIdentity(
        appendToolEvents(projected, collectToolEvents(name, input, agent, options)),
        agent
      )
    })
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

/** Render failures directly; native-content policy applies only to returned tool results. */
function formatToolError(error: unknown, structuredOutput: boolean): CallToolResult {
  const code = error instanceof ToolError ? error.code : "internal_error"
  const message = error instanceof Error ? error.message : String(error)
  return {
    isError: true,
    ...(structuredOutput ? { structuredContent: { error_code: code } } : {}),
    content: [{ type: "text", text: `${code}: ${message}` }],
  }
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
