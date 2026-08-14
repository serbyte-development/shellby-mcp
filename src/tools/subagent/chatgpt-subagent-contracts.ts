export interface ChatGptSubagentOptions {
  cdpEndpoint?: string
  onPageCreated?: () => void | Promise<void>
  connectTimeoutMs?: number
  chatGptUrl?: string
  maxConcurrentAgents?: number
  minInterTurnDelayMs?: number
  interactionDelayMs?: number
  timeoutMs?: number
}

export interface ChatGptSubagentRequest {
  prompt: string
  agentId: string
  oververbosity?: number
}

export interface ChatGptSubagentStartResult {
  agentId: string
  turnId: string
  status: "running"
  submitted: true
  conversationId?: string
  conversationUrl?: string
}

export interface ChatGptSubagentPollResult {
  agentId: string
  turnId: string
  status: "running" | "completed" | "failed"
  activity?: ChatGptSubagentActivity
  activityAgeMs?: number
  conversationId?: string
  conversationUrl?: string
  messageId?: string
  response?: string
  errorCode?: string
  errorMessage?: string
}

export type ChatGptSubagentActivity = "Working" | "Searching the web" | "Using tools" | "Generating response"

export interface ChatGptConversationMessage {
  id?: string
  role: "user" | "assistant"
  text: string
}

export type ChatGptSubagentErrorCode =
  | "BROWSER_UNAVAILABLE"
  | "CHATGPT_NOT_AUTHENTICATED"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_TURN"
  | "AGENT_BUSY"
  | "SUBAGENT_CAPACITY_REACHED"
  | "AGENT_TARGET_LOST"
  | "SUBAGENT_CONVERSATION_NOT_FOUND"
  | "REQUEST_ABORTED"
  | "CHATGPT_UI_CHANGED"

export class ChatGptSubagentError extends Error {
  constructor(
    readonly code: ChatGptSubagentErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ChatGptSubagentError"
  }
}

export interface ChatGptSubagentService {
  ask(request: ChatGptSubagentRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult>
  poll(turnId: string, waitMs?: number, signal?: AbortSignal): Promise<ChatGptSubagentPollResult>
  drainEvents?(): string[]
  dispose(): Promise<void>
}
