import { spawn, type ChildProcess } from "node:child_process"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"

export const DEFAULT_PARALLEL_COMMAND_LIMIT = 4
export const DEFAULT_PARALLEL_COMMAND_TIMEOUT_MS = 10 * 60 * 1000

const STOP_GRACE_MS = 500

export interface ParallelCommandSpec {
  command: string
  path?: string
}

export type ParallelCommandStatus = "queued" | "running" | "completed" | "timed_out" | "failed" | "reset"

export interface ParallelCommandExecutionResult {
  status: Extract<ParallelCommandStatus, "completed" | "timed_out" | "failed" | "reset">
  exitCode: number | null
  output: string
  droppedOutputBytes: number
}

export interface ExecuteParallelCommandInput {
  shellPath: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  outputLimitBytes: number
  timeoutMs: number
  signal: AbortSignal
}

interface QueuedTask<T> {
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class ParallelCommandScheduler {
  private active = 0
  private readonly queue: QueuedTask<unknown>[] = []

  constructor(readonly maximumConcurrency = DEFAULT_PARALLEL_COMMAND_LIMIT) {
    if (!Number.isSafeInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new Error("maximumConcurrency must be a positive safe integer.")
    }
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new ParallelCommandAbortedError())

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask<T> = {
        task,
        resolve,
        reject,
        signal,
      }
      if (signal) {
        queued.onAbort = () => {
          const index = this.queue.indexOf(queued as QueuedTask<unknown>)
          if (index < 0) return
          this.queue.splice(index, 1)
          reject(new ParallelCommandAbortedError())
        }
        signal.addEventListener("abort", queued.onAbort, { once: true })
      }
      this.queue.push(queued as QueuedTask<unknown>)
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.maximumConcurrency && this.queue.length > 0) {
      const queued = this.queue.shift()!
      if (queued.onAbort) queued.signal?.removeEventListener("abort", queued.onAbort)
      if (queued.signal?.aborted) {
        queued.reject(new ParallelCommandAbortedError())
        continue
      }

      this.active += 1
      void queued
        .task()
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }
}

export const processParallelCommandScheduler = new ParallelCommandScheduler()

export class ParallelCommandAbortedError extends Error {
  constructor() {
    super("Parallel command was aborted before it could run.")
    this.name = "ParallelCommandAbortedError"
  }
}

export function parseParallelCommandEnvelope(value: string): ParallelCommandSpec[] | null {
  const normalized = value.replaceAll("\r\n", "\n").trimStart()
  if (!normalized.startsWith("*** Begin Commands")) return null
  const lines = normalized.split("\n")
  if (lines[0] !== "*** Begin Commands") {
    throw new Error("The first line of a parallel command batch must be '*** Begin Commands'.")
  }

  let endIndex = lines.length - 1
  while (endIndex > 0 && lines[endIndex] === "") endIndex -= 1
  if (lines[endIndex] !== "*** End Commands") {
    throw new Error("The last line of a parallel command batch must be '*** End Commands'.")
  }

  const commands: ParallelCommandSpec[] = []
  let index = 1
  while (index < endIndex) {
    const marker = parseRunMarker(lines[index]!)
    if (!marker) {
      throw new Error(`Expected '*** Run' or '*** Run: relative/path' on line ${index + 1}.`)
    }
    index += 1

    const bodyStart = index
    while (index < endIndex && !isRunMarker(lines[index]!)) index += 1
    const command = lines.slice(bodyStart, index).join("\n")
    if (command.trim().length === 0) {
      throw new Error(`Run ${commands.length + 1} has no command.`)
    }
    commands.push({ command, ...(marker.path === undefined ? {} : { path: marker.path }) })
  }

  if (commands.length === 0) {
    throw new Error("A parallel command batch must contain at least one '*** Run' section.")
  }
  return commands
}

export function executeParallelCommand(input: ExecuteParallelCommandInput): Promise<ParallelCommandExecutionResult> {
  if (input.signal.aborted) {
    return Promise.resolve({ status: "reset", exitCode: null, output: "", droppedOutputBytes: 0 })
  }

  return new Promise((resolve) => {
    const output = new BoundedOutput(input.outputLimitBytes)
    const stdoutDecoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")
    let child: ChildProcess
    let settled = false
    let timeoutRequested = false
    let resetRequested = false
    let forceTimer: NodeJS.Timeout | null = null
    let timeoutTimer: NodeJS.Timeout | null = null

    const finish = (status: ParallelCommandExecutionResult["status"], exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (forceTimer) clearTimeout(forceTimer)
      input.signal.removeEventListener("abort", onAbort)
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      if (stdoutTail) output.append(stdoutTail)
      if (stderrTail) output.append(stderrTail)
      resolve({ status, exitCode, output: output.value, droppedOutputBytes: output.droppedBytes })
    }

    const stop = () => {
      killProcessGroup(child, "SIGTERM")
      if (forceTimer) clearTimeout(forceTimer)
      forceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL")
        finish(resetRequested ? "reset" : "timed_out", null)
      }, STOP_GRACE_MS)
      forceTimer.unref()
    }

    const onAbort = () => {
      resetRequested = true
      stop()
    }

    try {
      child = spawn(input.shellPath, ["-c", input.command], {
        cwd: input.cwd,
        env: input.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({
        status: "failed",
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
        droppedOutputBytes: 0,
      })
      return
    }

    child.stdout?.on("data", (chunk: Buffer) => output.append(stdoutDecoder.write(chunk)))
    child.stderr?.on("data", (chunk: Buffer) => output.append(stderrDecoder.write(chunk)))
    child.once("error", (error) => {
      output.append(error.message)
      killProcessGroup(child, "SIGKILL")
      finish(resetRequested ? "reset" : timeoutRequested ? "timed_out" : "failed", null)
    })
    child.once("exit", () => {
      // The shell may exit while background descendants still hold its stdio
      // pipes open. Kill the process group here instead of waiting for close.
      killProcessGroup(child, "SIGKILL")
    })
    child.once("close", (code) => {
      finish(resetRequested ? "reset" : timeoutRequested ? "timed_out" : "completed", resetRequested || timeoutRequested ? null : code)
    })

    input.signal.addEventListener("abort", onAbort, { once: true })
    if (input.signal.aborted) onAbort()
    timeoutTimer = setTimeout(() => {
      timeoutRequested = true
      stop()
    }, input.timeoutMs)
    timeoutTimer.unref()
  })
}

function parseRunMarker(line: string): { path?: string } | null {
  if (line === "*** Run") return {}
  if (!line.startsWith("*** Run: ")) return null
  const path = line.slice("*** Run: ".length).trim()
  if (path.length === 0) throw new Error("A '*** Run:' path cannot be empty.")
  if (isAbsolute(path)) throw new Error(`Parallel run paths must be relative to cwd: ${JSON.stringify(path)}.`)
  return { path }
}

function isRunMarker(line: string): boolean {
  return line === "*** Run" || line.startsWith("*** Run: ")
}

class BoundedOutput {
  value = ""
  capturedBytes = 0
  droppedBytes = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) return
    const remaining = Math.max(0, this.maxBytes - this.capturedBytes)
    const capturedEnd = utf8BoundedEnd(chunk, remaining)
    const captured = chunk.slice(0, capturedEnd)
    const dropped = chunk.slice(capturedEnd)
    if (captured.length > 0) {
      this.value += captured
      this.capturedBytes += Buffer.byteLength(captured, "utf8")
    }
    if (dropped.length > 0) {
      this.droppedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.droppedBytes + Buffer.byteLength(dropped, "utf8"))
    }
  }
}

function utf8BoundedEnd(value: string, maxBytes: number): number {
  let offset = 0
  let bytes = 0
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset)
    if (codePoint === undefined) break
    const codeUnits = codePoint > 0xffff ? 2 : 1
    const codePointBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + codePointBytes > maxBytes) break
    bytes += codePointBytes
    offset += codeUnits
  }
  return offset
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // Child cleanup is best effort for the same reason as persistent-shell cleanup.
  }
}
