import { EventEmitter } from "node:events"
import {
  type AgentToolUsage,
  getAgentToolUsage,
  type ToolCallEvent,
} from "../mcp/tool-call-tracker.js"
import { type AgentIdentity, subscribeToAgentParents } from "./context.js"
import { presentToolCall, presentToolResponse } from "./tool-call-presentation.js"

type AgentCallStatus = "running" | "completed" | "failed"

interface AgentCallSnapshot {
  id: string
  tool: string
  summary: string
  detail?: string
  detailLanguage?: string
  response?: string
  /** Full call token counts from the tracker, unaffected by dashboard projection. */
  inputTokens?: number
  outputTokens?: number
  startedAt: number
  finishedAt?: number
  status: AgentCallStatus
}

interface AgentInstructionSnapshot {
  id: string
  message: string
  createdAt: number
  deliveredAt?: number
}

interface AgentSnapshot {
  id: string
  parentId?: string
  taskSlug?: string
  firstSeenAt: number
  lastSeenAt: number
  toolUsage: AgentToolUsage
  current?: AgentCallSnapshot
  recent: AgentCallSnapshot[]
  instructions: AgentInstructionSnapshot[]
}

interface AgentState extends Omit<AgentSnapshot, "toolUsage"> {
  identity: AgentIdentity
  activeCalls: Map<string, AgentCallSnapshot>
}

interface AgentObserverEvent {
  type: "agent_changed"
  agent: AgentSnapshot
}

export interface AgentObserver {
  listAgents(): AgentSnapshot[]
  /** Project ordered lifecycle events into bounded dashboard history. */
  observeToolCall(call: ToolCallEvent): void
  queueInstruction(agentId: string, message: string): AgentInstructionSnapshot | undefined
  cancelInstruction(agentId: string, instructionId: string): boolean
  drainInstructions(agent: AgentIdentity | undefined): string[]
  subscribe(listener: (event: AgentObserverEvent) => void): () => void
}

const MAX_RECENT_CALLS = 12
const MAX_INSTRUCTIONS = 12

export function createAgentObserver(now: () => number = () => Date.now()): AgentObserver {
  const agentsBySession = new Map<string, AgentState>()
  const sessionsByAgentId = new Map<string, string>()
  const events = new EventEmitter()
  let instructionCounter = 0

  function listAgents(): AgentSnapshot[] {
    return [...agentsBySession.values()]
      .map(toSnapshot)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
  }

  function ensureAgent(
    identity: AgentIdentity | undefined,
    timestamp: number
  ): AgentState | undefined {
    if (!identity) return undefined
    const existing = agentsBySession.get(identity.sessionId)
    if (existing) {
      existing.taskSlug = identity.taskSlug
      existing.lastSeenAt = timestamp
      return existing
    }

    const state: AgentState = {
      id: identity.agent,
      taskSlug: identity.taskSlug,
      identity,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      recent: [],
      instructions: [],
      activeCalls: new Map(),
    }
    agentsBySession.set(identity.sessionId, state)
    sessionsByAgentId.set(identity.agent, identity.sessionId)
    return state
  }

  function emitAgent(agent: AgentState): void {
    events.emit("event", {
      type: "agent_changed",
      agent: toSnapshot(agent),
    } satisfies AgentObserverEvent)
  }

  function observeToolCall(event: ToolCallEvent): void {
    const timestamp = event.status === "running" ? event.startedAt : event.finishedAt
    const agent = ensureAgent(event.agent, timestamp)
    if (!agent) return
    const call: AgentCallSnapshot = {
      id: event.id,
      tool: event.tool,
      ...presentToolCall(event.tool, event.input),
      startedAt: event.startedAt,
      inputTokens: event.inputTokens,
      status: event.status,
      ...(event.status === "running"
        ? {}
        : {
            finishedAt: event.finishedAt,
            outputTokens: event.outputTokens,
            ...(event.response === undefined
              ? {}
              : { response: presentToolResponse(event.response) }),
          }),
    }
    if (event.status === "running") agent.activeCalls.set(call.id, call)
    else {
      agent.activeCalls.delete(call.id)
      agent.recent = [call, ...agent.recent].slice(0, MAX_RECENT_CALLS)
    }
    agent.current = latestActiveCall(agent.activeCalls)
    agent.lastSeenAt = timestamp
    emitAgent(agent)
  }

  function queueInstruction(
    agentId: string,
    message: string
  ): AgentInstructionSnapshot | undefined {
    const sessionId = sessionsByAgentId.get(agentId)
    const agent = sessionId ? agentsBySession.get(sessionId) : undefined
    const trimmed = message.trim()
    if (!agent || !trimmed) return undefined
    const instruction: AgentInstructionSnapshot = {
      id: `instruction-${++instructionCounter}`,
      message: trimmed,
      createdAt: now(),
    }
    agent.instructions = [instruction, ...agent.instructions].slice(0, MAX_INSTRUCTIONS)
    emitAgent(agent)
    return { ...instruction }
  }

  function cancelInstruction(agentId: string, instructionId: string): boolean {
    const sessionId = sessionsByAgentId.get(agentId)
    const agent = sessionId ? agentsBySession.get(sessionId) : undefined
    if (!agent) return false
    const instruction = agent.instructions.find((item) => item.id === instructionId)
    if (!instruction || instruction.deliveredAt !== undefined) return false
    agent.instructions = agent.instructions.filter((item) => item.id !== instructionId)
    emitAgent(agent)
    return true
  }

  function drainInstructions(identity: AgentIdentity | undefined): string[] {
    if (!identity) return []
    const agent = agentsBySession.get(identity.sessionId)
    if (!agent) return []
    const timestamp = now()
    const pending = agent.instructions.filter(
      (instruction) => instruction.deliveredAt === undefined
    )
    if (pending.length === 0) return []
    const pendingIds = new Set(pending.map((instruction) => instruction.id))
    agent.instructions = agent.instructions.map((instruction) =>
      pendingIds.has(instruction.id) ? { ...instruction, deliveredAt: timestamp } : instruction
    )
    agent.lastSeenAt = timestamp
    emitAgent(agent)
    return pending.reverse().map((instruction) => `Human instruction: ${instruction.message}`)
  }

  function subscribe(listener: (event: AgentObserverEvent) => void): () => void {
    events.on("event", listener)
    const unsubscribeParents = subscribeToAgentParents((identity) => {
      const agent = agentsBySession.get(identity.sessionId)
      if (agent) listener({ type: "agent_changed", agent: toSnapshot(agent) })
    })
    return () => {
      events.off("event", listener)
      unsubscribeParents()
    }
  }

  return {
    listAgents,
    observeToolCall,
    queueInstruction,
    cancelInstruction,
    drainInstructions,
    subscribe,
  }
}

function latestActiveCall(calls: Map<string, AgentCallSnapshot>): AgentCallSnapshot | undefined {
  let latest: AgentCallSnapshot | undefined
  for (const call of calls.values()) {
    if (!latest || call.startedAt >= latest.startedAt) latest = call
  }
  return latest
}

function toSnapshot(agent: AgentState): AgentSnapshot {
  return {
    id: agent.id,
    parentId: agent.identity.parent?.agent,
    taskSlug: agent.taskSlug,
    firstSeenAt: agent.firstSeenAt,
    lastSeenAt: agent.lastSeenAt,
    toolUsage: getAgentToolUsage(agent.identity),
    current: agent.current ? { ...agent.current } : undefined,
    recent: agent.recent.map((call) => ({ ...call })),
    instructions: agent.instructions.map((instruction) => ({ ...instruction })),
  }
}
