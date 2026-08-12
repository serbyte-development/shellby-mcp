import { appendFileSync } from "node:fs"

const MAX_INLINE_ARGUMENT_CHARS = 600
const MAX_SHELL_COMMAND_CHARS = 2_000
const MAX_FAILED_PATCH_CHARS = 32_000
const MAX_FAILED_MESSAGE_CHARS = 1_000
const LARGE_RESPONSE_BYTES = 8 * 1024
const SLOW_CALL_MS = 5_000

interface JsonRpcToolCall {
  method?: unknown
  params?: {
    name?: unknown
    arguments?: unknown
  }
}

export interface McpAuditCall {
  readonly needsResponseBody: boolean
  finish(input: { httpStatus: number; state: "finished" | "closed"; responseBytes: number; responseBody?: string }): void
}

export class McpAuditLogger {
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly clock: () => number = () => Date.now()
  ) {}

  startToolCalls(payload: unknown): McpAuditCall[] {
    const requests = Array.isArray(payload) ? payload : [payload]
    return requests.flatMap((request) => {
      const parsed = parseToolCall(request)
      if (!parsed) return []

      const startedAt = this.clock()
      const startedTime = this.now()
      let finished = false

      return [
        {
          needsResponseBody: parsed.name === "apply_patch" || parsed.name === "shell_run" || parsed.name === "shell_poll",
          finish: ({ httpStatus, state, responseBytes, responseBody }) => {
            if (finished) return
            finished = true
            const toolResponse = parseToolResponse(responseBody)
            this.append(
              formatEntry({
                time: startedTime,
                toolName: parsed.name,
                argumentsValue: parsed.arguments,
                durationMs: Math.max(0, this.clock() - startedAt),
                httpStatus,
                state,
                responseBytes,
                toolFailed: toolResponse.failed,
                failureMessage: toolResponse.failureMessage,
              })
            )
          },
        },
      ]
    })
  }

  private append(entry: string): void {
    try {
      appendFileSync(this.filePath, entry, "utf8")
    } catch (error) {
      console.warn(`Could not append MCP audit log: ${errorMessage(error)}`)
    }
  }
}

export function formatAuditTime(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`
}

export function characterCount(value: string): number {
  return Array.from(value).length
}

function formatEntry(input: {
  time: Date
  toolName: string
  argumentsValue: unknown
  durationMs: number
  httpStatus: number
  state: "finished" | "closed"
  responseBytes: number
  toolFailed: boolean
  failureMessage?: string
}): string {
  const abnormal = input.httpStatus >= 400 || input.state !== "finished" ? ` - HTTP ${input.httpStatus} ${input.state}` : ""
  const largeResponse = input.responseBytes >= LARGE_RESPONSE_BYTES ? ` - ${formatBytes(input.responseBytes)}` : ""
  const tag = auditTag(input)
  const tagPrefix = tag ? `${tag} ` : ""
  const heading = `--- # ${tagPrefix}${formatAuditTime(input.time)} - ${input.toolName} - ${input.durationMs}ms${largeResponse}${abnormal}`
  const details = formatArguments(input.toolName, input.argumentsValue, input.toolFailed, input.failureMessage)
  return details ? `${heading}\n${details}\n\n` : `${heading}\n\n`
}

function auditTag(input: { durationMs: number; httpStatus: number; state: "finished" | "closed"; responseBytes: number; toolFailed: boolean }): string {
  if (input.toolFailed || input.httpStatus >= 400 || input.state !== "finished") return "!"
  if (input.durationMs >= SLOW_CALL_MS) return "~"
  if (input.responseBytes >= LARGE_RESPONSE_BYTES) return "?"
  return ""
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kilobytes = bytes / 1024
  return `${kilobytes >= 10 ? Math.round(kilobytes) : kilobytes.toFixed(1)}KB`
}

function formatArguments(toolName: string, value: unknown, toolFailed: boolean, failureMessage?: string): string {
  const argumentsRecord = asRecord(value)

  if (toolName === "apply_patch" && argumentsRecord) {
    const patch = typeof argumentsRecord.patch === "string" ? argumentsRecord.patch : ""
    const cwd = typeof argumentsRecord.cwd === "string" ? argumentsRecord.cwd : ""
    const summary = `cwd: ${yamlString(cwd)}\npatch_chars: ${characterCount(patch)}`
    if (!toolFailed) return summary
    const message = failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
    return `${summary}${message}\npatch: |-\n${indentBlock(truncate(patch, MAX_FAILED_PATCH_CHARS))}`
  }

  if (toolName === "shell_run" && argumentsRecord) {
    const command = typeof argumentsRecord.command === "string" ? argumentsRecord.command : ""
    const shellId = typeof argumentsRecord.shell_id === "string" ? argumentsRecord.shell_id : "default"
    const requestId = typeof argumentsRecord.request_id === "string" ? argumentsRecord.request_id : ""
    const commandText = truncate(command, MAX_SHELL_COMMAND_CHARS)
    const cwd = typeof argumentsRecord.cwd === "string" ? `\ncwd: ${yamlString(argumentsRecord.cwd)}` : ""
    const message = toolFailed && failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
    return `shell: ${yamlString(`${shellId}/${requestId}`)}${cwd}${message}\ncommand: |-\n${indentBlock(commandText)}`
  }

  if (toolName === "shell_poll" && argumentsRecord) {
    const shellId = typeof argumentsRecord.shell_id === "string" ? argumentsRecord.shell_id : "default"
    const requestId = typeof argumentsRecord.request_id === "string" ? argumentsRecord.request_id : ""
    const cursor = typeof argumentsRecord.cursor === "number" ? argumentsRecord.cursor : 0
    const message = toolFailed && failureMessage ? `\nmessage: ${yamlString(truncate(failureMessage, MAX_FAILED_MESSAGE_CHARS))}` : ""
    return `shell: ${yamlString(`${shellId}/${requestId}`)}\ncursor: ${cursor}${message}`
  }

  const serialized = JSON.stringify(value ?? {})
  if (characterCount(serialized) <= MAX_INLINE_ARGUMENT_CHARS) {
    return `args: ${serialized}`
  }
  return `args: ${yamlString(truncate(serialized, MAX_INLINE_ARGUMENT_CHARS))}`
}

function parseToolResponse(responseBody: string | undefined): { failed: boolean; failureMessage?: string } {
  if (!responseBody) return { failed: false }
  const payloads = parseResponsePayloads(responseBody)
  for (const payload of payloads) {
    const responses = Array.isArray(payload) ? payload : [payload]
    for (const response of responses) {
      if (!response || typeof response !== "object" || Array.isArray(response)) continue
      const result = (response as { result?: unknown }).result
      if (!result || typeof result !== "object" || Array.isArray(result) || (result as { isError?: unknown }).isError !== true) continue
      const structuredContent = asRecord((result as { structuredContent?: unknown }).structuredContent)
      const output = structuredContent && typeof structuredContent.output === "string" ? structuredContent.output : undefined
      if (output) return { failed: true, failureMessage: output }
      const content = (result as { content?: unknown }).content
      if (Array.isArray(content)) {
        const message = content
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== undefined)
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text as string)
          .join("\n")
        if (message) return { failed: true, failureMessage: message }
      }
      return { failed: true }
    }
  }
  return { failed: responseBody.includes('"isError":true') }
}

function parseResponsePayloads(responseBody: string): unknown[] {
  try {
    return [JSON.parse(responseBody) as unknown]
  } catch {
    const payloads: unknown[] = []
    for (const line of responseBody.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      const data = line.slice("data:".length).trim()
      if (!data || data === "[DONE]") continue
      try {
        payloads.push(JSON.parse(data) as unknown)
      } catch {
        // Ignore malformed or non-JSON SSE data and fall back to isError detection.
      }
    }
    return payloads
  }
}

function indentBlock(content: string): string {
  return content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function truncate(value: string, maxChars: number): string {
  const characters = Array.from(value)
  if (characters.length <= maxChars) return value
  const omitted = characters.length - maxChars
  return `${characters.slice(0, maxChars).join("")}… [${omitted} chars omitted]`
}

function parseToolCall(value: unknown): { name: string; arguments?: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const request = value as JsonRpcToolCall
  if (request.method !== "tools/call") return undefined
  const name = request.params?.name
  if (typeof name !== "string" || !name) return undefined
  return { name, arguments: request.params?.arguments }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
