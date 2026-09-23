import { MCP_CONFIG } from "../../config.js"
import { nonNegativeInteger, positiveInteger } from "../../utils.js"
import {
  createShellSession,
  type PollCommandInput,
  type ResetShellInput,
  type RunCommandInput,
  type ShellRecoverableState,
  type ShellSession,
  ShellSessionError,
  type ShellSnapshot,
} from "./session.js"
import { DEFAULT_SHELL_ID, type ShellListOutput, type ShellResetOutput } from "./shell-contracts.js"

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000
export interface ShellSessionManagerOptions {
  createShell?: (initialState?: ShellRecoverableState) => ShellSession
  defaultShell?: ShellSession
  maxShells?: number
  idleTimeoutMs?: number
  cacheTimeoutMs?: number
  now?: () => number
}

type ManagedShellInfo = ShellListOutput["shells"][number]

interface CachedShellState {
  state: ShellRecoverableState
  lastUsedAt: number
}

export interface ShellSessionManager {
  readonly initialCwd: string
  readonly shellCount: number
  readonly maximumShells: number
  readonly idleTimeoutMilliseconds: number
  /** Lease a shell for command execution; creation and restoration are internal. */
  runCommand(shellId: string, input: RunCommandInput): Promise<ShellSnapshot>
  /** Poll retained work in a live shell without creating or restoring one. */
  pollCommand(shellId: string, input: PollCommandInput): Promise<ShellSnapshot>
  /** Reset also discards any cached environment before recreating the shell. */
  resetShell(shellId: string, input: ResetShellInput): Promise<ShellResetOutput>
  listShells(now?: number): ManagedShellInfo[]
  closeShell(shellId: string): Promise<void>
  startDefault(): Promise<void>
  cleanupIdle(now?: number): Promise<string[]>
  close(): Promise<void>
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The manager is a cohesive closure over shared shell lifecycle state; splitting it would widen that mutable state surface.
export function createShellSessionManager(
  options: ShellSessionManagerOptions = {}
): ShellSessionManager {
  const maxShells = positiveInteger(options.maxShells, MCP_CONFIG.shell.maxShells)
  const idleTimeoutMs = nonNegativeInteger(options.idleTimeoutMs, MCP_CONFIG.shell.idleTimeoutMs)
  const cacheTimeoutMs = positiveInteger(options.cacheTimeoutMs, MCP_CONFIG.shell.cacheTimeoutMs)
  const now = options.now ?? Date.now
  const defaultShell = options.defaultShell ?? options.createShell?.() ?? createShellSession()
  const createShell =
    options.createShell ??
    ((initialState?: ShellRecoverableState) =>
      createShellSession({ cwd: defaultShell.initialCwd, initialState }))

  const sessions = new Map<string, ShellSession>([[DEFAULT_SHELL_ID, defaultShell]])
  const lastUsedAt = new Map<string, number>([[DEFAULT_SHELL_ID, now()]])
  const leases = new Map<string, number>()
  const cachedStates = new Map<string, CachedShellState>()
  let cleanupPromise: Promise<string[]> | null = null
  let lifecycleTail: Promise<void> = Promise.resolve()
  let closed = false

  const cleanupTimer = setInterval(
    () => {
      void cleanupIdle().catch(() => {
        // Lifecycle cleanup is best effort and must not terminate the server.
      })
    },
    cleanupInterval(idleTimeoutMs, cacheTimeoutMs)
  )
  cleanupTimer.unref()

  function assertOpen(): void {
    if (closed) throw new ShellSessionError("closed", "The shell session manager is closed.")
  }

  function touch(shellId: string): void {
    lastUsedAt.set(shellId, now())
  }

  function getDefaultShell(): ShellSession {
    const shell = sessions.get(DEFAULT_SHELL_ID)
    if (!shell) {
      throw new ShellSessionError("closed", "The default shell session is unavailable.")
    }
    return shell
  }

  async function withShell<T>(
    shellId: string,
    operation: (shell: ShellSession) => Promise<T>,
    operationOptions: { restoreCached?: boolean } = {}
  ): Promise<T> {
    const shell = await withLifecycleLock(async () => {
      const acquired = await getOrCreateUnlocked(shellId, operationOptions.restoreCached !== false)
      leases.set(shellId, (leases.get(shellId) ?? 0) + 1)
      return acquired
    })
    try {
      return await operation(shell)
    } finally {
      releaseLease(shellId, shell)
    }
  }

  async function withExistingShell<T>(
    shellId: string,
    operation: (shell: ShellSession) => Promise<T>
  ): Promise<T> {
    const shell = await withLifecycleLock(async () => {
      assertOpen()
      const existing = sessions.get(shellId)
      if (!existing) {
        throw new ShellSessionError(
          "request_not_found",
          `No live shell exists for shell_id ${JSON.stringify(shellId)}. Its retained command records are unavailable after hibernation or close.`
        )
      }
      touch(shellId)
      leases.set(shellId, (leases.get(shellId) ?? 0) + 1)
      return existing
    })
    try {
      return await operation(shell)
    } finally {
      releaseLease(shellId, shell)
    }
  }

  function listShells(at = now()): ManagedShellInfo[] {
    assertOpen()
    return [...sessions.entries()].map(([shellId, shell]) => ({
      shell_id: shellId,
      status: shell.hasActiveWork || (leases.get(shellId) ?? 0) > 0 ? "active" : "idle",
      can_close: shellId !== DEFAULT_SHELL_ID,
      idle_ms: Math.max(0, at - (lastUsedAt.get(shellId) ?? at)),
    }))
  }

  async function closeShell(shellId: string): Promise<void> {
    return withLifecycleLock(async () => {
      assertOpen()
      if (shellId === DEFAULT_SHELL_ID) {
        throw new ShellSessionError(
          "protected_shell",
          `The ${JSON.stringify(DEFAULT_SHELL_ID)} shell cannot be closed. Use shell_reset to recover it if needed.`
        )
      }

      const shell = sessions.get(shellId)
      if (!shell)
        throw new ShellSessionError(
          "request_not_found",
          `No live shell exists for shell_id ${JSON.stringify(shellId)}.`
        )

      cachedStates.delete(shellId)
      sessions.delete(shellId)
      lastUsedAt.delete(shellId)
      leases.delete(shellId)
      await shell.close()
    })
  }

  async function startDefault(): Promise<void> {
    touch(DEFAULT_SHELL_ID)
    await getDefaultShell().start()
  }

  function cleanupIdle(at = now()): Promise<string[]> {
    if (cleanupPromise) return cleanupPromise
    const cleanup = withLifecycleLock(() => performCleanup(at)).finally(() => {
      if (cleanupPromise === cleanup) cleanupPromise = null
    })
    cleanupPromise = cleanup
    return cleanup
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    clearInterval(cleanupTimer)
    const cleanup = cleanupPromise
    const shells = [...sessions.values()]
    sessions.clear()
    lastUsedAt.clear()
    leases.clear()
    cachedStates.clear()
    await Promise.allSettled([
      ...(cleanup ? [cleanup] : []),
      ...shells.map((shell) => shell.close()),
    ])
  }

  function releaseLease(shellId: string, shell: ShellSession): void {
    const count = leases.get(shellId) ?? 0
    if (count <= 1) leases.delete(shellId)
    else leases.set(shellId, count - 1)
    if (sessions.get(shellId) === shell) touch(shellId)
  }

  async function getOrCreateUnlocked(
    shellId: string,
    restoreCached: boolean
  ): Promise<ShellSession> {
    assertOpen()

    const existing = sessions.get(shellId)
    if (existing) {
      touch(shellId)
      return existing
    }

    const at = now()
    const cached = cachedStates.get(shellId)
    if (cached && at - cached.lastUsedAt >= cacheTimeoutMs) cachedStates.delete(shellId)
    if (!restoreCached) cachedStates.delete(shellId)

    if (sessions.size >= maxShells && !(await evictLeastRecentlyUsedShell())) {
      throw new ShellSessionError(
        "shell_limit_reached",
        `Cannot create shell ${JSON.stringify(shellId)} because all ${maxShells} live shell slots are unavailable. Busy shells and the protected ${JSON.stringify(DEFAULT_SHELL_ID)} shell are never pressure-evicted.`
      )
    }

    const restored = restoreCached ? cachedStates.get(shellId) : undefined
    if (restored) cachedStates.delete(shellId)
    const shell = createShell(restored?.state)
    sessions.set(shellId, shell)
    touch(shellId)
    return shell
  }

  async function evictLeastRecentlyUsedShell(): Promise<boolean> {
    const candidates = [...sessions.entries()]
      .filter(
        ([shellId, shell]) =>
          shellId !== DEFAULT_SHELL_ID && !shell.hasActiveWork && (leases.get(shellId) ?? 0) === 0
      )
      .sort(([leftId], [rightId]) => (lastUsedAt.get(leftId) ?? 0) - (lastUsedAt.get(rightId) ?? 0))

    for (const [shellId, shell] of candidates) {
      if (await hibernateShell(shellId, shell, lastUsedAt.get(shellId) ?? now())) return true
    }
    return false
  }

  async function performCleanup(at: number): Promise<string[]> {
    if (closed) return []

    removeExpiredCachedStates(at)
    if (idleTimeoutMs === 0) return []

    const evicted: string[] = []
    for (const [shellId, shell] of [...sessions]) {
      if (shellId === DEFAULT_SHELL_ID) continue
      const lastUsed = lastUsedAt.get(shellId) ?? at
      if (at - lastUsed < idleTimeoutMs) continue
      if (shell.hasActiveWork || (leases.get(shellId) ?? 0) > 0) {
        lastUsedAt.set(shellId, at)
        continue
      }
      if (await hibernateShell(shellId, shell, lastUsed)) evicted.push(shellId)
    }
    return evicted
  }

  async function hibernateShell(
    shellId: string,
    shell: ShellSession,
    lastUsed: number
  ): Promise<boolean> {
    let state: ShellRecoverableState
    try {
      state = await shell.captureRecoverableState()
    } catch {
      return false
    }

    if (sessions.get(shellId) !== shell || shell.hasActiveWork || (leases.get(shellId) ?? 0) > 0)
      return false
    cachedStates.set(shellId, { state, lastUsedAt: lastUsed })
    sessions.delete(shellId)
    lastUsedAt.delete(shellId)
    leases.delete(shellId)
    await shell.close()
    return true
  }

  function removeExpiredCachedStates(at: number): void {
    for (const [shellId, cached] of cachedStates) {
      if (at - cached.lastUsedAt >= cacheTimeoutMs) cachedStates.delete(shellId)
    }
  }

  async function withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = lifecycleTail
    lifecycleTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  return {
    get initialCwd() {
      return getDefaultShell().initialCwd
    },
    get shellCount() {
      return sessions.size
    },
    get maximumShells() {
      return maxShells
    },
    get idleTimeoutMilliseconds() {
      return idleTimeoutMs
    },
    runCommand: (shellId, input) => withShell(shellId, (shell) => shell.runCommand(input)),
    pollCommand: (shellId, input) =>
      withExistingShell(shellId, (shell) => shell.pollCommand(input)),
    resetShell: (shellId, input) =>
      withShell(shellId, (shell) => shell.reset(input), { restoreCached: false }),
    listShells,
    closeShell,
    startDefault,
    cleanupIdle,
    close,
  }
}

function cleanupInterval(idleTimeoutMs: number, cacheTimeoutMs: number): number {
  const shortestTimeout =
    idleTimeoutMs === 0 ? cacheTimeoutMs : Math.min(idleTimeoutMs, cacheTimeoutMs)
  return Math.max(1_000, Math.min(DEFAULT_CLEANUP_INTERVAL_MS, Math.floor(shortestTimeout / 2)))
}
