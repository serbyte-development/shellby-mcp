import { appendFileSync } from "node:fs"

interface JsonRpcToolCall {
  method?: unknown
  params?: {
    name?: unknown
    arguments?: unknown
  }
}

export interface McpAuditCall {
  requestIdKey: string
  finish(input: { httpStatus: number; state: "finished" | "closed"; outputChars: number }): void
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
      const serializedArguments = JSON.stringify(parsed.arguments ?? {})
      this.append(formatCallEntry(compactTimestamp(this.now()), parsed.name, parsed.arguments, characterCount(serializedArguments)))

      let finished = false
      return [
        {
          requestIdKey: jsonRpcIdKey(parsed.id),
          finish: ({ httpStatus, state, outputChars }) => {
            if (finished) return
            finished = true
            const durationMs = Math.max(0, this.clock() - startedAt)
            this.append(
              `${compactTimestamp(this.now())}\tRESULT\t${parsed.name}\tchars=${outputChars}\tduration_ms=${durationMs}\thttp_status=${httpStatus}\tstate=${state}\n\n`
            )
          },
        },
      ]
    })
  }

  private append(line: string): void {
    try {
      appendFileSync(this.filePath, line, "utf8")
    } catch (error) {
      console.warn(`Could not append MCP audit log: ${errorMessage(error)}`)
    }
  }
}

export function compactTimestamp(date: Date): string {
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][date.getMonth()]
  return `${month}-${date.getDate()}-${date.getHours()}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`
}

export function extractResultCharacterCounts(payload: string): Map<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return new Map()
  }

  const responses = Array.isArray(parsed) ? parsed : [parsed]
  const counts = new Map<string, number>()
  for (const response of responses) {
    if (!response || typeof response !== "object" || Array.isArray(response)) continue
    const record = response as Record<string, unknown>
    if (!("result" in record) && !("error" in record)) continue
    const value = "result" in record ? record.result : record.error
    const serialized = JSON.stringify(value ?? null)
    counts.set(jsonRpcIdKey(record.id), characterCount(serialized))
  }
  return counts
}

export function characterCount(value: string): number {
  return Array.from(value).length
}

function formatCallEntry(timestamp: string, toolName: string, argumentsValue: unknown, inputChars: number): string {
  const argumentsRecord = asRecord(argumentsValue)
  if (toolName === "apply_patch" && argumentsRecord) {
    const { patch, ...metadata } = argumentsRecord
    const patchChars = typeof patch === "string" ? characterCount(patch) : 0
    return `${timestamp}\tCALL\t${toolName}\tchars=${inputChars}\tpatch_chars=${patchChars}\t${JSON.stringify(metadata)}\n`
  }

  if (toolName === "shell_run" && argumentsRecord) {
    const { command, ...metadata } = argumentsRecord
    const commandText = typeof command === "string" ? command : ""
    return [
      `${timestamp}\tCALL\t${toolName}\tchars=${inputChars}\t${JSON.stringify(metadata)}`,
      `COMMAND\tchars=${characterCount(commandText)}`,
      commandText,
      "END COMMAND",
      "",
    ].join("\n")
  }

  return `${timestamp}\tCALL\t${toolName}\tchars=${inputChars}\t${JSON.stringify(argumentsValue ?? {})}\n`
}

function parseToolCall(value: unknown): { id?: unknown; name: string; arguments?: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const request = value as JsonRpcToolCall & { id?: unknown }
  if (request.method !== "tools/call") return undefined
  const name = request.params?.name
  if (typeof name !== "string" || !name) return undefined
  return { id: request.id, name, arguments: request.params?.arguments }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function jsonRpcIdKey(id: unknown): string {
  if (typeof id === "string" || typeof id === "number") return String(id)
  return JSON.stringify(id ?? null)
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
