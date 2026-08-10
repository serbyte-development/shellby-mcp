import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const AUTH_STATE_VERSION = 1
export const DEFAULT_AUTH_STATE_PATH = join(homedir(), ".shelly", "auth.json")

export interface ShellyAuthState {
  version: typeof AUTH_STATE_VERSION
  subject: string | null
}

export type ShellyAuthErrorCode = "state_missing" | "state_invalid" | "subject_missing" | "subject_mismatch"

export class ShellyAuthError extends Error {
  constructor(
    readonly code: ShellyAuthErrorCode,
    message: string
  ) {
    super(message)
    this.name = "ShellyAuthError"
  }
}

export class ShellyAuthStore {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(readonly filePath = DEFAULT_AUTH_STATE_PATH) {}

  async ensureState(): Promise<ShellyAuthState> {
    return this.withMutation(async () => {
      try {
        return await this.readState()
      } catch (error) {
        if (!(error instanceof ShellyAuthError) || error.code !== "state_missing") throw error
      }

      const state: ShellyAuthState = { version: AUTH_STATE_VERSION, subject: null }
      await ensurePrivateDirectory(dirname(this.filePath))
      try {
        await writeFile(this.filePath, serializeState(state), { encoding: "utf8", flag: "wx", mode: 0o600 })
        await chmod(this.filePath, 0o600)
        return state
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error
        return this.readState()
      }
    })
  }

  async readState(): Promise<ShellyAuthState> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ShellyAuthError("state_missing", "Shelly authentication state is missing.")
      }
      throw error
    }

    const state = parseState(raw)
    await ensurePrivateDirectory(dirname(this.filePath))
    await chmod(this.filePath, 0o600)
    return state
  }

  async authorizeToolCall(subject: string | undefined): Promise<ShellyAuthState> {
    if (!isValidSubject(subject)) {
      throw new ShellyAuthError("subject_missing", "OpenAI subject is required for remote tool calls.")
    }

    return this.withMutation(async () => {
      const state = await this.readState()
      if (state.subject === null) {
        const boundState: ShellyAuthState = { ...state, subject }
        await writeStateAtomically(this.filePath, boundState)
        return boundState
      }
      if (state.subject !== subject) {
        throw new ShellyAuthError("subject_mismatch", "This Shelly installation is bound to a different ChatGPT user.")
      }
      return state
    })
  }

  async reset(): Promise<ShellyAuthState> {
    return this.withMutation(async () => {
      const state: ShellyAuthState = { version: AUTH_STATE_VERSION, subject: null }
      await writeStateAtomically(this.filePath, state)
      return state
    })
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
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

function parseState(raw: string): ShellyAuthState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalidState("Shelly authentication state is malformed.")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidState("Shelly authentication state must be an object.")
  }
  const state = parsed as Record<string, unknown>
  if (state.version !== AUTH_STATE_VERSION) {
    throw invalidState("Shelly authentication state version is unsupported.")
  }
  if (state.subject !== null && !isValidSubject(state.subject)) {
    throw invalidState("Shelly authentication subject is invalid.")
  }
  return { version: AUTH_STATE_VERSION, subject: state.subject as string | null }
}

async function writeStateAtomically(filePath: string, state: ShellyAuthState): Promise<void> {
  const directory = dirname(filePath)
  await ensurePrivateDirectory(directory)
  const temporaryPath = join(directory, `.auth-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(temporaryPath, serializeState(state), { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

function serializeState(state: ShellyAuthState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isValidSubject(subject: unknown): subject is string {
  return typeof subject === "string" && subject.length > 0 && subject.length <= 512
}

function invalidState(message: string): ShellyAuthError {
  return new ShellyAuthError("state_invalid", message)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
}
