export type ChatGptDelegationErrorCode =
  | "INVALID_ARGUMENT"
  | "BROWSER_UNAVAILABLE"
  | "CHATGPT_NOT_AUTHENTICATED"
  | "UNKNOWN_TURN"
  | "AGENT_BUSY"
  | "AGENT_LIMIT_REACHED"
  | "SUBAGENT_RATE_LIMITED"
  | "AGENT_TARGET_LOST"
  | "AGENT_IDLE_EXPIRED"
  | "SUBAGENT_PERSISTENCE_UNAVAILABLE"
  | "REQUEST_ABORTED"
  | "CHATGPT_UI_CHANGED"

export class ChatGptDelegationError extends Error {
  constructor(
    readonly code: ChatGptDelegationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ChatGptDelegationError"
  }
}
