import { appendFileSync, chmodSync, existsSync } from "node:fs"

import type { CompletedToolCall } from "../../mcp/tool-call-tracker.js"
import { getTimeStamp } from "../../time.js"
import { countTokens } from "../../tokenizer.js"
import {
  errorMessage,
  formatAuditEntry,
  formatFailureMessages,
  originalErrorMessage,
  summarizeToolResult,
} from "./audit-format.js"
export class McpAuditLogger {
  constructor(private readonly filePath: string) {
    try {
      if (existsSync(this.filePath)) chmodSync(this.filePath, 0o600)
    } catch (error) {
      console.warn(`Could not secure MCP audit log: ${errorMessage(error)}`)
    }
  }

  /** Persist one completed record; call tracking and deduplication belong to ToolCallTracker. */
  recordToolCall(call: CompletedToolCall): void {
    const toolResponse = summarizeToolResult(call)
    const output = toolResponse.structuredContent?.output
    const exitCode = toolResponse.structuredContent?.exit_code
    // Nonzero shell exits are audit annotations even when MCP returns a successful tool result.
    const shellFailed =
      (call.tool === "shell_run" || call.tool === "shell_poll") &&
      typeof exitCode === "number" &&
      exitCode !== 0
    let failureMessage = call.errors.length
      ? formatFailureMessages(call.errors.map(originalErrorMessage))
      : toolResponse.failureMessage
    if (!failureMessage && shellFailed) {
      failureMessage =
        typeof output === "string" && output.trim()
          ? output.trim()
          : `Command exited with code ${exitCode}.`
    }
    let agentLabel = call.agent?.agent
    if (agentLabel && call.taskSlugAtStart) agentLabel += `/${call.taskSlugAtStart}`
    this.append(
      formatAuditEntry({
        timestamp: getTimeStamp(call.startedAt),
        toolName: call.tool,
        argumentsValue: call.input,
        durationMs: Math.max(0, call.finishedAt - call.startedAt),
        httpStatus: call.httpStatus ?? 200,
        state: call.transportState ?? "finished",
        inputTokens: countTokens(JSON.stringify(call.input ?? {})),
        outputTokens:
          toolResponse.modelOutput !== undefined
            ? countTokens(toolResponse.modelOutput)
            : undefined,
        toolFailed: call.status === "failed" || shellFailed,
        failureMessage,
        responseSummary: toolResponse,
        agentLabel,
      })
    )
  }

  recordToolsList(at: number): void {
    this.append(`--- # tools/list - ${getTimeStamp(at)}\n`)
  }

  private append(entry: string): void {
    try {
      appendFileSync(this.filePath, entry, { encoding: "utf8", mode: 0o600 })
      chmodSync(this.filePath, 0o600)
    } catch (error) {
      console.warn(`Could not update MCP audit log: ${errorMessage(error)}`)
    }
  }
}
