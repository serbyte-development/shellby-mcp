import { MCP_CONFIG } from "../../config.js"
import { nonNegativeInteger, positiveInteger } from "../../utils.js"
import { DEFAULT_SHELL_ID } from "./shell-contracts.js"
import { PersistentShellSession, ShellSessionError, type ShellRecoverableState } from "./session.js"

export { DEFAULT_SHELL_ID } from "./shell-contracts.js"

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000
export interface ShellSessionManagerOptions {
  createShell?: (initialState?: ShellRecoverableState) => PersistentShellSession
  defaultShell?: PersistentShellSession
  maxShells?: number
  idleTimeoutMs?: number
  cacheTimeoutMs?: number
  now?: () => number
}

export interface ManagedShellInfo extends Record<string, unknown> {
  shell_id: string
  status: "idle" | "active"
  is_default: boolean
  can_close: boolean
  idle_ms: number
}

interface CachedShellState {
  state: ShellRecoverableState
  lastUsedAt: number
}

export class ShellSessionManager {
  private readonly createShell: (initialState?: ShellRecoverableState) => PersistentShellSession
  private readonly sessions = new Map<string, PersistentShellSession>()
  private readonly lastUsedAt = new Map<string, number>()
  private readonly leases = new Map<string, number>()
  private readonly cachedStates = new Map<string, CachedShellState>()
  private readonly maxShells: number
  private readonly idleTimeoutMs: number
  private readonly cacheTimeoutMs: number
  private readonly now: () => number
  private readonly cleanupTimer: NodeJS.Timeout
  private cleanupPromise: Promise<string[]> | null = null
  private lifecycleTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: ShellSessionManagerOptions = {}) {
    const defaultShell = options.defaultShell
    this.createShell =
      options.createShell ?? (defaultShell ? (state) => defaultShell.fork(state) : (state) => new PersistentShellSession({ initialState: state }))
    this.maxShells = positiveInteger(options.maxShells, MCP_CONFIG.shell.maxShells)
    this.idleTimeoutMs = nonNegativeInteger(options.idleTimeoutMs, MCP_CONFIG.shell.idleTimeoutMs)
    this.cacheTimeoutMs = positiveInteger(options.cacheTimeoutMs, MCP_CONFIG.shell.cacheTimeoutMs)
    this.now = options.now ?? Date.now
    this.sessions.set(DEFAULT_SHELL_ID, defaultShell ?? this.createShell())
    this.lastUsedAt.set(DEFAULT_SHELL_ID, this.now())
    this.cleanupTimer = setInterval(
      () => {
        void this.cleanupIdle().catch(() => {
          // Lifecycle cleanup is best effort and must not terminate the server.
        })
      },
      cleanupInterval(this.idleTimeoutMs, this.cacheTimeoutMs)
    )
    this.cleanupTimer.unref()
  }

  get initialCwd(): string {
    return this.defaultShell.initialCwd
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

  get cacheTimeoutMilliseconds(): number {
    return this.cacheTimeoutMs
  }

  get defaultShell(): PersistentShellSession {
    return this.sessions.get(DEFAULT_SHELL_ID)!
  }

  async getOrCreate(shellId: string, options: { restoreCached?: boolean } = {}): Promise<PersistentShellSession> {
    return this.withLifecycleLock(() => this.getOrCreateUnlocked(shellId, options.restoreCached !== false))
  }

  getExisting(shellId: string): PersistentShellSession {
    this.assertOpen()
    const existing = this.sessions.get(shellId)
    if (!existing) {
      throw new ShellSessionError(
        "request_not_found",
        `No live shell exists for shell_id ${JSON.stringify(shellId)}. Start a new command in that shell before polling it.`
      )
    }
    this.touch(shellId)
    return existing
  }

  async withShell<T>(shellId: string, operation: (shell: PersistentShellSession) => Promise<T>, options: { restoreCached?: boolean } = {}): Promise<T> {
    const shell = await this.withLifecycleLock(async () => {
      const acquired = await this.getOrCreateUnlocked(shellId, options.restoreCached !== false)
      this.leases.set(shellId, (this.leases.get(shellId) ?? 0) + 1)
      return acquired
    })
    try {
      return await operation(shell)
    } finally {
      this.releaseLease(shellId, shell)
    }
  }

  async withExistingShell<T>(shellId: string, operation: (shell: PersistentShellSession) => Promise<T>): Promise<T> {
    const shell = await this.withLifecycleLock(async () => {
      this.assertOpen()
      const existing = this.sessions.get(shellId)
      if (!existing) {
        throw new ShellSessionError(
          "request_not_found",
          `No live shell exists for shell_id ${JSON.stringify(shellId)}. Its retained command records are unavailable after hibernation or close.`
        )
      }
      this.touch(shellId)
      this.leases.set(shellId, (this.leases.get(shellId) ?? 0) + 1)
      return existing
    })
    try {
      return await operation(shell)
    } finally {
      this.releaseLease(shellId, shell)
    }
  }

  listShellIds(): string[] {
    return [...this.sessions.keys()]
  }

  listCachedShellIds(now = this.now()): string[] {
    this.removeExpiredCachedStates(now)
    return [...this.cachedStates.keys()]
  }

  listShells(now = this.now()): ManagedShellInfo[] {
    this.assertOpen()
    return [...this.sessions.entries()].map(([shellId, shell]) => ({
      shell_id: shellId,
      status: shell.hasActiveWork || (this.leases.get(shellId) ?? 0) > 0 ? "active" : "idle",
      is_default: shellId === DEFAULT_SHELL_ID,
      can_close: shellId !== DEFAULT_SHELL_ID,
      idle_ms: Math.max(0, now - (this.lastUsedAt.get(shellId) ?? now)),
    }))
  }

  async closeShell(shellId: string): Promise<void> {
    return this.withLifecycleLock(async () => {
      this.assertOpen()
      if (shellId === DEFAULT_SHELL_ID) {
        throw new ShellSessionError(
          "protected_shell",
          `The ${JSON.stringify(DEFAULT_SHELL_ID)} shell cannot be closed. Use shell_reset to recover it if needed.`
        )
      }

      const shell = this.sessions.get(shellId)
      if (!shell) {
        throw new ShellSessionError("request_not_found", `No live shell exists for shell_id ${JSON.stringify(shellId)}.`)
      }

      this.cachedStates.delete(shellId)
      this.sessions.delete(shellId)
      this.lastUsedAt.delete(shellId)
      this.leases.delete(shellId)
      await shell.close()
    })
  }

  async startDefault(): Promise<void> {
    this.touch(DEFAULT_SHELL_ID)
    await this.defaultShell.start()
  }

  cleanupIdle(now = this.now()): Promise<string[]> {
    if (this.cleanupPromise) return this.cleanupPromise
    const cleanup = this.withLifecycleLock(() => this.performCleanup(now)).finally(() => {
      if (this.cleanupPromise === cleanup) this.cleanupPromise = null
    })
    this.cleanupPromise = cleanup
    return cleanup
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.cleanupTimer)
    const cleanup = this.cleanupPromise
    const shells = [...this.sessions.values()]
    this.sessions.clear()
    this.lastUsedAt.clear()
    this.leases.clear()
    this.cachedStates.clear()
    await Promise.allSettled([...(cleanup ? [cleanup] : []), ...shells.map((shell) => shell.close())])
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ShellSessionError("closed", "The shell session manager is closed.")
    }
  }

  private touch(shellId: string): void {
    this.lastUsedAt.set(shellId, this.now())
  }

  private releaseLease(shellId: string, shell: PersistentShellSession): void {
    const count = this.leases.get(shellId) ?? 0
    if (count <= 1) this.leases.delete(shellId)
    else this.leases.set(shellId, count - 1)
    if (this.sessions.get(shellId) === shell) this.touch(shellId)
  }

  private async getOrCreateUnlocked(shellId: string, restoreCached: boolean): Promise<PersistentShellSession> {
    this.assertOpen()

    const existing = this.sessions.get(shellId)
    if (existing) {
      this.touch(shellId)
      return existing
    }

    const now = this.now()
    const cached = this.cachedStates.get(shellId)
    if (cached && now - cached.lastUsedAt >= this.cacheTimeoutMs) {
      this.cachedStates.delete(shellId)
    }
    if (!restoreCached) this.cachedStates.delete(shellId)

    if (this.sessions.size >= this.maxShells) {
      const evicted = await this.evictLeastRecentlyUsedShell()
      if (!evicted) {
        throw new ShellSessionError(
          "shell_limit_reached",
          `Cannot create shell ${JSON.stringify(shellId)} because all ${this.maxShells} live shell slots are unavailable. Busy shells and the protected ${JSON.stringify(DEFAULT_SHELL_ID)} shell are never pressure-evicted.`
        )
      }
    }

    const restored = restoreCached ? this.cachedStates.get(shellId) : undefined
    if (restored) this.cachedStates.delete(shellId)
    const shell = this.createShell(restored?.state)
    this.sessions.set(shellId, shell)
    this.touch(shellId)
    return shell
  }

  private async evictLeastRecentlyUsedShell(): Promise<boolean> {
    const candidates = [...this.sessions.entries()]
      .filter(([shellId, shell]) => shellId !== DEFAULT_SHELL_ID && !shell.hasActiveWork && (this.leases.get(shellId) ?? 0) === 0)
      .sort(([leftId], [rightId]) => (this.lastUsedAt.get(leftId) ?? 0) - (this.lastUsedAt.get(rightId) ?? 0))

    for (const [shellId, shell] of candidates) {
      if (await this.hibernateShell(shellId, shell, this.lastUsedAt.get(shellId) ?? this.now())) return true
    }
    return false
  }

  private async performCleanup(now: number): Promise<string[]> {
    if (this.closed) return []

    this.removeExpiredCachedStates(now)
    if (this.idleTimeoutMs === 0) return []

    const evicted: string[] = []
    for (const [shellId, shell] of [...this.sessions]) {
      if (shellId === DEFAULT_SHELL_ID) continue
      const lastUsedAt = this.lastUsedAt.get(shellId) ?? now
      if (now - lastUsedAt < this.idleTimeoutMs) continue
      if (shell.hasActiveWork || (this.leases.get(shellId) ?? 0) > 0) {
        this.lastUsedAt.set(shellId, now)
        continue
      }
      if (await this.hibernateShell(shellId, shell, lastUsedAt)) evicted.push(shellId)
    }
    return evicted
  }

  private async hibernateShell(shellId: string, shell: PersistentShellSession, lastUsedAt: number): Promise<boolean> {
    let state: ShellRecoverableState
    try {
      state = await shell.captureRecoverableState()
    } catch {
      return false
    }

    if (this.sessions.get(shellId) !== shell || shell.hasActiveWork || (this.leases.get(shellId) ?? 0) > 0) return false
    this.cachedStates.set(shellId, { state, lastUsedAt })
    this.sessions.delete(shellId)
    this.lastUsedAt.delete(shellId)
    this.leases.delete(shellId)
    await shell.close()
    return true
  }

  private removeExpiredCachedStates(now: number): void {
    for (const [shellId, cached] of this.cachedStates) {
      if (now - cached.lastUsedAt >= this.cacheTimeoutMs) this.cachedStates.delete(shellId)
    }
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.lifecycleTail
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function cleanupInterval(idleTimeoutMs: number, cacheTimeoutMs: number): number {
  const shortestTimeout = idleTimeoutMs === 0 ? cacheTimeoutMs : Math.min(idleTimeoutMs, cacheTimeoutMs)
  return Math.max(1_000, Math.min(DEFAULT_CLEANUP_INTERVAL_MS, Math.floor(shortestTimeout / 2)))
}
