import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"
import pino, { type Logger } from "pino"
import pinoRoll from "pino-roll"
import { getAgentIdentity } from "./agent/context.js"
import { getTimeStamp } from "./time.js"

type LogLevel = "info" | "warn" | "error" | "fatal"
type LogFields = Record<string, unknown>

const context = new AsyncLocalStorage<LogFields>()
let logger: Logger | undefined
let reportedFailure = false

/** Operational events are best effort; importing this module opens no files. */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  try {
    logger?.[level](fields, event)
  } catch (error) {
    reportLoggingFailure(error)
  }
}

/** Nested operations inherit request identity; async continuations retain their origin. */
export function withLogContext<T>(fields: LogFields, operation: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, operation)
}

export function runtimeLogPath(stateDir: string): string {
  return join(stateDir, "logs", "current.log")
}

/** One writer per backend process. Close after services settle to flush pending events. */
export async function startRuntimeLogging(stateDir: string): Promise<{
  path: string
  close: () => Promise<void>
}> {
  const path = runtimeLogPath(stateDir)
  const options = {
    base: { pid: process.pid, run_id: randomUUID() },
    timestamp: () => `,"time":${JSON.stringify(getTimeStamp())}`,
    serializers: { err: serializeError },
    redact: ["password", "token", "authorization", "cookie"],
    mixin: () => {
      const agent = getAgentIdentity()
      return { ...context.getStore(), agent: agent?.agent, task: agent?.taskSlug }
    },
  }
  reportedFailure = false
  // Also covers unavailable state directories and later file/rotation errors.
  const fallback = pino(options, pino.destination({ dest: 2, sync: true }))
  logger = fallback
  let destination: Awaited<ReturnType<typeof pinoRoll>> | undefined
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    destination = await pinoRoll({
      file: join(dirname(path), "runtime.jsonl"),
      size: "10m",
      limit: { count: 5, removeOtherLogFiles: true },
      symlink: true,
      mode: 0o600,
      maxLength: 1024 * 1024,
    })
    const stream = destination
    stream.on("error", (error: Error) => {
      logger = fallback
      reportLoggingFailure(error)
      destination = undefined
      stream.destroy()
    })
    stream.on("drop", () =>
      reportLoggingFailure(new Error("Runtime log buffer full; records dropped."))
    )
    await once(stream, "ready")
    logger = pino(options, stream)
  } catch (error) {
    reportLoggingFailure(error)
  }

  const onFatalError = (error: Error, origin: string) => {
    log("fatal", "process.uncaught_exception", { err: error, origin })
    try {
      destination?.flushSync()
    } catch (flushError) {
      reportLoggingFailure(flushError)
    }
  }
  process.on("uncaughtExceptionMonitor", onFatalError)
  return {
    path,
    close: async () => {
      process.off("uncaughtExceptionMonitor", onFatalError)
      const stream = destination
      destination = undefined
      if (stream) {
        try {
          const closed = once(stream, "close")
          stream.end()
          await closed
        } catch (error) {
          reportLoggingFailure(error)
        }
      }
      logger = undefined
    },
  }
}

// Keep diagnostic messages and causes while excluding arbitrary Error payloads.
function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error).slice(0, 4096) }
  return {
    type: error.name,
    message: error.message.slice(0, 4096),
    stack: error.stack?.slice(0, 8192),
    code: "code" in error ? String(error.code).slice(0, 128) : undefined,
    cause:
      depth < 3 && error.cause !== undefined ? serializeError(error.cause, depth + 1) : undefined,
  }
}

function reportLoggingFailure(error: unknown): void {
  if (reportedFailure) return
  reportedFailure = true
  try {
    process.stderr.write(`Shellby runtime logging failure: ${String(error).slice(0, 1024)}\n`)
  } catch {
    // The logging fallback must preserve the original operation's outcome.
  }
}
