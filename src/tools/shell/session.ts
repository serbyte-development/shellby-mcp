import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"

import { MCP_CONFIG } from "../../config.js"
import { tokenPrefix } from "../../tokenizer.js"
import { positiveInteger, utf8Chunk } from "../../utils.js"
import {
  DEFAULT_PARALLEL_COMMAND_TIMEOUT_MS,
  ParallelCommandAbortedError,
  type ParallelCommandExecutionResult,
  type ParallelCommandScheduler,
  type ParallelCommandSpec,
  type ParallelCommandStatus,
  executeParallelCommand,
  parseParallelCommandBatch,
  processParallelCommandScheduler,
} from "./parallel-runner.js"

type CommandStatus = "running" | "completed" | "shell_exited" | "reset"

export interface ShellSnapshot extends Record<string, unknown> {
  request_id: string
  status: CommandStatus
  exit_code: number | null
  cwd: string
  output: string
  next_cursor: number
  output_truncated: boolean
  cursor_expired: boolean
  output_dropped: boolean
  dropped_output_bytes: number
  commands?: ParallelCommandSnapshot[]
}

interface ParallelCommandSnapshot extends Record<string, unknown> {
  run: number
  path: string
  status: ParallelCommandStatus
  exit_code: number | null
  output_dropped?: true
  dropped_output_bytes?: number
}

export interface RunCommandInput {
  requestId: string
  command: string
  cwd?: string
  waitMs?: number
  maxOutputTokens?: number
  signal?: AbortSignal
}

export interface PollCommandInput {
  requestId: string
  cursor: number
  waitMs?: number
  maxOutputTokens?: number
  signal?: AbortSignal
}

export interface ResetShellInput {
  requestId: string
  reason?: string
}

export interface ShellSessionOptions {
  shellPath?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  transcriptLimit?: number
  commandTranscriptBytes?: number
  defaultOutputTokens?: number
  maxOutputTokens?: number
  recordLimit?: number
  parallelCommandTimeoutMs?: number
  parallelScheduler?: ParallelCommandScheduler
}

interface CommandRecord {
  requestId: string
  commandHash: string
  cwd: string
  startCursor: number
  endCursor: number | null
  status: CommandStatus
  exitCode: number | null
  markerPrefix: string
  capturedOutputBytes: number
  droppedOutputBytes: number
}

interface ParallelRunRecord {
  run: number
  command: string
  path: string
  cwd: string
  status: ParallelCommandStatus
  exitCode: number | null
  droppedOutputBytes: number
}

interface ParallelBatchRecord {
  requestId: string
  commandHash: string
  cwd: string
  transcript: TranscriptBuffer
  endCursor: number | null
  status: Extract<CommandStatus, "running" | "completed" | "reset">
  runs: ParallelRunRecord[]
  abortController: AbortController
  tasks: Promise<void>[]
}

interface ResetRecord {
  requestId: string
  reason: string
  promise: Promise<ResetResult>
}

export interface ResetResult extends Record<string, unknown> {
  request_id: string
  shell_generation: number
  state_lost: true
  status: "ready"
}

interface ReadyState {
  child: ChildProcessWithoutNullStreams
  marker: string
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ContextCaptureState {
  child: ChildProcessWithoutNullStreams
  startMarker: string
  endMarker: string
  started: boolean
  value: string
  resolve: (context: ShellContext) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ShellContext {
  cwd: string
  env: NodeJS.ProcessEnv
}

type StopReason = "reset" | "close"

export class ShellSessionError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "closed"
      | "invalid_command"
      | "request_conflict"
      | "request_not_found"
      | "invalid_cursor"
      | "shell_limit_reached"
      | "protected_shell"
      | "shell_unavailable",
    message: string
  ) {
    super(message)
    this.name = "ShellSessionError"
  }
}

class TranscriptBuffer {
  private value = ""
  private baseOffset = 0

  constructor(private readonly maxLength: number) {}

  get start(): number {
    return this.baseOffset
  }

  get end(): number {
    return this.baseOffset + this.value.length
  }

  append(chunk: string): void {
    if (chunk.length === 0) return

    this.value += chunk
    let overflow = this.value.length - this.maxLength
    if (overflow > 0) {
      if (overflow < this.value.length && isHighSurrogate(this.value.charCodeAt(overflow - 1)) && isLowSurrogate(this.value.charCodeAt(overflow))) {
        overflow += 1
      }
      this.value = this.value.slice(overflow)
      this.baseOffset += overflow
    }
  }

  read(
    cursor: number,
    maxTokens: number,
    upperBound?: number
  ): {
    output: string
    tokenCount: number
    nextCursor: number
    hasMore: boolean
    cursorExpired: boolean
  } {
    const availableEnd = Math.min(upperBound ?? this.end, this.end)
    const cursorExpired = cursor < this.start

    if (availableEnd <= this.start) {
      return {
        output: "",
        tokenCount: 0,
        nextCursor: availableEnd,
        hasMore: false,
        cursorExpired,
      }
    }

    const effectiveCursor = Math.min(Math.max(cursor, this.start), availableEnd)
    const localStart = effectiveCursor - this.start
    const localEnd = availableEnd - this.start
    const bounded = tokenPrefix(this.value.slice(localStart, localEnd), maxTokens)
    const output = bounded.value
    const nextCursor = effectiveCursor + output.length

    return {
      output,
      tokenCount: bounded.tokenCount,
      nextCursor,
      hasMore: nextCursor < availableEnd,
      cursorExpired,
    }
  }
}

export class PersistentShellSession {
  private readonly shellPath: string
  private readonly cwd: string
  private readonly env: NodeJS.ProcessEnv
  private readonly transcriptLimit: number
  private readonly transcript: TranscriptBuffer
  private readonly commandTranscriptBytes: number
  private readonly defaultOutputTokens: number
  private readonly maxOutputTokens: number
  private readonly recordLimit: number
  private readonly parallelCommandTimeoutMs: number
  private readonly parallelScheduler: ParallelCommandScheduler
  private readonly records = new Map<string, CommandRecord>()
  private readonly parallelRecords = new Map<string, ParallelBatchRecord>()
  private readonly resetRecords = new Map<string, ResetRecord>()
  private readonly stopReasons = new WeakMap<ChildProcessWithoutNullStreams, StopReason>()
  private readonly handledChildren = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly updateWaiters = new Set<() => void>()

  private child: ChildProcessWithoutNullStreams | null = null
  private active: CommandRecord | null = null
  private activeParallel: ParallelBatchRecord | null = null
  private readyState: ReadyState | null = null
  private contextCaptureState: ContextCaptureState | null = null
  private startPromise: Promise<void> | null = null
  private parserBuffer = ""
  private stdoutDecoder = new StringDecoder("utf8")
  private stderrDecoder = new StringDecoder("utf8")
  private generation = 1
  private currentCwd: string
  private updateVersion = 0
  private ready = false
  private closed = false
  private resetInFlight: ResetRecord | null = null

  constructor(options: ShellSessionOptions = {}) {
    this.shellPath = options.shellPath ?? MCP_CONFIG.shell.path
    this.cwd = options.cwd ?? process.cwd()
    this.currentCwd = this.cwd
    this.env = options.env ?? process.env
    this.transcriptLimit = positiveInteger(options.transcriptLimit, MCP_CONFIG.shell.transcriptChars)
    this.transcript = new TranscriptBuffer(this.transcriptLimit)
    this.commandTranscriptBytes = positiveInteger(options.commandTranscriptBytes, MCP_CONFIG.shell.commandTranscriptBytes)
    this.maxOutputTokens = positiveInteger(options.maxOutputTokens, MCP_CONFIG.shell.maxOutputTokens)
    this.defaultOutputTokens = positiveInteger(options.defaultOutputTokens, MCP_CONFIG.shell.defaultOutputTokens)
    if (this.defaultOutputTokens > this.maxOutputTokens) {
      throw new Error("defaultOutputTokens cannot exceed maxOutputTokens.")
    }
    this.recordLimit = positiveInteger(options.recordLimit, MCP_CONFIG.shell.recordLimit)
    this.parallelCommandTimeoutMs = positiveInteger(options.parallelCommandTimeoutMs, DEFAULT_PARALLEL_COMMAND_TIMEOUT_MS)
    this.parallelScheduler = options.parallelScheduler ?? processParallelCommandScheduler
  }

  get initialCwd(): string {
    return this.cwd
  }

  get hasActiveWork(): boolean {
    return (
      this.active !== null || this.activeParallel !== null || this.contextCaptureState !== null || this.resetInFlight !== null || this.startPromise !== null
    )
  }

  fork(): PersistentShellSession {
    return new PersistentShellSession({
      shellPath: this.shellPath,
      cwd: this.cwd,
      env: this.env,
      transcriptLimit: this.transcriptLimit,
      commandTranscriptBytes: this.commandTranscriptBytes,
      defaultOutputTokens: this.defaultOutputTokens,
      maxOutputTokens: this.maxOutputTokens,
      recordLimit: this.recordLimit,
      parallelCommandTimeoutMs: this.parallelCommandTimeoutMs,
      parallelScheduler: this.parallelScheduler,
    })
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new ShellSessionError("closed", "The shell session is closed.")
    }
    if (this.ready && this.child) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.spawnShell().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async runCommand(input: RunCommandInput): Promise<ShellSnapshot> {
    validateRequestId(input.requestId)
    validateCommand(input.command)
    const waitMs = normalizeWaitMs(input.waitMs)
    const maxOutputTokens = this.normalizeOutputTokens(input.maxOutputTokens)
    const commandHash = hashCommand(input.command, input.cwd)
    const parallelCommands = parseParallelCommand(input.command)

    await this.start()
    const existing = this.records.get(input.requestId)
    if (existing) {
      if (existing.commandHash !== commandHash) {
        throw new ShellSessionError("request_conflict", `request_id ${JSON.stringify(input.requestId)} was already used for a different command.`)
      }

      if (existing.status === "running") {
        await this.waitForCommandResult(existing, existing.startCursor, maxOutputTokens, waitMs, input.signal)
      }
      return this.snapshot(existing, existing.startCursor, maxOutputTokens)
    }
    const existingParallel = this.parallelRecords.get(input.requestId)
    if (existingParallel) {
      if (existingParallel.commandHash !== commandHash) {
        throw new ShellSessionError("request_conflict", `request_id ${JSON.stringify(input.requestId)} was already used for a different command.`)
      }
      if (existingParallel.status === "running") {
        await this.waitForParallelResult(existingParallel, 0, maxOutputTokens, waitMs, input.signal)
      }
      return this.parallelSnapshot(existingParallel, 0, maxOutputTokens)
    }

    if (this.resetInFlight) {
      throw new ShellSessionError("busy", `The shell is being reset by request_id ${JSON.stringify(this.resetInFlight.requestId)}.`)
    }

    if (this.active || this.activeParallel || this.contextCaptureState) {
      const requestId = this.active?.requestId ?? this.activeParallel?.requestId ?? "an internal shell operation"
      throw new ShellSessionError("busy", `The shell is busy with request_id ${JSON.stringify(requestId)}. Poll that request or reset the shell.`)
    }

    if (!this.child || !this.ready) {
      throw new ShellSessionError("shell_unavailable", "The shell process is not ready.")
    }
    validateWorkingDirectory(input.cwd)

    if (parallelCommands) {
      return this.runParallelCommands({
        input,
        commands: parallelCommands,
        commandHash,
        waitMs,
        maxOutputTokens,
      })
    }

    const child = this.child

    const token = randomUUID().replaceAll("-", "")
    const record: CommandRecord = {
      requestId: input.requestId,
      commandHash,
      cwd: input.cwd ?? this.currentCwd,
      startCursor: this.transcript.end,
      endCursor: null,
      status: "running",
      exitCode: null,
      markerPrefix: `\u001e__MCP_DONE_${token}__:`,
      capturedOutputBytes: 0,
      droppedOutputBytes: 0,
    }

    this.pruneCommandRecords()
    this.records.set(record.requestId, record)
    this.active = record
    try {
      await writeToStdin(child, buildCommandScript(input.command, token, input.cwd))
    } catch (error) {
      record.endCursor = this.transcript.end
      record.status = this.stopReasons.get(child) === "reset" ? "reset" : "shell_exited"
      if (this.active === record) this.active = null
      this.notifyUpdate()
      this.killProcessGroup(child, "SIGKILL")
      throw new ShellSessionError("shell_unavailable", `Could not write to the shell: ${errorMessage(error)}`)
    }

    await this.waitForCommandResult(record, record.startCursor, maxOutputTokens, waitMs, input.signal)
    return this.snapshot(record, record.startCursor, maxOutputTokens)
  }

  async pollCommand(input: PollCommandInput): Promise<ShellSnapshot> {
    validateRequestId(input.requestId)
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) {
      throw new ShellSessionError("invalid_cursor", "cursor must be a non-negative safe integer.")
    }

    const record = this.records.get(input.requestId)
    const parallelRecord = this.parallelRecords.get(input.requestId)
    if (!record && !parallelRecord) {
      throw new ShellSessionError("request_not_found", `No command exists for request_id ${JSON.stringify(input.requestId)}.`)
    }
    if (parallelRecord) {
      const waitMs = normalizeWaitMs(input.waitMs)
      const maxOutputTokens = this.normalizeOutputTokens(input.maxOutputTokens)
      const version = this.updateVersion
      const initialRead = parallelRecord.transcript.read(input.cursor, maxOutputTokens, parallelRecord.endCursor ?? undefined)
      if (parallelRecord.status === "running" && initialRead.output.length === 0 && !initialRead.cursorExpired) {
        await this.waitForUpdate(version, waitMs, input.signal)
      }
      return this.parallelSnapshot(parallelRecord, input.cursor, maxOutputTokens)
    }
    if (!record) throw new ShellSessionError("request_not_found", `No command exists for request_id ${JSON.stringify(input.requestId)}.`)
    if (input.cursor < record.startCursor) {
      throw new ShellSessionError("invalid_cursor", "cursor is before the requested command's output.")
    }

    const waitMs = normalizeWaitMs(input.waitMs)
    const maxOutputTokens = this.normalizeOutputTokens(input.maxOutputTokens)
    const version = this.updateVersion
    const initialRead = this.transcript.read(input.cursor, maxOutputTokens, record.endCursor ?? undefined)
    if (record.status === "running" && initialRead.output.length === 0 && !initialRead.cursorExpired) {
      await this.waitForUpdate(version, waitMs, input.signal)
    }

    return this.snapshot(record, input.cursor, maxOutputTokens)
  }

  private async runParallelCommands(options: {
    input: RunCommandInput
    commands: ParallelCommandSpec[]
    commandHash: string
    waitMs: number
    maxOutputTokens: number
  }): Promise<ShellSnapshot> {
    const rootCwd = options.input.cwd ?? this.currentCwd
    validateWorkingDirectory(rootCwd)
    const runs: ParallelRunRecord[] = options.commands.map((command, index) => {
      const cwd = resolve(rootCwd, command.path)
      validateWorkingDirectory(cwd)
      return {
        run: index + 1,
        command: command.command,
        path: command.path,
        cwd,
        status: "queued",
        exitCode: null,
        droppedOutputBytes: 0,
      }
    })

    const record: ParallelBatchRecord = {
      requestId: options.input.requestId,
      commandHash: options.commandHash,
      cwd: rootCwd,
      transcript: new TranscriptBuffer(this.transcriptLimit),
      endCursor: null,
      status: "running",
      runs,
      abortController: new AbortController(),
      tasks: [],
    }

    this.pruneParallelRecords()
    this.parallelRecords.set(record.requestId, record)
    this.activeParallel = record

    let context: ShellContext
    try {
      context = await this.captureShellContext(options.input.cwd)
    } catch (error) {
      if (record.status === "reset") {
        return this.parallelSnapshot(record, 0, options.maxOutputTokens)
      }
      this.parallelRecords.delete(record.requestId)
      if (this.activeParallel === record) this.activeParallel = null
      this.notifyUpdate()
      throw new ShellSessionError("shell_unavailable", `Could not capture the shell environment: ${errorMessage(error)}`)
    }

    record.cwd = context.cwd
    for (const run of record.runs) {
      run.cwd = resolve(context.cwd, run.path)
    }

    for (const run of record.runs) {
      const task = this.parallelScheduler
        .run(async () => {
          if (record.status !== "running") throw new ParallelCommandAbortedError()
          run.status = "running"
          this.notifyUpdate()
          return executeParallelCommand({
            shellPath: this.shellPath,
            command: run.command,
            cwd: run.cwd,
            env: context.env,
            outputLimitBytes: this.commandTranscriptBytes,
            timeoutMs: this.parallelCommandTimeoutMs,
            signal: record.abortController.signal,
          })
        }, record.abortController.signal)
        .then(
          (result) => this.finishParallelRun(record, run, result),
          (error) =>
            this.finishParallelRun(record, run, {
              status: error instanceof ParallelCommandAbortedError || record.abortController.signal.aborted ? "reset" : "failed",
              exitCode: null,
              output: error instanceof ParallelCommandAbortedError ? "" : errorMessage(error),
              droppedOutputBytes: 0,
            })
        )
      record.tasks.push(task)
    }

    await this.waitForParallelResult(record, 0, options.maxOutputTokens, options.waitMs, options.input.signal)
    return this.parallelSnapshot(record, 0, options.maxOutputTokens)
  }

  private finishParallelRun(record: ParallelBatchRecord, run: ParallelRunRecord, result: ParallelCommandExecutionResult): void {
    if (record.status === "reset" || run.status === "reset") return

    run.status = result.status
    run.exitCode = result.exitCode
    run.droppedOutputBytes = result.droppedOutputBytes
    record.transcript.append(formatParallelRunOutput(run, result.output))

    if (record.runs.every((candidate) => isParallelTerminal(candidate.status))) {
      record.status = "completed"
      record.endCursor = record.transcript.end
      if (this.activeParallel === record) this.activeParallel = null
    }
    this.notifyUpdate()
  }

  private parallelSnapshot(record: ParallelBatchRecord, cursor: number, maxOutputTokens: number): ShellSnapshot {
    const read = record.transcript.read(cursor, maxOutputTokens, record.endCursor ?? undefined)
    const droppedOutputBytes = record.runs.reduce((total, run) => Math.min(Number.MAX_SAFE_INTEGER, total + run.droppedOutputBytes), 0)
    const exitCode = record.status === "completed" ? (record.runs.every((run) => run.status === "completed" && run.exitCode === 0) ? 0 : 1) : null
    return {
      request_id: record.requestId,
      status: record.status,
      exit_code: exitCode,
      cwd: record.cwd,
      output: read.output,
      next_cursor: read.nextCursor,
      output_truncated: read.hasMore,
      cursor_expired: read.cursorExpired,
      output_dropped: droppedOutputBytes > 0,
      dropped_output_bytes: droppedOutputBytes,
      commands: record.runs.map((run) => ({
        run: run.run,
        path: run.path,
        status: run.status,
        exit_code: run.exitCode,
        ...(run.droppedOutputBytes > 0 ? { output_dropped: true as const, dropped_output_bytes: run.droppedOutputBytes } : {}),
      })),
    }
  }

  private async waitForParallelResult(
    record: ParallelBatchRecord,
    cursor: number,
    maxOutputTokens: number,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + waitMs
    while (record.status === "running" && !signal?.aborted) {
      const read = record.transcript.read(cursor, maxOutputTokens, record.endCursor ?? undefined)
      if (read.cursorExpired || read.hasMore || read.tokenCount >= maxOutputTokens) return
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return
      const version = this.updateVersion
      await this.waitForUpdate(version, remainingMs, signal)
    }
  }

  private async captureShellContext(cwd?: string): Promise<ShellContext> {
    if (!this.child || !this.ready) throw new Error("The shell process is not ready.")
    if (this.contextCaptureState) throw new Error("A shell context capture is already running.")
    const child = this.child
    const token = randomUUID().replaceAll("-", "")
    const startMarker = `\u001e__MCP_CONTEXT_${token}__\u001f`
    const endMarker = `\u001e__MCP_CONTEXT_END_${token}__\u001f`

    return new Promise<ShellContext>((resolveContext, rejectContext) => {
      const timer = setTimeout(() => {
        if (this.contextCaptureState?.child === child) this.contextCaptureState = null
        this.killProcessGroup(child, "SIGKILL")
        rejectContext(new Error(`Shell context capture did not complete within ${MCP_CONFIG.shell.readyTimeoutMs}ms.`))
      }, MCP_CONFIG.shell.readyTimeoutMs)
      this.contextCaptureState = {
        child,
        startMarker,
        endMarker,
        started: false,
        value: "",
        resolve: (context) => {
          this.currentCwd = context.cwd
          resolveContext(context)
        },
        reject: rejectContext,
        timer,
      }
      void writeToStdin(child, buildContextCaptureScript(token, cwd)).catch((error) => {
        clearTimeout(timer)
        if (this.contextCaptureState?.child === child) this.contextCaptureState = null
        rejectContext(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private async cancelActiveParallelBatch(): Promise<void> {
    const record = this.activeParallel
    if (!record || record.status !== "running") return
    record.status = "reset"
    for (const run of record.runs) {
      if (!isParallelTerminal(run.status)) {
        run.status = "reset"
        run.exitCode = null
        record.transcript.append(formatParallelRunOutput(run, ""))
      }
    }
    record.endCursor = record.transcript.end
    record.abortController.abort()
    if (this.activeParallel === record) this.activeParallel = null
    this.notifyUpdate()
    await Promise.allSettled(record.tasks)
  }

  async reset(input: ResetShellInput): Promise<ResetResult> {
    validateRequestId(input.requestId)
    if (this.closed) {
      throw new ShellSessionError("closed", "The shell session is closed.")
    }

    const reason = input.reason ?? "requested by MCP client"
    const existing = this.resetRecords.get(input.requestId)
    if (existing) {
      if (existing.reason !== reason) {
        throw new ShellSessionError("request_conflict", `request_id ${JSON.stringify(input.requestId)} was already used for a reset with a different reason.`)
      }
      return existing.promise
    }

    if (this.resetInFlight) {
      throw new ShellSessionError("busy", `The shell is already being reset by request_id ${JSON.stringify(this.resetInFlight.requestId)}.`)
    }

    this.pruneResetRecords()
    const promise = this.performReset(reason).then((result) => ({
      request_id: input.requestId,
      ...result,
    }))
    const record: ResetRecord = {
      requestId: input.requestId,
      reason,
      promise,
    }
    this.resetRecords.set(record.requestId, record)
    this.resetInFlight = record
    void promise.then(
      () => {
        if (this.resetInFlight === record) this.resetInFlight = null
      },
      () => {
        if (this.resetInFlight === record) this.resetInFlight = null
      }
    )
    return promise
  }

  private async performReset(reason: string): Promise<{
    shell_generation: number
    state_lost: true
    status: "ready"
  }> {
    await this.cancelActiveParallelBatch()
    const child = this.child
    if (child) {
      this.stopReasons.set(child, "reset")
      this.appendTranscript(`\n[mcp] Resetting shell: ${reason}\n`)
      await this.stopChild(child)
    } else {
      this.generation += 1
      this.ready = false
      this.appendTranscript(`\n[mcp] Resetting unavailable shell: ${reason}\n`)
      if (this.active) {
        this.active.status = "reset"
        this.active.endCursor = this.transcript.end
        this.active = null
      }
      this.notifyUpdate()
    }

    await this.start()
    return {
      shell_generation: this.generation,
      state_lost: true,
      status: "ready",
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    await this.cancelActiveParallelBatch()

    const child = this.child
    if (child) {
      this.stopReasons.set(child, "close")
      await this.stopChild(child)
    }

    for (const resolve of this.updateWaiters) resolve()
    this.updateWaiters.clear()
  }

  private async spawnShell(): Promise<void> {
    this.parserBuffer = ""
    this.stdoutDecoder = new StringDecoder("utf8")
    this.stderrDecoder = new StringDecoder("utf8")
    this.ready = false
    this.currentCwd = this.cwd

    const child = spawn("/bin/sh", ["-c", 'exec "$1" -l 2>&1', "mcp-shell", this.shellPath], {
      cwd: this.cwd,
      env: this.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return
      this.handleDecodedOutput(this.stdoutDecoder.write(chunk))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return
      this.handleDecodedOutput(this.stderrDecoder.write(chunk))
    })

    let terminationDescription = "unknown termination"
    let finalizeTimer: NodeJS.Timeout | null = null
    const scheduleForcedFinalization = (description: string) => {
      terminationDescription = description
      if (finalizeTimer) return
      finalizeTimer = setTimeout(() => {
        this.finalizeChild(child, terminationDescription)
      }, MCP_CONFIG.shell.stopGraceMs)
    }

    child.once("error", (error) => {
      scheduleForcedFinalization(`spawn error: ${error.message}`)
    })
    child.once("exit", (code, signal) => {
      scheduleForcedFinalization(signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`)
      if (!this.stopReasons.has(child)) {
        this.killProcessGroup(child, "SIGKILL")
      }
    })
    child.once("close", (code, signal) => {
      if (finalizeTimer) clearTimeout(finalizeTimer)
      const description =
        terminationDescription === "unknown termination" ? (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`) : terminationDescription
      this.finalizeChild(child, description)
    })

    const token = randomUUID().replaceAll("-", "")
    const marker = `\u001e__MCP_READY_${token}__\u001f`

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Shell did not become ready within ${MCP_CONFIG.shell.readyTimeoutMs}ms.`))
        this.killProcessGroup(child, "SIGKILL")
      }, MCP_CONFIG.shell.readyTimeoutMs)

      this.readyState = { child, marker, resolve, reject, timer }
      writeToStdin(child, [`builtin printf '\\036__MCP_READY_${token}__\\037'`, ""].join("\n")).catch((error) => {
        clearTimeout(timer)
        this.readyState = null
        reject(error instanceof Error ? error : new Error(String(error)))
        this.killProcessGroup(child, "SIGKILL")
      })
    })
  }

  private handleDecodedOutput(chunk: string): void {
    if (chunk.length === 0) return
    this.parserBuffer += chunk

    while (this.parserBuffer.length > 0) {
      const readyState = this.readyState
      if (readyState) {
        const markerIndex = this.parserBuffer.indexOf(readyState.marker)
        if (markerIndex < 0) {
          this.flushSafePrefix(readyState.marker)
          return
        }

        this.appendTranscript(this.parserBuffer.slice(0, markerIndex))
        this.parserBuffer = this.parserBuffer.slice(markerIndex + readyState.marker.length)
        clearTimeout(readyState.timer)
        this.readyState = null
        this.ready = true
        readyState.resolve()
        this.notifyUpdate()
        continue
      }

      const contextState = this.contextCaptureState
      if (contextState) {
        if (!contextState.started) {
          const markerIndex = this.parserBuffer.indexOf(contextState.startMarker)
          if (markerIndex < 0) {
            this.flushSafePrefix(contextState.startMarker)
            return
          }
          this.appendTranscript(this.parserBuffer.slice(0, markerIndex))
          this.parserBuffer = this.parserBuffer.slice(markerIndex + contextState.startMarker.length)
          contextState.started = true
        }

        const markerIndex = this.parserBuffer.indexOf(contextState.endMarker)
        if (markerIndex < 0) {
          this.flushContextCapturePrefix(contextState)
          return
        }

        contextState.value += this.parserBuffer.slice(0, markerIndex)
        this.parserBuffer = this.parserBuffer.slice(markerIndex + contextState.endMarker.length)
        clearTimeout(contextState.timer)
        this.contextCaptureState = null
        try {
          contextState.resolve(parseShellContext(contextState.value))
        } catch (error) {
          contextState.reject(error instanceof Error ? error : new Error(String(error)))
        }
        this.notifyUpdate()
        continue
      }

      const active = this.active
      if (!active) {
        this.appendTranscript(this.parserBuffer)
        this.parserBuffer = ""
        return
      }

      const markerIndex = this.parserBuffer.indexOf(active.markerPrefix)
      if (markerIndex < 0) {
        this.flushSafePrefix(active.markerPrefix, active)
        return
      }

      const markerEnd = this.parserBuffer.indexOf("\u001f", markerIndex + active.markerPrefix.length)
      if (markerEnd < 0) {
        this.appendCommandOutput(active, this.parserBuffer.slice(0, markerIndex))
        this.parserBuffer = this.parserBuffer.slice(markerIndex)
        return
      }

      const markerPayload = this.parserBuffer.slice(markerIndex + active.markerPrefix.length, markerEnd)
      const cwdSeparator = markerPayload.indexOf("\0")
      const statusText = markerPayload.slice(0, cwdSeparator)
      const parsedCwd = markerPayload.slice(cwdSeparator + 1)
      const parsedStatus = Number.parseInt(statusText, 10)
      if (cwdSeparator < 1 || !/^-?\d+$/.test(statusText) || !Number.isSafeInteger(parsedStatus) || !isAbsolute(parsedCwd)) {
        const falsePrefixEnd = markerIndex + active.markerPrefix.length
        this.appendCommandOutput(active, this.parserBuffer.slice(0, falsePrefixEnd))
        this.parserBuffer = this.parserBuffer.slice(falsePrefixEnd)
        continue
      }

      this.appendCommandOutput(active, this.parserBuffer.slice(0, markerIndex))
      this.parserBuffer = this.parserBuffer.slice(markerEnd + 1)
      active.endCursor = this.transcript.end
      active.exitCode = parsedStatus
      active.cwd = parsedCwd
      active.status = "completed"
      this.currentCwd = parsedCwd
      this.active = null
      this.notifyUpdate()
    }
  }

  private flushSafePrefix(marker: string, record?: CommandRecord): void {
    let safeLength = Math.max(0, this.parserBuffer.length - marker.length + 1)
    if (
      safeLength > 0 &&
      safeLength < this.parserBuffer.length &&
      isHighSurrogate(this.parserBuffer.charCodeAt(safeLength - 1)) &&
      isLowSurrogate(this.parserBuffer.charCodeAt(safeLength))
    ) {
      safeLength -= 1
    }
    if (safeLength === 0) return
    const output = this.parserBuffer.slice(0, safeLength)
    if (record) this.appendCommandOutput(record, output)
    else this.appendTranscript(output)
    this.parserBuffer = this.parserBuffer.slice(safeLength)
  }

  private flushContextCapturePrefix(state: ContextCaptureState): void {
    let safeLength = Math.max(0, this.parserBuffer.length - state.endMarker.length + 1)
    if (
      safeLength > 0 &&
      safeLength < this.parserBuffer.length &&
      isHighSurrogate(this.parserBuffer.charCodeAt(safeLength - 1)) &&
      isLowSurrogate(this.parserBuffer.charCodeAt(safeLength))
    ) {
      safeLength -= 1
    }
    if (safeLength === 0) return
    state.value += this.parserBuffer.slice(0, safeLength)
    this.parserBuffer = this.parserBuffer.slice(safeLength)
  }

  private finalizeChild(child: ChildProcessWithoutNullStreams, description: string): void {
    if (this.handledChildren.has(child)) return
    this.handledChildren.add(child)

    const reason = this.stopReasons.get(child)
    if (this.child === child) {
      const stdoutTail = this.stdoutDecoder.end()
      const stderrTail = this.stderrDecoder.end()
      if (stdoutTail) this.handleDecodedOutput(stdoutTail)
      if (stderrTail) this.handleDecodedOutput(stderrTail)
      if (this.parserBuffer) {
        if (this.active) this.appendCommandOutput(this.active, this.parserBuffer)
        else this.appendTranscript(this.parserBuffer)
        this.parserBuffer = ""
      }

      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.stdout.destroy()
      child.stderr.destroy()

      if (this.readyState?.child === child) {
        clearTimeout(this.readyState.timer)
        this.readyState.reject(new Error(`Shell exited before becoming ready (${description}).`))
        this.readyState = null
      }

      if (this.contextCaptureState?.child === child) {
        clearTimeout(this.contextCaptureState.timer)
        this.contextCaptureState.reject(new Error(`Shell exited during context capture (${description}).`))
        this.contextCaptureState = null
      }

      if (this.active) {
        this.active.endCursor = this.transcript.end
        this.active.status = reason === "reset" ? "reset" : "shell_exited"
        this.active.exitCode = null
        this.active = null
      }

      this.child = null
      this.ready = false

      if (reason !== "close") {
        this.generation += 1
        this.appendTranscript(`\n[mcp] Shell state lost (${reason ?? "unexpected"}: ${description}). Starting generation ${this.generation}.\n`)
      }
      this.notifyUpdate()
    }

    if (!reason) {
      this.killProcessGroup(child, "SIGKILL")
      if (!this.closed) {
        queueMicrotask(() => {
          if (this.closed) return
          void this.start().catch((error) => {
            this.appendTranscript(`\n[mcp] Shell restart failed: ${errorMessage(error)}\n`)
          })
        })
      }
    }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.killProcessGroup(child, "SIGTERM")
    await waitForExit(child, MCP_CONFIG.shell.stopGraceMs)
    this.killProcessGroup(child, "SIGKILL")
    if (!(await this.waitForChildClose(child, MCP_CONFIG.shell.stopGraceMs))) {
      this.finalizeChild(child, "forced shutdown timeout")
    }
  }

  private waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.handledChildren.has(child)) return Promise.resolve(true)

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off("close", onClose)
        resolve(false)
      }, timeoutMs)
      const onClose = () => {
        clearTimeout(timer)
        resolve(true)
      }
      child.once("close", onClose)
    })
  }

  private killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (!child.pid) return
    try {
      if (process.platform === "win32") child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch {
      // Process-group cleanup is best effort. A descendant with a different
      // effective user can make killpg return EPERM on macOS; cleanup must not
      // escape a child-process callback and crash the MCP server.
    }
  }

  private snapshot(record: CommandRecord, cursor: number, maxOutputTokens: number): ShellSnapshot {
    const read = this.transcript.read(cursor, maxOutputTokens, record.endCursor ?? undefined)
    return {
      request_id: record.requestId,
      status: record.status,
      exit_code: record.exitCode,
      cwd: record.cwd,
      output: read.output,
      next_cursor: read.nextCursor,
      output_truncated: read.hasMore,
      cursor_expired: read.cursorExpired,
      output_dropped: record.droppedOutputBytes > 0,
      dropped_output_bytes: record.droppedOutputBytes,
    }
  }

  private async waitForCommandResult(record: CommandRecord, cursor: number, maxOutputTokens: number, waitMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + waitMs

    while (record.status === "running" && !signal?.aborted) {
      const read = this.transcript.read(cursor, maxOutputTokens, record.endCursor ?? undefined)
      if (read.cursorExpired || read.hasMore || read.tokenCount >= maxOutputTokens) {
        return
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return

      const version = this.updateVersion
      await this.waitForUpdate(version, remainingMs, signal)
    }
  }

  private normalizeOutputTokens(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return this.defaultOutputTokens
    }
    return Math.min(Math.max(Math.trunc(value), 1), this.maxOutputTokens)
  }

  private pruneCommandRecords(): void {
    while (this.records.size >= this.recordLimit) {
      const oldestCompleted = [...this.records.values()].find((record) => record.status !== "running")
      if (!oldestCompleted) return
      this.records.delete(oldestCompleted.requestId)
    }
  }

  private pruneParallelRecords(): void {
    while (this.parallelRecords.size >= this.recordLimit) {
      const oldestCompleted = [...this.parallelRecords.values()].find((record) => record.status !== "running")
      if (!oldestCompleted) return
      this.parallelRecords.delete(oldestCompleted.requestId)
    }
  }

  private pruneResetRecords(): void {
    while (this.resetRecords.size >= this.recordLimit) {
      const oldestCompleted = [...this.resetRecords.values()].find((record) => record !== this.resetInFlight)
      if (!oldestCompleted) return
      this.resetRecords.delete(oldestCompleted.requestId)
    }
  }

  private appendTranscript(chunk: string): void {
    if (chunk.length === 0) return
    this.transcript.append(chunk)
    this.notifyUpdate()
  }

  private appendCommandOutput(record: CommandRecord, chunk: string): void {
    if (chunk.length === 0) return

    const remaining = Math.max(0, this.commandTranscriptBytes - record.capturedOutputBytes)
    const bounded = utf8Chunk(chunk, 0, remaining)
    const captured = bounded.value
    const dropped = chunk.slice(bounded.nextOffset)

    if (captured.length > 0) {
      record.capturedOutputBytes += Buffer.byteLength(captured, "utf8")
      this.appendTranscript(captured)
    }
    if (dropped.length > 0) {
      const wasTruncated = record.droppedOutputBytes > 0
      record.droppedOutputBytes = Math.min(Number.MAX_SAFE_INTEGER, record.droppedOutputBytes + Buffer.byteLength(dropped, "utf8"))
      if (!wasTruncated && captured.length === 0) this.notifyUpdate()
    }
  }

  private notifyUpdate(): void {
    this.updateVersion += 1
    const waiters = [...this.updateWaiters]
    this.updateWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  private async waitForUpdate(version: number, waitMs: number, signal?: AbortSignal): Promise<void> {
    if (waitMs === 0 || this.updateVersion !== version || signal?.aborted) {
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.updateWaiters.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      this.updateWaiters.add(done)
      signal?.addEventListener("abort", done, { once: true })
      if (this.updateVersion !== version || signal?.aborted) done()
    })
  }
}

function buildCommandScript(command: string, token: string, cwd?: string): string {
  return [
    "function __mcp_eval_command {",
    '  local __mcp_command="$1"',
    '  if (( $# > 1 )); then builtin cd -- "$2" || return $?; fi',
    '  builtin eval -- "$__mcp_command" </dev/null 1>&1 2>&1',
    "}",
    "set +e",
    `__mcp_eval_command ${singleQuote(command)}${cwd === undefined ? "" : ` ${singleQuote(cwd)}`}`,
    `builtin printf '\\036__MCP_DONE_${token}__:%s\\000%s\\037' "$?" "$PWD"`,
    "unfunction __mcp_eval_command 2>/dev/null",
    "set +e",
    "",
  ].join("\n")
}

function buildContextCaptureScript(token: string, cwd?: string): string {
  const functionName = `__mcp_capture_context_${token}`
  return [
    `function ${functionName} {`,
    '  if (( $# > 0 )); then builtin cd -- "$1" || return $?; fi',
    `  builtin printf '\\036__MCP_CONTEXT_${token}__\\037%s\\000' "$PWD"`,
    "  /usr/bin/env -0",
    `  builtin printf '\\036__MCP_CONTEXT_END_${token}__\\037'`,
    "}",
    "set +e",
    `${functionName}${cwd === undefined ? "" : ` ${singleQuote(cwd)}`}`,
    `unfunction ${functionName} 2>/dev/null`,
    "set +e",
    "",
  ].join("\n")
}

function parseShellContext(value: string): ShellContext {
  const cwdEnd = value.indexOf("\0")
  if (cwdEnd < 1) throw new Error("Shell context did not include a working directory.")
  const cwd = value.slice(0, cwdEnd)
  if (!isAbsolute(cwd)) throw new Error(`Shell context returned a non-absolute cwd: ${JSON.stringify(cwd)}.`)

  const env: NodeJS.ProcessEnv = {}
  for (const entry of value.slice(cwdEnd + 1).split("\0")) {
    if (entry.length === 0) continue
    const separator = entry.indexOf("=")
    if (separator < 1) continue
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  env.PWD = cwd
  return { cwd, env }
}

function parseParallelCommand(command: string): ParallelCommandSpec[] | null {
  try {
    return parseParallelCommandBatch(command)
  } catch (error) {
    throw new ShellSessionError("invalid_command", errorMessage(error))
  }
}

function isParallelTerminal(status: ParallelCommandStatus): boolean {
  return status !== "queued" && status !== "running"
}

function formatParallelRunOutput(run: ParallelRunRecord, output: string): string {
  const result = run.status === "completed" ? `exit=${run.exitCode ?? "n/a"}` : `status=${run.status}`
  const dropped = run.droppedOutputBytes > 0 ? ` dropped_bytes=${run.droppedOutputBytes}` : ""
  const body = output.length === 0 ? "" : `${output}${output.endsWith("\n") ? "" : "\n"}`
  return `[run ${run.run} path=${JSON.stringify(run.path)} ${result}${dropped}]\n${body}`
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function hashCommand(command: string, cwd?: string): string {
  return createHash("sha256")
    .update(JSON.stringify([cwd ?? null, command]))
    .digest("hex")
}

function validateWorkingDirectory(cwd: string | undefined): void {
  if (cwd === undefined) return
  if (!isAbsolute(cwd)) {
    throw new ShellSessionError("invalid_command", "cwd must be an absolute path.")
  }

  try {
    const entry = statSync(cwd)
    if (!entry.isDirectory()) {
      throw new ShellSessionError("invalid_command", `cwd is not a directory: ${JSON.stringify(cwd)}.`)
    }
  } catch (error) {
    if (error instanceof ShellSessionError) throw error
    throw new ShellSessionError("invalid_command", `cwd is not accessible: ${JSON.stringify(cwd)} (${errorMessage(error)}).`)
  }
}

function validateRequestId(requestId: string): void {
  if (requestId.length === 0 || requestId.length > 128) {
    throw new ShellSessionError("invalid_command", "request_id must contain between 1 and 128 characters.")
  }
}

function validateCommand(command: string): void {
  if (command.length === 0) {
    throw new ShellSessionError("invalid_command", "command cannot be empty.")
  }
  if (command.includes("\0")) {
    throw new ShellSessionError("invalid_command", "command cannot contain a NUL character.")
  }
}

function normalizeWaitMs(waitMs: number | undefined): number {
  const value = waitMs ?? MCP_CONFIG.shell.defaultWaitMs
  if (!Number.isFinite(value)) return MCP_CONFIG.shell.defaultWaitMs
  return Math.min(Math.max(Math.trunc(value), 0), MCP_CONFIG.shell.maxWaitMs)
}

function writeToStdin(child: ChildProcessWithoutNullStreams, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(value, "utf8", (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}
