import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

const execFileAsync = promisify(execFile);

interface PeekabooEnvelope {
  success: boolean;
  data?: unknown;
  summary?: unknown;
  messages?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export interface PeekabooResult {
  data?: unknown;
  summary?: unknown;
  messages?: string[];
}

export interface PeekabooObservation extends PeekabooResult {
  imageData: string;
  mimeType: "image/jpeg";
  target?: PeekabooSnapshotTarget;
}

export interface PeekabooSnapshotTarget {
  kind?: string;
  app?: string;
  windowId?: number;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface PeekabooClientOptions {
  executable?: string;
  baseArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class PeekabooError extends Error {
  readonly code: string;
  readonly details?: string;

  constructor(code: string, message: string, details?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PeekabooError";
    this.code = code;
    this.details = details;
  }
}

export class PeekabooClient {
  readonly executable: string;

  private readonly baseArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly shutdownController = new AbortController();
  private readonly snapshots = new Map<string, PeekabooSnapshotTarget>();

  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: PeekabooClientOptions = {}) {
    this.executable = options.executable ?? "peekaboo";
    this.baseArgs = options.baseArgs ?? [];
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  }

  run(args: string[], signal?: AbortSignal): Promise<PeekabooResult> {
    return this.enqueue((requestSignal) => this.runNow(args, requestSignal), signal);
  }

  observe(
    args: string[],
    options: { annotate: boolean },
    signal?: AbortSignal,
  ): Promise<PeekabooObservation> {
    return this.enqueue(
      (requestSignal) => this.observeNow(args, options, requestSignal),
      signal,
    );
  }

  getSnapshotTarget(snapshotId: string): PeekabooSnapshotTarget | undefined {
    return this.snapshots.get(snapshotId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort();
    await this.queue;
  }

  private enqueue<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const queued = async () => {
      if (this.closed) {
        throw new PeekabooError("PEEKABOO_CLOSED", "Computer Use is closed.");
      }
      const requestSignal = signal
        ? AbortSignal.any([signal, this.shutdownController.signal])
        : this.shutdownController.signal;
      requestSignal.throwIfAborted();
      return operation(requestSignal);
    };

    const result = this.queue.then(queued, queued);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async observeNow(
    args: string[],
    options: { annotate: boolean },
    signal: AbortSignal,
  ): Promise<PeekabooObservation> {
    const directory = await mkdtemp(join(tmpdir(), "peekaboo-mcp-"));
    const requestedPath = join(directory, "capture.png");

    try {
      const result = await this.runNow(
        [
          "see",
          ...args,
          "--path",
          requestedPath,
          ...(options.annotate ? ["--annotate"] : []),
        ],
        signal,
      );
      const data = asRecord(result.data);
      const snapshotId = stringValue(data?.snapshot_id);
      let target = observationTarget(data);
      const requestedWindowId = integerOption(args, "--window-id");
      if (requestedWindowId !== undefined && target?.windowId === undefined) {
        target = {
          ...target,
          kind: target?.kind ?? "window-id",
          windowId: requestedWindowId,
        };
      }

      const screenCapture =
        target?.kind?.toLowerCase().includes("screen") ||
        optionValue(args, "--mode") === "screen";
      if (screenCapture && !target?.bounds) {
        const screens = await this.runNow(["list", "screens"], signal);
        const screenIndex = integerOption(args, "--screen-index") ?? 0;
        const bounds = screenBounds(screens.data, screenIndex);
        if (bounds) {
          target = { ...target, kind: target?.kind ?? "screen", bounds };
        }
      }
      if (snapshotId && target) this.rememberSnapshot(snapshotId, target);
      const imagePath =
        options.annotate &&
        typeof data?.screenshot_annotated === "string" &&
        data.screenshot_annotated
          ? data.screenshot_annotated
          : typeof data?.screenshot_raw === "string" && data.screenshot_raw
            ? data.screenshot_raw
            : requestedPath;

      try {
        const image = await readFile(imagePath);
        const encodedImage = await sharp(image)
          .jpeg({
            quality: 75,
            progressive: true,
            chromaSubsampling: "4:4:4",
          })
          .toBuffer();
        return {
          ...result,
          imageData: encodedImage.toString("base64"),
          mimeType: "image/jpeg",
          ...(target ? { target } : {}),
        };
      } catch (error) {
        throw new PeekabooError(
          "SCREENSHOT_READ_FAILED",
          "Peekaboo completed but its screenshot could not be read or encoded.",
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private rememberSnapshot(snapshotId: string, target: PeekabooSnapshotTarget): void {
    this.snapshots.delete(snapshotId);
    this.snapshots.set(snapshotId, target);
    while (this.snapshots.size > 64) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }

  private async runNow(
    args: string[],
    signal: AbortSignal,
  ): Promise<PeekabooResult> {
    const commandArgs = [...this.baseArgs, ...args, "--json"];
    let stdout = "";
    let stderr = "";

    try {
      const output = await execFileAsync(this.executable, commandArgs, {
        encoding: "utf8",
        env: this.env,
        maxBuffer: this.maxOutputBytes,
        signal,
        timeout: this.timeoutMs,
      });
      stdout = String(output.stdout);
      stderr = String(output.stderr);
    } catch (error) {
      stdout = processOutput(error, "stdout");
      stderr = processOutput(error, "stderr");
      const envelope = tryParseEnvelope(stdout);
      if (envelope?.success === false) throw envelopeError(envelope, error);

      const processError = error as NodeJS.ErrnoException;
      if (processError.code === "ENOENT") {
        throw new PeekabooError(
          "PEEKABOO_NOT_FOUND",
          `Peekaboo executable ${JSON.stringify(this.executable)} was not found. Install it with Homebrew or set MCP_PEEKABOO_BIN.`,
          undefined,
          { cause: error },
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      throw new PeekabooError(
        "PEEKABOO_PROCESS_FAILED",
        `Peekaboo command failed: ${detail}`,
        stderr.trim().slice(-4096) || undefined,
        { cause: error },
      );
    }

    const envelope = parseEnvelope(stdout, stderr);
    if (!envelope.success) throw envelopeError(envelope);

    return {
      ...(envelope.data === undefined ? {} : { data: envelope.data }),
      ...(envelope.summary === undefined ? {} : { summary: envelope.summary }),
      ...(Array.isArray(envelope.messages)
        ? { messages: envelope.messages.filter((item): item is string => typeof item === "string") }
        : {}),
    };
  }
}

function parseEnvelope(stdout: string, stderr: string): PeekabooEnvelope {
  const envelope = tryParseEnvelope(stdout);
  if (envelope) return envelope;

  throw new PeekabooError(
    "PEEKABOO_INVALID_JSON",
    "Peekaboo did not return its expected JSON response.",
    stderr.trim().slice(-4096) || stdout.trim().slice(-4096) || undefined,
  );
}

function tryParseEnvelope(stdout: string): PeekabooEnvelope | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const success = (parsed as { success?: unknown }).success;
    if (typeof success !== "boolean") return null;
    return parsed as PeekabooEnvelope;
  } catch {
    return null;
  }
}

function envelopeError(envelope: PeekabooEnvelope, cause?: unknown): PeekabooError {
  const code =
    typeof envelope.error?.code === "string"
      ? envelope.error.code
      : "PEEKABOO_COMMAND_FAILED";
  const message =
    typeof envelope.error?.message === "string"
      ? envelope.error.message
      : "Peekaboo reported a command failure.";
  const details =
    typeof envelope.error?.details === "string" ? envelope.error.details : undefined;
  return new PeekabooError(code, message, details, { cause });
}

function processOutput(error: unknown, field: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string"
    ? value
    : Buffer.isBuffer(value)
      ? value.toString("utf8")
      : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function observationTarget(
  data: Record<string, unknown> | null,
): PeekabooSnapshotTarget | undefined {
  if (!data) return undefined;
  const observation = asRecord(data.observation);
  const target = asRecord(observation?.target);
  const bounds = rectangle(target?.bounds);
  const kind =
    stringValue(target?.resolvedKind) ??
    stringValue(target?.resolved_kind) ??
    stringValue(target?.requestedKind) ??
    stringValue(target?.requested_kind) ??
    stringValue(data.capture_mode);
  const stateSnapshot =
    asRecord(observation?.stateSnapshot) ?? asRecord(observation?.state_snapshot);
  const windowId =
    numberValue(target?.windowID) ??
    numberValue(target?.window_id) ??
    numberValue(stateSnapshot?.frontmostWindowID) ??
    numberValue(stateSnapshot?.frontmost_window_id);
  const app = stringValue(data.application_name);

  if (!kind && !windowId && !app && !bounds) return undefined;
  return {
    ...(kind ? { kind } : {}),
    ...(app ? { app } : {}),
    ...(windowId ? { windowId } : {}),
    ...(bounds ? { bounds } : {}),
  };
}

function rectangle(value: unknown): PeekabooSnapshotTarget["bounds"] | undefined {
  if (Array.isArray(value)) {
    const origin = Array.isArray(value[0]) ? value[0] : [];
    const size = Array.isArray(value[1]) ? value[1] : [];
    const x = numberValue(origin[0]);
    const y = numberValue(origin[1]);
    const width = numberValue(size[0]);
    const height = numberValue(size[1]);
    return x !== undefined && y !== undefined && width !== undefined && height !== undefined
      ? { x, y, width, height }
      : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const origin = asRecord(record.origin);
  const size = asRecord(record.size);
  const x = numberValue(record.x) ?? numberValue(origin?.x);
  const y = numberValue(record.y) ?? numberValue(origin?.y);
  const width = numberValue(record.width) ?? numberValue(size?.width);
  const height = numberValue(record.height) ?? numberValue(size?.height);
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined
    ? { x, y, width, height }
    : undefined;
}

function screenBounds(
  data: unknown,
  screenIndex: number,
): PeekabooSnapshotTarget["bounds"] | undefined {
  const screens = asRecord(data)?.screens;
  if (!Array.isArray(screens)) return undefined;
  const screen = screens
    .map(asRecord)
    .find((item) => numberValue(item?.index) === screenIndex);
  return rectangle(screen?.bounds);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function integerOption(args: string[], name: string): number | undefined {
  const value = optionValue(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
