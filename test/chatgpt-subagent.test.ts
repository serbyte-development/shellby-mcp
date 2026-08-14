import assert from "node:assert/strict"
import test from "node:test"

import { ChatGptConversationTracker } from "../src/tools/subagent/chatgpt-subagent-browser.js"
import { ChatGptSubagentError, type ChatGptSubagentOptions } from "../src/tools/subagent/chatgpt-subagent-contracts.js"
import { ChatGptSubagentModule } from "../src/tools/subagent/chatgpt-subagent.js"

function createModule(options: ChatGptSubagentOptions = {}): ChatGptSubagentModule {
  return new ChatGptSubagentModule({ cdpEndpoint: "http://127.0.0.1:1", ...options })
}

test("module fails clearly when the expected Chrome CDP endpoint is unavailable", async () => {
  const module = createModule({ connectTimeoutMs: 250 })

  await assert.rejects(module.connect(), /already-running debuggable Chrome instance.*attach-only.*will not launch Chrome/i)
})

test("hard caps concurrent generations at three", async () => {
  const module = createModule({ maxConcurrentAgents: 99 })
  const internals = module as unknown as {
    beginAgentOperation(agentId: string, generation: boolean): void
    endAgentOperation(agentId: string, generation: boolean): void
  }

  internals.beginAgentOperation("agent-a", true)
  internals.beginAgentOperation("agent-b", true)
  internals.beginAgentOperation("agent-c", true)
  assert.throws(
    () => internals.beginAgentOperation("agent-d", true),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CAPACITY_REACHED" && /capacity is 3/.test(error.message)
  )

  internals.endAgentOperation("agent-a", true)
  internals.endAgentOperation("agent-b", true)
  internals.endAgentOperation("agent-c", true)
  await module.dispose()
})

test("browser visibility hook is best effort", async () => {
  let calls = 0
  const module = createModule({
    onPageCreated: () => {
      calls += 1
      throw new Error("hide failed")
    },
  })
  const internals = module as unknown as { afterPageCreated(): Promise<void> }

  await internals.afterPageCreated()

  assert.equal(calls, 1)
  await module.dispose()
})

test("forgets an agent whose page is lost before a conversation can be recovered", async () => {
  const module = createModule()
  let trackerDisposed = false
  const state = {
    agentId: "lost-before-conversation",
    page: {
      isClosed: () => true,
    },
    tracker: {
      dispose: () => {
        trackerDisposed = true
      },
    },
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    ensureActivePage(value: typeof state): Promise<unknown>
  }
  internals.agents.set(state.agentId, state)

  await assert.rejects(internals.ensureActivePage(state), (error: unknown) => error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST")

  assert.equal(trackerDisposed, true)
  assert.deepEqual(module.listAgents(), [])
})

test("fails explicitly when a saved ChatGPT conversation was deleted", async () => {
  const module = createModule()
  let closes = 0
  const page = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/",
    goto: async () => undefined,
    on() {},
    off() {},
    close: async () => {
      closes += 1
    },
    locator: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    getByText: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
  }
  const context = {
    newPage: async () => page,
  }
  const internals = module as unknown as {
    context: typeof context
    conversationRefs: Map<string, { conversationId: string; conversationUrl: string; turnCount: number }>
    createAgent(agentId: string): Promise<unknown>
  }
  internals.context = context
  internals.conversationRefs.set("deleted-agent", {
    conversationId: "deleted-conversation",
    conversationUrl: "https://chatgpt.com/c/deleted-conversation",
    turnCount: 3,
  })

  await assert.rejects(
    internals.createAgent("deleted-agent"),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CONVERSATION_NOT_FOUND"
  )

  assert.equal(closes, 1)
  assert.equal(internals.conversationRefs.has("deleted-agent"), true)
  await assert.rejects(
    internals.createAgent("deleted-agent"),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CONVERSATION_NOT_FOUND"
  )
  assert.equal(closes, 2)
  await module.dispose()
})

test("poll returns immediately while a turn runs and can wait for completion", async () => {
  const module = createModule()
  const turn = {
    turnId: "turn-test",
    agentId: "poll-test",
    status: "running" as "running" | "completed" | "failed",
    activity: "Searching the web" as const,
    lastActivityAt: Date.now() - 1_000,
    response: undefined as string | undefined,
  }
  let reconciles = 0
  const internals = module as unknown as {
    turns: Map<string, typeof turn>
    reconcileRunningTurn(value: typeof turn): Promise<void>
  }
  internals.turns.set(turn.turnId, turn)
  internals.reconcileRunningTurn = async () => {
    reconciles += 1
    if (reconciles < 2) return
    turn.status = "completed"
    turn.response = "finished"
  }

  const running = await module.poll(turn.turnId)
  assert.equal(running.agentId, "poll-test")
  assert.equal(running.turnId, "turn-test")
  assert.equal(running.status, "running")
  assert.equal(running.activity, "Searching the web")
  assert.ok((running.activityAgeMs ?? 0) >= 1_000)
  assert.ok((running.activityAgeMs ?? Number.POSITIVE_INFINITY) < 2_000)
  assert.deepEqual(
    {
      conversationId: running.conversationId,
      conversationUrl: running.conversationUrl,
      messageId: running.messageId,
      response: running.response,
      errorCode: running.errorCode,
      errorMessage: running.errorMessage,
    },
    {
      conversationId: undefined,
      conversationUrl: undefined,
      messageId: undefined,
      response: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    }
  )

  const completed = await module.poll(turn.turnId, 100)
  assert.equal(completed.status, "completed")
  assert.equal(completed.response, "finished")
  assert.equal(reconciles, 2)
})

test("poll reconciles a completed DOM response and releases the generation slot", async () => {
  const module = createModule()
  const page = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/c/conversation-1",
    close: async () => undefined,
    locator: (selector: string) => {
      if (selector === '[data-message-author-role="assistant"]') {
        return {
          evaluateAll: async () => [
            {
              key: "message-1",
              messageId: "message-1",
              text: "recovered answer",
            },
          ],
        }
      }
      return {
        first: () => ({
          count: async () => 0,
          isVisible: async () => false,
        }),
      }
    },
  }
  const tracker = {
    findFinalResponse: () => undefined,
    setActivityListener() {},
    setUpdateListener() {},
    dispose() {},
  }
  const state = {
    agentId: "reconcile-agent",
    page,
    tracker,
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn = {
    turnId: "reconcile-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now() - 10_000,
    conversationId: state.conversationId,
    conversationUrl: state.conversationUrl,
    tracking: {
      baselineNetworkIds: new Set<string>(),
      baselineDom: [],
      prompt: "review",
      sentAtSeconds: Date.now() / 1000 - 10,
    },
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    turns: Map<string, typeof turn>
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    activeGenerationCount: number
  }
  internals.agents.set(state.agentId, state)
  internals.turns.set(turn.turnId, turn)
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1

  const result = await module.poll(turn.turnId)

  assert.equal(result.status, "completed")
  assert.equal(result.response, "recovered answer")
  assert.equal(result.messageId, "message-1")
  assert.equal(internals.activeTurnsByAgent.has(state.agentId), false)
  assert.equal(internals.activeAgentIds.has(state.agentId), false)
  assert.equal(internals.activeGenerationCount, 0)
  await module.dispose()
})

test("submitted turn shares one conversation recovery attempt before a later failure becomes terminal", async () => {
  const module = createModule()
  const state = {
    agentId: "recovery-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
    },
    tracker: {
      setActivityListener() {},
      setUpdateListener() {},
      dispose() {},
    },
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn: {
    turnId: string
    agentId: string
    status: "running" | "completed" | "failed"
    recoveryAttempted?: boolean
    activity: "Generating response"
    lastActivityAt: number
    conversationId?: string
    conversationUrl?: string
    errorCode?: string
    errorMessage?: string
  } = {
    turnId: "recovery-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
    conversationId: state.conversationId,
    conversationUrl: state.conversationUrl,
  }
  let recoveryAttempts = 0
  let finishRecovery!: (value: boolean) => void
  const internals = module as unknown as {
    failOrRecoverSubmittedTurn(value: typeof turn, agent: typeof state, error: unknown): Promise<"retry" | "terminal">
    recoverSubmittedTurn(value: typeof turn, agent: typeof state): Promise<boolean>
  }
  internals.recoverSubmittedTurn = () => {
    recoveryAttempts += 1
    return new Promise<boolean>((resolve) => {
      finishRecovery = resolve
    })
  }

  const trackingFailure = internals.failOrRecoverSubmittedTurn(turn, state, new Error("transient tracking failure"))
  const pollingFailure = internals.failOrRecoverSubmittedTurn(turn, state, new Error("concurrent polling failure"))

  assert.equal(recoveryAttempts, 1)
  finishRecovery(true)
  assert.deepEqual(await Promise.all([trackingFailure, pollingFailure]), ["retry", "retry"])
  assert.equal(turn.status, "running")
  assert.equal(turn.recoveryAttempted, true)

  await internals.failOrRecoverSubmittedTurn(turn, state, new Error("second browser observation failure"))

  assert.equal(recoveryAttempts, 1)
  assert.equal(turn.status, "failed")
  assert.equal(turn.errorCode, "subagent_failed")
  assert.equal(turn.errorMessage, "second browser observation failure")
  await module.dispose()
})

test("passive network completion finishes a turn, releases capacity, and queues one event", async () => {
  const module = createModule()
  const tracker = new ChatGptConversationTracker()
  const state = {
    agentId: "passive-agent",
    page: {
      url: () => "https://chatgpt.com/c/conversation-1",
    },
    tracker,
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn = {
    turnId: "passive-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
    conversationId: state.conversationId,
    conversationUrl: state.conversationUrl,
    tracking: {
      baselineNetworkIds: new Set<string>(),
      baselineDom: [],
      prompt: "review",
      sentAtSeconds: Date.now() / 1000 - 10,
    },
  }
  const internals = module as unknown as {
    attachTurnListeners(agent: typeof state, value: typeof turn): void
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    activeGenerationCount: number
  }
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1
  internals.attachTurnListeners(state, turn)

  tracker.ingestPayload({
    mapping: {
      user: {
        id: "user",
        message: {
          id: "user",
          author: { role: "user" },
          content: { parts: ["review"] },
          create_time: Date.now() / 1000 - 5,
        },
        children: ["assistant-final"],
      },
      final: {
        id: "assistant-final",
        parent: "user",
        message: {
          id: "assistant-final",
          author: { role: "assistant" },
          content: { parts: ["finished"] },
          status: "finished_successfully",
          end_turn: true,
          metadata: { is_complete: true },
          recipient: "all",
          create_time: Date.now() / 1000,
        },
        children: [],
      },
    },
  })

  assert.equal(turn.status, "completed")
  assert.equal((turn as typeof turn & { response?: string }).response, "finished")
  assert.equal(internals.activeTurnsByAgent.has(state.agentId), false)
  assert.equal(internals.activeAgentIds.has(state.agentId), false)
  assert.equal(internals.activeGenerationCount, 0)
  assert.deepEqual(module.drainEvents(), [`agent_finished:${state.agentId}:${turn.turnId}`])
  assert.deepEqual(module.drainEvents(), [])
  await module.dispose()
})

test("submitted turn without saved conversation fails without attempting recovery", async () => {
  const module = createModule()
  const state = {
    agentId: "unrecoverable-agent",
    page: { isClosed: () => false },
    tracker: {
      setActivityListener() {},
      setUpdateListener() {},
      dispose() {},
    },
    hasSubmittedTurn: true,
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn: {
    turnId: string
    agentId: string
    status: "running" | "completed" | "failed"
    recoveryAttempted?: boolean
    activity: "Generating response"
    lastActivityAt: number
    errorCode?: string
    errorMessage?: string
  } = {
    turnId: "unrecoverable-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
  }
  let recoveryAttempts = 0
  const internals = module as unknown as {
    failOrRecoverSubmittedTurn(value: typeof turn, agent: typeof state, error: unknown): Promise<void>
    recoverSubmittedTurn(value: typeof turn, agent: typeof state): Promise<boolean>
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    activeGenerationCount: number
  }
  internals.recoverSubmittedTurn = async () => {
    recoveryAttempts += 1
    return true
  }
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1

  await internals.failOrRecoverSubmittedTurn(turn, state, new Error("browser failed"))

  assert.equal(recoveryAttempts, 0)
  assert.equal(turn.status, "failed")
  assert.equal(internals.activeTurnsByAgent.has(state.agentId), false)
  assert.equal(internals.activeAgentIds.has(state.agentId), false)
  assert.equal(internals.activeGenerationCount, 0)
  await module.dispose()
})

test("dispose closes managed agent pages but leaves user-repurposed tabs alone", async () => {
  const module = createModule()
  let managedCloses = 0
  let repurposedCloses = 0
  const tracker = { dispose() {} }
  const managed = {
    agentId: "managed",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        managedCloses += 1
      },
    },
    tracker,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
  }
  const repurposed = {
    agentId: "repurposed",
    page: {
      isClosed: () => false,
      url: () => "https://example.com/",
      close: async () => {
        repurposedCloses += 1
      },
    },
    tracker,
    conversationId: "conversation-2",
    conversationUrl: "https://chatgpt.com/c/conversation-2",
  }
  const internals = module as unknown as {
    agents: Map<string, typeof managed | typeof repurposed>
  }
  internals.agents.set(managed.agentId, managed)
  internals.agents.set(repurposed.agentId, repurposed)

  await module.dispose()

  assert.equal(managedCloses, 1)
  assert.equal(repurposedCloses, 0)
  assert.deepEqual(module.listAgents(), [])
})

test("expires idle agent tabs and local turn state", async () => {
  const module = createModule()
  let closes = 0
  let trackerDisposals = 0
  const state = {
    agentId: "idle-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        closes += 1
      },
    },
    tracker: {
      dispose() {
        trackerDisposals += 1
      },
    },
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: 1_000,
    turnCount: 2,
  }
  const turn = {
    turnId: "idle-agent_turn_2",
    agentId: state.agentId,
    status: "completed" as const,
    activity: "Generating response" as const,
    lastActivityAt: 1_000,
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    turns: Map<string, typeof turn>
    pendingEvents: string[]
    cleanupIdleAgents(now: number): Promise<void>
  }
  internals.agents.set(state.agentId, state)
  internals.turns.set(turn.turnId, turn)
  internals.pendingEvents.push(`agent_finished:${state.agentId}:${turn.turnId}`)

  await internals.cleanupIdleAgents(1_000 + 30 * 60_000)

  assert.equal(closes, 1)
  assert.equal(trackerDisposals, 1)
  assert.deepEqual(module.listAgents(), [])
  assert.equal(internals.turns.size, 0)
  assert.deepEqual(module.drainEvents(), [])
  await module.dispose()
})

test("uses active-turn progress for idle expiry and preserves conversation recovery metadata", async () => {
  const module = createModule()
  let closes = 0
  const state = {
    agentId: "long-running-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        closes += 1
      },
    },
    tracker: { dispose() {} },
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: 1_000,
    turnCount: 4,
  }
  const turn = {
    turnId: "long-running-agent_turn_4",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Using tools" as const,
    lastActivityAt: 1_000,
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    turns: Map<string, typeof turn>
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    conversationRefs: Map<string, { conversationId: string; conversationUrl: string; turnCount: number }>
    activeGenerationCount: number
    cleanupIdleAgents(now: number): Promise<void>
  }
  internals.agents.set(state.agentId, state)
  internals.turns.set(turn.turnId, turn)
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1

  await internals.cleanupIdleAgents(1_000 + 29 * 60_000)
  assert.equal(closes, 0)
  assert.equal(internals.agents.has(state.agentId), true)
  assert.equal(internals.activeGenerationCount, 1)

  await internals.cleanupIdleAgents(1_000 + 30 * 60_000)
  assert.equal(closes, 1)
  assert.equal(internals.agents.has(state.agentId), false)
  assert.equal(internals.turns.has(turn.turnId), false)
  assert.equal(internals.activeGenerationCount, 0)
  assert.deepEqual(internals.conversationRefs.get(state.agentId), {
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    turnCount: 4,
  })
  await module.dispose()
})
