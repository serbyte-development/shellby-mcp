import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TRANSCRIPT_LIMIT = 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_WAIT_MS = 1_500;
const MAX_WAIT_MS = 10_000;
const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 500;
const DEFAULT_RECORD_LIMIT = 1_024;

export type CommandStatus =
  | "running"
  | "completed"
  | "shell_exited"
  | "reset";

export interface ShellSnapshot extends Record<string, unknown> {
  request_id: string;
  status: CommandStatus;
  exit_code: number | null;
  output: string;
  next_cursor: number;
  has_more: boolean;
  cursor_expired: boolean;
}

export interface RunCommandInput {
  requestId: string;
  command: string;
  waitMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface PollCommandInput {
  requestId: string;
  cursor: number;
  waitMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ResetShellInput {
  requestId: string;
  reason?: string;
}

export interface ShellSessionOptions {
  shellPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pathPrepend?: string[];
  transcriptLimit?: number;
  defaultOutputBytes?: number;
  maxOutputBytes?: number;
  recordLimit?: number;
  logCommands?: boolean;
  logger?: (message: string) => void;
}

interface CommandRecord {
  requestId: string;
  commandHash: string;
  startCursor: number;
  endCursor: number | null;
  status: CommandStatus;
  exitCode: number | null;
  markerPrefix: string;
}

interface ResetRecord {
  requestId: string;
  reason: string;
  promise: Promise<ResetResult>;
}

export interface ResetResult extends Record<string, unknown> {
  request_id: string;
  shell_generation: number;
  state_lost: true;
  status: "ready";
}

interface ReadyState {
  child: ChildProcessWithoutNullStreams;
  marker: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type StopReason = "reset" | "close";

export class ShellSessionError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "closed"
      | "invalid_command"
      | "request_conflict"
      | "request_not_found"
      | "invalid_cursor"
      | "shell_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ShellSessionError";
  }
}

class TranscriptBuffer {
  private value = "";
  private baseOffset = 0;

  constructor(private readonly maxLength: number) {}

  get start(): number {
    return this.baseOffset;
  }

  get end(): number {
    return this.baseOffset + this.value.length;
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;

    this.value += chunk;
    const overflow = this.value.length - this.maxLength;
    if (overflow > 0) {
      this.value = this.value.slice(overflow);
      this.baseOffset += overflow;
    }
  }

  read(cursor: number, maxBytes: number, upperBound?: number): {
    output: string;
    nextCursor: number;
    hasMore: boolean;
    cursorExpired: boolean;
  } {
    const availableEnd = Math.min(upperBound ?? this.end, this.end);
    const cursorExpired = cursor < this.start;

    if (availableEnd <= this.start) {
      return {
        output: "",
        nextCursor: availableEnd,
        hasMore: false,
        cursorExpired,
      };
    }

    const effectiveCursor = Math.min(
      Math.max(cursor, this.start),
      availableEnd,
    );
    const localStart = effectiveCursor - this.start;
    const localEnd = availableEnd - this.start;
    const outputEnd = utf8BoundedEnd(this.value, localStart, localEnd, maxBytes);
    const output = this.value.slice(localStart, outputEnd);
    const nextCursor = effectiveCursor + output.length;

    return {
      output,
      nextCursor,
      hasMore: nextCursor < availableEnd,
      cursorExpired,
    };
  }
}

function utf8BoundedEnd(
  value: string,
  start: number,
  end: number,
  maxBytes: number,
): number {
  let offset = start;
  let bytes = 0;

  while (offset < end) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    if (offset + codeUnits > end) break;
    const codePointBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    offset += codeUnits;
  }

  return offset;
}

export class PersistentShellSession {
  private readonly shellPath: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pathPrepend: string[];
  private readonly transcript: TranscriptBuffer;
  private readonly defaultOutputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly recordLimit: number;
  private readonly logger: ((message: string) => void) | null;
  private readonly records = new Map<string, CommandRecord>();
  private readonly resetRecords = new Map<string, ResetRecord>();
  private readonly stopReasons = new WeakMap<
    ChildProcessWithoutNullStreams,
    StopReason
  >();
  private readonly handledChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly updateWaiters = new Set<() => void>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private active: CommandRecord | null = null;
  private readyState: ReadyState | null = null;
  private startPromise: Promise<void> | null = null;
  private parserBuffer = "";
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");
  private generation = 1;
  private updateVersion = 0;
  private ready = false;
  private closed = false;
  private resetInFlight: ResetRecord | null = null;

  constructor(options: ShellSessionOptions = {}) {
    this.shellPath = options.shellPath ?? "/bin/zsh";
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.pathPrepend = (options.pathPrepend ?? []).filter(
      (entry) => entry.length > 0,
    );
    this.transcript = new TranscriptBuffer(
      positiveInteger(options.transcriptLimit, DEFAULT_TRANSCRIPT_LIMIT),
    );
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes,
      MAX_OUTPUT_BYTES,
    );
    this.defaultOutputBytes = positiveInteger(
      options.defaultOutputBytes,
      DEFAULT_OUTPUT_BYTES,
    );
    if (this.defaultOutputBytes > this.maxOutputBytes) {
      throw new Error("defaultOutputBytes cannot exceed maxOutputBytes.");
    }
    this.recordLimit = positiveInteger(options.recordLimit, DEFAULT_RECORD_LIMIT);
    this.logger = options.logCommands
      ? (options.logger ?? ((message) => console.log(message)))
      : null;
  }

  get initialCwd(): string {
    return this.cwd;
  }

  get defaultReadBytes(): number {
    return this.defaultOutputBytes;
  }

  get maximumReadBytes(): number {
    return this.maxOutputBytes;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new ShellSessionError("closed", "The shell session is closed.");
    }
    if (this.ready && this.child) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.spawnShell().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async runCommand(input: RunCommandInput): Promise<ShellSnapshot> {
    validateRequestId(input.requestId);
    validateCommand(input.command);
    const waitMs = normalizeWaitMs(input.waitMs);
    const maxOutputBytes = this.normalizeOutputBytes(input.maxOutputBytes);
    const commandHash = hashCommand(input.command);

    await this.start();
    const existing = this.records.get(input.requestId);
    if (existing) {
      if (existing.commandHash !== commandHash) {
        throw new ShellSessionError(
          "request_conflict",
          `request_id ${JSON.stringify(input.requestId)} was already used for a different command.`,
        );
      }

      if (existing.status === "running") {
        await this.waitForCommandResult(
          existing,
          existing.startCursor,
          maxOutputBytes,
          waitMs,
          input.signal,
        );
      }
      return this.snapshot(existing, existing.startCursor, true, maxOutputBytes);
    }

    if (this.resetInFlight) {
      throw new ShellSessionError(
        "busy",
        `The shell is being reset by request_id ${JSON.stringify(this.resetInFlight.requestId)}.`,
      );
    }

    if (this.active) {
      throw new ShellSessionError(
        "busy",
        `The shell is busy with request_id ${JSON.stringify(this.active.requestId)}. Poll that request or reset the shell.`,
      );
    }

    if (!this.child || !this.ready) {
      throw new ShellSessionError(
        "shell_unavailable",
        "The shell process is not ready.",
      );
    }
    const child = this.child;

    const token = randomUUID().replaceAll("-", "");
    const record: CommandRecord = {
      requestId: input.requestId,
      commandHash,
      startCursor: this.transcript.end,
      endCursor: null,
      status: "running",
      exitCode: null,
      markerPrefix: `\u001e__MCP_DONE_${token}__:`,
    };

    this.pruneCommandRecords();
    this.records.set(record.requestId, record);
    this.active = record;
    this.logCommand(input.command);
    try {
      await writeToStdin(child, buildCommandScript(input.command, token));
    } catch (error) {
      record.endCursor = this.transcript.end;
      record.status =
        this.stopReasons.get(child) === "reset" ? "reset" : "shell_exited";
      if (this.active === record) this.active = null;
      this.notifyUpdate();
      this.killProcessGroup(child, "SIGKILL");
      throw new ShellSessionError(
        "shell_unavailable",
        `Could not write to the shell: ${errorMessage(error)}`,
      );
    }

    await this.waitForCommandResult(
      record,
      record.startCursor,
      maxOutputBytes,
      waitMs,
      input.signal,
    );
    return this.snapshot(record, record.startCursor, true, maxOutputBytes);
  }

  async pollCommand(input: PollCommandInput): Promise<ShellSnapshot> {
    validateRequestId(input.requestId);
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) {
      throw new ShellSessionError(
        "invalid_cursor",
        "cursor must be a non-negative safe integer.",
      );
    }

    const record = this.records.get(input.requestId);
    if (!record) {
      throw new ShellSessionError(
        "request_not_found",
        `No command exists for request_id ${JSON.stringify(input.requestId)}.`,
      );
    }

    const waitMs = normalizeWaitMs(input.waitMs);
    const maxOutputBytes = this.normalizeOutputBytes(input.maxOutputBytes);
    const version = this.updateVersion;
    const initialRead = this.transcript.read(
      input.cursor,
      maxOutputBytes,
      record.endCursor ?? undefined,
    );
    if (
      record.status === "running" &&
      initialRead.output.length === 0 &&
      !initialRead.cursorExpired
    ) {
      await this.waitForUpdate(version, waitMs, input.signal);
    }

    return this.snapshot(record, input.cursor, true, maxOutputBytes);
  }

  async reset(input: ResetShellInput): Promise<ResetResult> {
    validateRequestId(input.requestId);
    if (this.closed) {
      throw new ShellSessionError("closed", "The shell session is closed.");
    }

    const reason = input.reason ?? "requested by MCP client";
    const existing = this.resetRecords.get(input.requestId);
    if (existing) {
      if (existing.reason !== reason) {
        throw new ShellSessionError(
          "request_conflict",
          `request_id ${JSON.stringify(input.requestId)} was already used for a reset with a different reason.`,
        );
      }
      return existing.promise;
    }

    if (this.resetInFlight) {
      throw new ShellSessionError(
        "busy",
        `The shell is already being reset by request_id ${JSON.stringify(this.resetInFlight.requestId)}.`,
      );
    }

    this.pruneResetRecords();
    const promise = this.performReset(reason).then((result) => ({
      request_id: input.requestId,
      ...result,
    }));
    const record: ResetRecord = {
      requestId: input.requestId,
      reason,
      promise,
    };
    this.resetRecords.set(record.requestId, record);
    this.resetInFlight = record;
    void promise.then(
      () => {
        if (this.resetInFlight === record) this.resetInFlight = null;
      },
      () => {
        if (this.resetInFlight === record) this.resetInFlight = null;
      },
    );
    return promise;
  }

  private async performReset(reason: string): Promise<{
    shell_generation: number;
    state_lost: true;
    status: "ready";
  }> {
    const child = this.child;
    if (child) {
      this.stopReasons.set(child, "reset");
      this.appendTranscript(`\n[mcp] Resetting shell: ${reason}\n`);
      await this.stopChild(child);
    } else {
      this.generation += 1;
      this.ready = false;
      this.appendTranscript(`\n[mcp] Resetting unavailable shell: ${reason}\n`);
      if (this.active) {
        this.active.status = "reset";
        this.active.endCursor = this.transcript.end;
        this.active = null;
      }
      this.notifyUpdate();
    }

    await this.start();
    return {
      shell_generation: this.generation,
      state_lost: true,
      status: "ready",
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const child = this.child;
    if (child) {
      this.stopReasons.set(child, "close");
      await this.stopChild(child);
    }

    for (const resolve of this.updateWaiters) resolve();
    this.updateWaiters.clear();
  }

  private async spawnShell(): Promise<void> {
    this.parserBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stderrDecoder = new StringDecoder("utf8");
    this.ready = false;

    const child = spawn(
      "/bin/sh",
      ["-c", 'exec "$1" -l 2>&1', "mcp-shell", this.shellPath],
      {
        cwd: this.cwd,
        env: this.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.handleDecodedOutput(this.stdoutDecoder.write(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.handleDecodedOutput(this.stderrDecoder.write(chunk));
    });

    let terminationDescription = "unknown termination";
    let finalizeTimer: NodeJS.Timeout | null = null;
    const scheduleForcedFinalization = (description: string) => {
      terminationDescription = description;
      if (finalizeTimer) return;
      finalizeTimer = setTimeout(() => {
        this.finalizeChild(child, terminationDescription);
      }, STOP_GRACE_MS);
    };

    child.once("error", (error) => {
      scheduleForcedFinalization(`spawn error: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      scheduleForcedFinalization(
        signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`,
      );
      if (!this.stopReasons.has(child)) {
        this.killProcessGroup(child, "SIGKILL");
      }
    });
    child.once("close", (code, signal) => {
      if (finalizeTimer) clearTimeout(finalizeTimer);
      const description =
        terminationDescription === "unknown termination"
          ? signal
            ? `signal ${signal}`
            : `exit code ${code ?? "unknown"}`
          : terminationDescription;
      this.finalizeChild(child, description);
    });

    const token = randomUUID().replaceAll("-", "");
    const marker = `\u001e__MCP_READY_${token}__\u001f`;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Shell did not become ready within ${READY_TIMEOUT_MS}ms.`));
        this.killProcessGroup(child, "SIGKILL");
      }, READY_TIMEOUT_MS);

      this.readyState = { child, marker, resolve, reject, timer };
      writeToStdin(
        child,
        [
          this.pathPrepend.length > 0
            ? `builtin export PATH=${singleQuote(this.pathPrepend.join(":"))}:"$PATH"`
            : null,
          `builtin printf '\\036__MCP_READY_${token}__\\037'`,
          "",
        ]
          .filter((line) => line !== null)
          .join("\n"),
      ).catch((error) => {
        clearTimeout(timer);
        this.readyState = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        this.killProcessGroup(child, "SIGKILL");
      });
    });
  }

  private handleDecodedOutput(chunk: string): void {
    if (chunk.length === 0) return;
    this.parserBuffer += chunk;

    while (this.parserBuffer.length > 0) {
      const readyState = this.readyState;
      if (readyState) {
        const markerIndex = this.parserBuffer.indexOf(readyState.marker);
        if (markerIndex < 0) {
          this.flushSafePrefix(readyState.marker);
          return;
        }

        this.appendTranscript(this.parserBuffer.slice(0, markerIndex));
        this.parserBuffer = this.parserBuffer.slice(
          markerIndex + readyState.marker.length,
        );
        clearTimeout(readyState.timer);
        this.readyState = null;
        this.ready = true;
        readyState.resolve();
        this.notifyUpdate();
        continue;
      }

      const active = this.active;
      if (!active) {
        this.appendTranscript(this.parserBuffer);
        this.parserBuffer = "";
        return;
      }

      const markerIndex = this.parserBuffer.indexOf(active.markerPrefix);
      if (markerIndex < 0) {
        this.flushSafePrefix(active.markerPrefix);
        return;
      }

      const markerEnd = this.parserBuffer.indexOf(
        "\u001f",
        markerIndex + active.markerPrefix.length,
      );
      if (markerEnd < 0) {
        this.appendTranscript(this.parserBuffer.slice(0, markerIndex));
        this.parserBuffer = this.parserBuffer.slice(markerIndex);
        return;
      }

      const statusText = this.parserBuffer.slice(
        markerIndex + active.markerPrefix.length,
        markerEnd,
      );
      if (!/^-?\d+$/.test(statusText)) {
        const falsePrefixEnd = markerIndex + active.markerPrefix.length;
        this.appendTranscript(this.parserBuffer.slice(0, falsePrefixEnd));
        this.parserBuffer = this.parserBuffer.slice(falsePrefixEnd);
        continue;
      }

      this.appendTranscript(this.parserBuffer.slice(0, markerIndex));
      this.parserBuffer = this.parserBuffer.slice(markerEnd + 1);
      active.endCursor = this.transcript.end;
      active.exitCode = Number.parseInt(statusText, 10);
      active.status = "completed";
      this.active = null;
      this.notifyUpdate();
    }
  }

  private flushSafePrefix(marker: string): void {
    const safeLength = Math.max(0, this.parserBuffer.length - marker.length + 1);
    if (safeLength === 0) return;
    this.appendTranscript(this.parserBuffer.slice(0, safeLength));
    this.parserBuffer = this.parserBuffer.slice(safeLength);
  }

  private finalizeChild(
    child: ChildProcessWithoutNullStreams,
    description: string,
  ): void {
    if (this.handledChildren.has(child)) return;
    this.handledChildren.add(child);

    const reason = this.stopReasons.get(child);
    if (this.child === child) {
      const stdoutTail = this.stdoutDecoder.end();
      const stderrTail = this.stderrDecoder.end();
      if (stdoutTail) this.handleDecodedOutput(stdoutTail);
      if (stderrTail) this.handleDecodedOutput(stderrTail);
      if (this.parserBuffer) {
        this.appendTranscript(this.parserBuffer);
        this.parserBuffer = "";
      }

      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdout.destroy();
      child.stderr.destroy();

      if (this.readyState?.child === child) {
        clearTimeout(this.readyState.timer);
        this.readyState.reject(
          new Error(`Shell exited before becoming ready (${description}).`),
        );
        this.readyState = null;
      }

      if (this.active) {
        this.active.endCursor = this.transcript.end;
        this.active.status = reason === "reset" ? "reset" : "shell_exited";
        this.active.exitCode = null;
        this.active = null;
      }

      this.child = null;
      this.ready = false;

      if (reason !== "close") {
        this.generation += 1;
        this.appendTranscript(
          `\n[mcp] Shell state lost (${reason ?? "unexpected"}: ${description}). Starting generation ${this.generation}.\n`,
        );
      }
      this.notifyUpdate();
    }

    if (!reason) {
      this.killProcessGroup(child, "SIGKILL");
      if (!this.closed) {
        queueMicrotask(() => {
          if (this.closed) return;
          void this.start().catch((error) => {
            this.appendTranscript(
              `\n[mcp] Shell restart failed: ${errorMessage(error)}\n`,
            );
          });
        });
      }
    }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.killProcessGroup(child, "SIGTERM");
    await waitForExit(child, STOP_GRACE_MS);
    this.killProcessGroup(child, "SIGKILL");
    if (!(await this.waitForChildClose(child, STOP_GRACE_MS))) {
      this.finalizeChild(child, "forced shutdown timeout");
    }
  }

  private waitForChildClose(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.handledChildren.has(child)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off("close", onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("close", onClose);
    });
  }

  private killProcessGroup(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // Process-group cleanup is best effort. A descendant with a different
      // effective user can make killpg return EPERM on macOS; cleanup must not
      // escape a child-process callback and crash the MCP server.
    }
  }

  private snapshot(
    record: CommandRecord,
    cursor: number,
    boundedToCommand: boolean,
    maxOutputBytes: number,
  ): ShellSnapshot {
    const read = this.transcript.read(
      cursor,
      maxOutputBytes,
      boundedToCommand ? (record.endCursor ?? undefined) : undefined,
    );
    return {
      request_id: record.requestId,
      status: record.status,
      exit_code: record.exitCode,
      output: read.output,
      next_cursor: read.nextCursor,
      has_more: read.hasMore,
      cursor_expired: read.cursorExpired,
    };
  }

  private async waitForCommandResult(
    record: CommandRecord,
    cursor: number,
    maxOutputBytes: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + waitMs;

    while (record.status === "running" && !signal?.aborted) {
      const read = this.transcript.read(
        cursor,
        maxOutputBytes,
        record.endCursor ?? undefined,
      );
      if (
        read.cursorExpired ||
        read.hasMore ||
        Buffer.byteLength(read.output, "utf8") >= maxOutputBytes
      ) {
        return;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;

      const version = this.updateVersion;
      await this.waitForUpdate(version, remainingMs, signal);
    }
  }

  private normalizeOutputBytes(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return this.defaultOutputBytes;
    }
    return Math.min(Math.max(Math.trunc(value), 1), this.maxOutputBytes);
  }

  private logCommand(command: string): void {
    if (!this.logger) return;
    try {
      this.logger(command);
    } catch {
      // Logging must never interfere with shell execution.
    }
  }

  private pruneCommandRecords(): void {
    while (this.records.size >= this.recordLimit) {
      const oldestCompleted = [...this.records.values()].find(
        (record) => record.status !== "running",
      );
      if (!oldestCompleted) return;
      this.records.delete(oldestCompleted.requestId);
    }
  }

  private pruneResetRecords(): void {
    while (this.resetRecords.size >= this.recordLimit) {
      const oldestCompleted = [...this.resetRecords.values()].find(
        (record) => record !== this.resetInFlight,
      );
      if (!oldestCompleted) return;
      this.resetRecords.delete(oldestCompleted.requestId);
    }
  }

  private appendTranscript(chunk: string): void {
    if (chunk.length === 0) return;
    this.transcript.append(chunk);
    this.notifyUpdate();
  }

  private notifyUpdate(): void {
    this.updateVersion += 1;
    const waiters = [...this.updateWaiters];
    this.updateWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async waitForUpdate(
    version: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      waitMs === 0 ||
      this.updateVersion !== version ||
      signal?.aborted
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.updateWaiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      timer = setTimeout(done, waitMs);
      this.updateWaiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (this.updateVersion !== version || signal?.aborted) done();
    });
  }
}

function buildCommandScript(command: string, token: string): string {
  const commandVariable = `__mcp_command_${token}`;
  const statusVariable = `__mcp_status_${token}`;
  return [
    `${commandVariable}=${singleQuote(command)}`,
    "set +e",
    `builtin eval -- "$${commandVariable}" </dev/null 1>&1 2>&1`,
    `${statusVariable}=$?`,
    "set +e",
    `unset ${commandVariable}`,
    `builtin printf '\\036__MCP_DONE_${token}__:%s\\037' "$${statusVariable}"`,
    `unset ${statusVariable}`,
    "",
  ].join("\n");
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hashCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function validateRequestId(requestId: string): void {
  if (requestId.length === 0 || requestId.length > 128) {
    throw new ShellSessionError(
      "invalid_command",
      "request_id must contain between 1 and 128 characters.",
    );
  }
}

function validateCommand(command: string): void {
  if (command.length === 0) {
    throw new ShellSessionError("invalid_command", "command cannot be empty.");
  }
  if (command.includes("\0")) {
    throw new ShellSessionError(
      "invalid_command",
      "command cannot contain a NUL character.",
    );
  }
}

function normalizeWaitMs(waitMs: number | undefined): number {
  const value = waitMs ?? DEFAULT_WAIT_MS;
  if (!Number.isFinite(value)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_WAIT_MS);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function writeToStdin(
  child: ChildProcessWithoutNullStreams,
  value: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(value, "utf8", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
