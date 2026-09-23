import { setTimeout as sleep } from "node:timers/promises"
import { ChatGptDelegationError } from "./contracts.js"

/** Wait in milliseconds; cancellation rejects with REQUEST_ABORTED. */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal })
  } catch (error) {
    if (signal?.aborted) {
      // biome-ignore lint/style/useErrorCause: ChatGptDelegationError takes ErrorOptions as its third argument.
      throw new ChatGptDelegationError(
        "REQUEST_ABORTED",
        "The ChatGPT subagent request was cancelled.",
        { cause: error }
      )
    }
    throw error
  }
}
