import { AsyncLocalStorage } from "node:async_hooks"
import type { JSONRPCResponse, RequestId, ServerContext } from "@modelcontextprotocol/server"

import { type AgentIdentity, getAgentIdentity } from "../agent/context.js"
import type { AgentObserver } from "../agent/observer.js"
import type { McpAuditLogger } from "../server/audit/audit-log.js"
import { countTokens } from "../tokenizer.js"
import { asRecord } from "../utils.js"

interface ToolCall {
  readonly id: string
  readonly tool: string
  readonly input: unknown
  readonly agent?: AgentIdentity
  // start_here can set the live identity's task slug while the call is running.
  readonly taskSlugAtStart?: string
  readonly startedAt: number
  /** o200k_base tokens in the full JSON arguments; absent only if counting failed. */
  readonly inputTokens?: number
}

export interface CompletedToolCall extends ToolCall {
  readonly status: "completed" | "failed"
  readonly finishedAt: number
  readonly toolResult?: unknown
  readonly response?: unknown
  /** Full final text/structured response tokens, before display truncation; excludes binary media. */
  readonly outputTokens?: number
  readonly error?: unknown
  readonly errors: readonly unknown[]
  readonly httpStatus?: number
  readonly transportState?: "finished" | "closed"
}

export type ToolCallEvent = (ToolCall & { readonly status: "running" }) | CompletedToolCall

interface PendingCall {
  call: ToolCall
  errors: unknown[]
  toolResult?: unknown
  error?: unknown
  detach?: () => void
}

interface CallConsumers {
  agentObserver?: Pick<AgentObserver, "observeToolCall">
  auditLogger?: Pick<McpAuditLogger, "recordToolCall" | "recordToolsList">
}

const currentErrors = new AsyncLocalStorage<(error: unknown) => void>()
const agentToolUsage = new WeakMap<AgentIdentity, AgentToolUsage>()
let nextCallId = 0

export interface AgentToolUsage {
  readonly callCount: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * Process-lifetime usage for this canonical identity, across request trackers.
 * Returns a snapshot of registered attempts and measured text tokens: input at
 * registration, output at response handoff. Unavailable counts contribute zero.
 */
export function getAgentToolUsage(agent: AgentIdentity): AgentToolUsage {
  return { ...(agentToolUsage.get(agent) ?? { callCount: 0, inputTokens: 0, outputTokens: 0 }) }
}

/** Keep original diagnostics before a tool replaces them with recovery guidance. */
export function recordToolError(error: unknown): void {
  currentErrors.getStore()?.(error)
}

/**
 * Own call identities, timing, token counts, diagnostics, and terminal transitions within a request scope.
 * HTTP seeds raw requests so even undispatched calls are recorded. run also starts calls
 * for non-HTTP transports. Only the final SDK response or request termination completes
 * a call; late handler results cannot complete it again. Consumers receive snapshots,
 * and their failures never affect tool execution or prevent the other consumer running.
 */
export class ToolCallTracker {
  private readonly pending = new Map<RequestId | symbol, PendingCall>()
  private ended: boolean = false

  constructor(
    private readonly consumers: CallConsumers = {},
    private readonly now: () => number = Date.now
  ) {}

  startRequest(payload: unknown): void {
    if (this.ended) return
    for (const value of Array.isArray(payload) ? payload : [payload]) {
      const request = asRecord(value)
      if (request?.method === "tools/list") {
        this.observe(() => this.consumers.auditLogger?.recordToolsList(this.now()))
      }
      if (request?.method !== "tools/call") continue
      const params = asRecord(request.params)
      if (typeof params?.name !== "string" || !params.name) continue
      const id = request.id
      this.start(
        typeof id === "string" || typeof id === "number" ? id : Symbol(),
        params.name,
        params.arguments
      )
    }
  }

  /** Execute the handler in its diagnostic scope; SDK validation still happens afterward. */
  async run<T>(
    context: ServerContext,
    name: string,
    input: unknown,
    operation: () => Promise<T>
  ): Promise<T> {
    const { id, signal } = context.mcpReq
    if (this.ended) throw new Error("MCP request ended before tool dispatch.")
    const pending = this.start(id, name, input)
    const abort = () =>
      this.finish(id, { error: new Error("MCP request ended without a response.") })
    pending.detach = () => signal.removeEventListener("abort", abort)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    return currentErrors.run(
      (error) => {
        if (this.pending.get(id) === pending) pending.errors.push(error)
      },
      async () => {
        try {
          signal.throwIfAborted()
          const result = await operation()
          pending.toolResult = result
          return result
        } catch (error) {
          pending.error = error
          throw error
        }
      }
    )
  }

  /** Called at transport handoff after SDK validation/projection, not proof of peer receipt. */
  respond(message: JSONRPCResponse): void {
    if (message.id === undefined) return
    const response =
      "result" in message
        ? message.result
        : { isError: true, content: [{ type: "text", text: message.error.message }] }
    this.finish(message.id, { response })
  }

  /** Settle remaining calls, including requests rejected before dispatch. Safe to repeat. */
  finishRequest(input: { httpStatus: number; state: "finished" | "closed" }): void {
    this.ended = true
    for (const [id, pending] of this.pending) {
      this.finish(id, {
        httpStatus: input.httpStatus,
        transportState: input.state,
        ...(pending.detach ? { error: new Error("MCP request ended without a response.") } : {}),
      })
    }
  }

  private start(id: RequestId | symbol, tool: string, input: unknown): PendingCall {
    const existing = this.pending.get(id)
    if (existing) return existing
    const agent = getAgentIdentity()
    const call: ToolCall = {
      id: `call-${++nextCallId}`,
      tool,
      input,
      agent,
      taskSlugAtStart: agent?.taskSlug,
      startedAt: this.now(),
      inputTokens: this.observe(() => countTokens(JSON.stringify(input ?? {}))),
    }
    if (agent) {
      const usage = getAgentToolUsage(agent)
      agentToolUsage.set(agent, {
        ...usage,
        callCount: usage.callCount + 1,
        inputTokens: usage.inputTokens + (call.inputTokens ?? 0),
      })
    }
    const pending: PendingCall = { call, errors: [] }
    this.pending.set(id, pending)
    this.observe(() =>
      this.consumers.agentObserver?.observeToolCall({ ...call, status: "running" })
    )
    return pending
  }

  private finish(
    id: RequestId | symbol,
    outcome: Pick<CompletedToolCall, "response" | "error" | "httpStatus" | "transportState">
  ): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.detach?.()
    const error = outcome.error ?? pending.error
    const rejected = asRecord(outcome.response)?.isError === true
    const call: CompletedToolCall = {
      ...pending.call,
      ...outcome,
      error,
      errors: pending.errors,
      finishedAt: this.now(),
      outputTokens: this.observe(() => countResponseTokens(outcome.response)),
      status:
        rejected ||
        error !== undefined ||
        outcome.transportState === "closed" ||
        (outcome.httpStatus ?? 200) >= 400
          ? "failed"
          : "completed",
      // Keep raw metadata for audit summaries, unless SDK validation replaced a success.
      toolResult:
        rejected && asRecord(pending.toolResult)?.isError !== true
          ? outcome.response
          : pending.toolResult,
    }
    if (call.agent) {
      const usage = getAgentToolUsage(call.agent)
      agentToolUsage.set(call.agent, {
        ...usage,
        outputTokens: usage.outputTokens + (call.outputTokens ?? 0),
      })
    }
    this.observe(() => this.consumers.agentObserver?.observeToolCall(call))
    this.observe(() => this.consumers.auditLogger?.recordToolCall(call))
  }

  private observe<T>(operation: () => T): T | undefined {
    try {
      return operation()
    } catch (error) {
      console.warn("Could not record MCP tool activity:", error)
    }
  }
}

// Count what the model receives, including structured output and notices, rather than
// raw handler metadata or dashboard previews. Binary payloads have no text-token count.
function countResponseTokens(response: unknown): number | undefined {
  const record = asRecord(response)
  if (!record) return undefined
  const parts: string[] = []
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const block = asRecord(item)
      if (!block) continue
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
      else if (
        block.type !== "image" &&
        block.type !== "audio" &&
        !(block.type === "resource" && typeof asRecord(block.resource)?.blob === "string")
      ) {
        parts.push(JSON.stringify(block))
      }
    }
  }
  if (record.structuredContent !== undefined) parts.push(JSON.stringify(record.structuredContent))
  return parts.length ? countTokens(parts.join("\n")) : undefined
}
