import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const AUTH_STATE_VERSION = 1
const DEFAULT_AUTH_STATE_PATH = join(homedir(), ".unhinged-agent", "auth.json")

export interface UnhingedAgentAuthState {
  version: typeof AUTH_STATE_VERSION
  subject: string | null
}

export type UnhingedAgentAuthErrorCode = "state_missing" | "state_invalid" | "subject_missing" | "subject_mismatch"

export class UnhingedAgentAuthError extends Error {
  constructor(
    readonly code: UnhingedAgentAuthErrorCode,
    message: string
  ) {
    super(message)
    this.name = "UnhingedAgentAuthError"
  }
}

export class UnhingedAgentAuthStore {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(readonly filePath = DEFAULT_AUTH_STATE_PATH) {}

  async ensureState(): Promise<UnhingedAgentAuthState> {
    return this.withMutation(async () => {
      try {
        return await this.readState()
      } catch (error) {
        if (!(error instanceof UnhingedAgentAuthError) || error.code !== "state_missing") throw error
      }

      const state: UnhingedAgentAuthState = { version: AUTH_STATE_VERSION, subject: null }
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

  async readState(): Promise<UnhingedAgentAuthState> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new UnhingedAgentAuthError("state_missing", "Unhinged Agent authentication state is missing.")
      }
      throw error
    }

    const state = parseState(raw)
    await ensurePrivateDirectory(dirname(this.filePath))
    await chmod(this.filePath, 0o600)
    return state
  }

  async authorizeToolCall(subject: string | undefined): Promise<UnhingedAgentAuthState> {
    if (!isValidSubject(subject)) {
      throw new UnhingedAgentAuthError("subject_missing", "OpenAI subject is required for remote tool calls.")
    }

    return this.withMutation(async () => {
      const state = await this.readState()
      if (state.subject === null) {
        const boundState: UnhingedAgentAuthState = { ...state, subject }
        await writeStateAtomically(this.filePath, boundState)
        return boundState
      }
      if (state.subject !== subject) {
        throw new UnhingedAgentAuthError("subject_mismatch", "This Unhinged Agent installation is bound to a different ChatGPT user.")
      }
      return state
    })
  }

  async reset(): Promise<UnhingedAgentAuthState> {
    return this.withMutation(async () => {
      const state: UnhingedAgentAuthState = { version: AUTH_STATE_VERSION, subject: null }
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

function parseState(raw: string): UnhingedAgentAuthState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalidState("Unhinged Agent authentication state is malformed.")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidState("Unhinged Agent authentication state must be an object.")
  }
  const state = parsed as Record<string, unknown>
  if (state.version !== AUTH_STATE_VERSION) {
    throw invalidState("Unhinged Agent authentication state version is unsupported.")
  }
  if (state.subject !== null && !isValidSubject(state.subject)) {
    throw invalidState("Unhinged Agent authentication subject is invalid.")
  }
  return { version: AUTH_STATE_VERSION, subject: state.subject as string | null }
}

async function writeStateAtomically(filePath: string, state: UnhingedAgentAuthState): Promise<void> {
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

function serializeState(state: UnhingedAgentAuthState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isValidSubject(subject: unknown): subject is string {
  return typeof subject === "string" && subject.length > 0 && subject.length <= 512
}

function invalidState(message: string): UnhingedAgentAuthError {
  return new UnhingedAgentAuthError("state_invalid", message)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
}
