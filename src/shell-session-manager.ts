import { PersistentShellSession, ShellSessionError } from "./shell-session.js"

export const DEFAULT_SHELL_ID = "default"

const DEFAULT_MAX_SHELLS = 8
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000
const MAX_SHELL_ID_LENGTH = 64

export interface ShellSessionManagerOptions {
  createShell?: () => PersistentShellSession
  defaultShell?: PersistentShellSession
  maxShells?: number
  idleTimeoutMs?: number
  now?: () => number
}

export interface ManagedShellInfo extends Record<string, unknown> {
  shell_id: string
  status: "idle" | "active"
  is_default: boolean
  can_close: boolean
  idle_ms: number
}

export class ShellSessionManager {
  private readonly createShell: () => PersistentShellSession
  private readonly sessions = new Map<string, PersistentShellSession>()
  private readonly lastUsedAt = new Map<string, number>()
  private readonly closingShells = new Map<string, Promise<void>>()
  private readonly maxShells: number
  private readonly idleTimeoutMs: number
  private readonly now: () => number
  private readonly cleanupTimer: NodeJS.Timeout | null
  private cleanupPromise: Promise<string[]> | null = null
  private closed = false

  constructor(options: ShellSessionManagerOptions = {}) {
    const defaultShell = options.defaultShell
    this.createShell = options.createShell ?? (defaultShell ? () => defaultShell.fork() : () => new PersistentShellSession())
    this.maxShells = positiveInteger(options.maxShells, DEFAULT_MAX_SHELLS)
    this.idleTimeoutMs = nonNegativeInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS)
    this.now = options.now ?? Date.now
    this.sessions.set(DEFAULT_SHELL_ID, defaultShell ?? this.createShell())
    this.lastUsedAt.set(DEFAULT_SHELL_ID, this.now())
    this.cleanupTimer =
      this.idleTimeoutMs === 0
        ? null
        : setInterval(() => {
            void this.cleanupIdle().catch(() => {
              // Idle cleanup is best effort and must not terminate the server.
            })
          }, cleanupInterval(this.idleTimeoutMs))
    this.cleanupTimer?.unref()
  }

  get initialCwd(): string {
    return this.defaultShell.initialCwd
  }

  get defaultReadBytes(): number {
    return this.defaultShell.defaultReadBytes
  }

  get maximumReadBytes(): number {
    return this.defaultShell.maximumReadBytes
  }

  get commandTranscriptByteLimit(): number {
    return this.defaultShell.commandTranscriptByteLimit
  }

  get shellCount(): number {
    return this.sessions.size
  }

  get maximumShells(): number {
    return this.maxShells
  }

  get idleTimeoutMilliseconds(): number {
    return this.idleTimeoutMs
  }

  get defaultShell(): PersistentShellSession {
    return this.sessions.get(DEFAULT_SHELL_ID)!
  }

  getOrCreate(shellId = DEFAULT_SHELL_ID): PersistentShellSession {
    this.assertOpen()
    validateShellId(shellId)

    if (this.closingShells.has(shellId)) {
      throw new ShellSessionError("busy", `Shell ${JSON.stringify(shellId)} is closing. Retry after it has closed.`)
    }

    const existing = this.sessions.get(shellId)
    if (existing) {
      this.touch(shellId)
      return existing
    }

    if (this.sessions.size >= this.maxShells) {
      throw new ShellSessionError(
        "shell_limit_reached",
        `Cannot create shell ${JSON.stringify(shellId)} because the ${this.maxShells}-shell limit has been reached. Reuse an existing shell_id or restart the MCP server.`
      )
    }

    const shell = this.createShell()
    this.sessions.set(shellId, shell)
    this.touch(shellId)
    return shell
  }

  getExisting(shellId = DEFAULT_SHELL_ID): PersistentShellSession {
    this.assertOpen()
    validateShellId(shellId)
    if (this.closingShells.has(shellId)) {
      throw new ShellSessionError("busy", `Shell ${JSON.stringify(shellId)} is closing.`)
    }
    const existing = this.sessions.get(shellId)
    if (!existing) {
      throw new ShellSessionError(
        "request_not_found",
        `No shell exists for shell_id ${JSON.stringify(shellId)}. Start a command in that shell before polling it.`
      )
    }
    this.touch(shellId)
    return existing
  }

  listShellIds(): string[] {
    return [...this.sessions.keys()]
  }

  listShells(now = this.now()): ManagedShellInfo[] {
    this.assertOpen()
    return [...this.sessions.entries()].map(([shellId, shell]) => ({
      shell_id: shellId,
      status: shell.hasActiveWork ? "active" : "idle",
      is_default: shellId === DEFAULT_SHELL_ID,
      can_close: shellId !== DEFAULT_SHELL_ID,
      idle_ms: Math.max(0, now - (this.lastUsedAt.get(shellId) ?? now)),
    }))
  }

  async closeShell(shellId: string): Promise<void> {
    this.assertOpen()
    validateShellId(shellId)
    if (shellId === DEFAULT_SHELL_ID) {
      throw new ShellSessionError("protected_shell", `The ${JSON.stringify(DEFAULT_SHELL_ID)} shell cannot be closed. Use shell_reset to recover it if needed.`)
    }

    const closing = this.closingShells.get(shellId)
    if (closing) return closing

    const shell = this.sessions.get(shellId)
    if (!shell) {
      throw new ShellSessionError("request_not_found", `No shell exists for shell_id ${JSON.stringify(shellId)}.`)
    }

    this.sessions.delete(shellId)
    this.lastUsedAt.delete(shellId)
    return this.beginClose(shellId, shell)
  }

  async startDefault(): Promise<void> {
    this.touch(DEFAULT_SHELL_ID)
    await this.defaultShell.start()
  }

  cleanupIdle(now = this.now()): Promise<string[]> {
    if (this.cleanupPromise) return this.cleanupPromise
    const cleanup = this.performIdleCleanup(now).finally(() => {
      if (this.cleanupPromise === cleanup) this.cleanupPromise = null
    })
    this.cleanupPromise = cleanup
    return cleanup
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    const cleanup = this.cleanupPromise
    const shells = [...this.sessions.values()]
    const closing = [...this.closingShells.values()]
    this.sessions.clear()
    this.lastUsedAt.clear()
    await Promise.allSettled([...(cleanup ? [cleanup] : []), ...closing, ...shells.map((shell) => shell.close())])
    this.closingShells.clear()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ShellSessionError("closed", "The shell session manager is closed.")
    }
  }

  private touch(shellId: string): void {
    this.lastUsedAt.set(shellId, this.now())
  }

  private async performIdleCleanup(now: number): Promise<string[]> {
    if (this.closed || this.idleTimeoutMs === 0) return []

    const evicted: string[] = []
    const closes: Promise<void>[] = []
    for (const [shellId, shell] of this.sessions) {
      if (shellId === DEFAULT_SHELL_ID) continue
      const lastUsedAt = this.lastUsedAt.get(shellId) ?? now
      if (now - lastUsedAt < this.idleTimeoutMs) continue
      if (shell.hasActiveWork) {
        this.lastUsedAt.set(shellId, now)
        continue
      }

      this.sessions.delete(shellId)
      this.lastUsedAt.delete(shellId)
      evicted.push(shellId)
      closes.push(this.beginClose(shellId, shell))
    }

    await Promise.allSettled(closes)
    return evicted
  }

  private beginClose(shellId: string, shell: PersistentShellSession): Promise<void> {
    const close = shell.close().finally(() => {
      if (this.closingShells.get(shellId) === close) {
        this.closingShells.delete(shellId)
      }
    })
    this.closingShells.set(shellId, close)
    return close
  }
}

function validateShellId(shellId: string): void {
  if (shellId.length === 0 || shellId.length > MAX_SHELL_ID_LENGTH) {
    throw new ShellSessionError("invalid_command", `shell_id must contain between 1 and ${MAX_SHELL_ID_LENGTH} characters.`)
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function cleanupInterval(idleTimeoutMs: number): number {
  return Math.max(1_000, Math.min(DEFAULT_CLEANUP_INTERVAL_MS, Math.floor(idleTimeoutMs / 2)))
}
