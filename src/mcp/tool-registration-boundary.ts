import type {
  CallToolResult,
  ServerContext,
  StandardSchemaWithJSON,
  ToolCallback,
} from "@modelcontextprotocol/server"

import { getAgentIdentity } from "../agent/context.js"
import { stampAgentIdentity } from "../agent/identity-marker.js"
import type { AgentObserver } from "../agent/observer.js"
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
  reviewPrompt?: () => string[]
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
    const input = asRecord(inputValue) ?? {}
    const agent = getAgentIdentity()
    let projected: unknown
    try {
      const result = await server.calls.run(context, name, inputValue, async () => {
        if (agent && name !== START_HERE_TOOL_NAME && !agent.taskSlug) {
          throw new ToolError(
            "INITIALIZATION_REQUIRED",
            "Shellby has not been initialized for this conversation. Call `start_here` first, and follow the instructions."
          )
        }

        return tool.acceptsInput ? tool.callback(inputValue, context) : tool.callback(context)
      })
      projected =
        !tool.nativeContent && !structuredOutput ? compactToolResult(name, result) : result
    } catch (error) {
      projected = formatToolError(error, structuredOutput)
    }

    return stampAgentIdentity(
      appendToolEvents(projected, collectToolEvents(name, input, agent, options)),
      agent
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
    ...(options.reviewPrompt?.() ?? []),
  ]
}
