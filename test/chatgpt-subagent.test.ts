import assert from "node:assert/strict"
import test from "node:test"

import { MCP_CONFIG } from "../src/config.js"
import { ChatGptSubagentError, type ChatGptSubagentOptions } from "../src/tools/subagent/chatgpt-subagent-contracts.js"
import { ChatGptSubagentModule } from "../src/tools/subagent/chatgpt-subagent.js"

function createModule(options: ChatGptSubagentOptions = {}): ChatGptSubagentModule {
  return new ChatGptSubagentModule({ cdpEndpoint: "http://127.0.0.1:1", ...options })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
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

test("rate limit modal starts a 15-minute cooldown for new subagent turns", async () => {
  const module = createModule()
  let modalVisible = true
  let pageCreates = 0
  const page = {
    url: () => "https://chatgpt.com/",
    locator: (selector: string) => ({
      first: () => ({
        isVisible: async () => selector === '[data-testid="modal-conversation-history-rate-limit"]' && modalVisible,
      }),
    }),
  }
  const context = {
    pages: () => [page],
    newPage: async () => {
      pageCreates += 1
      throw new Error("should not create a page while rate limited")
    },
  }
  const internals = module as unknown as {
    context: typeof context
    connect(): Promise<void>
    rateLimitedUntil: number
  }
  internals.context = context
  internals.connect = async () => undefined

  const startedAt = Date.now()
  await assert.rejects(
    module.ask({ agentId: "rate-limited", prompt: "Review this.", oververbosity: MCP_CONFIG.chatGpt.defaultOververbosity }),
    (error: unknown) =>
      error instanceof ChatGptSubagentError &&
      error.code === "SUBAGENT_RATE_LIMITED" &&
      /15-minute cooldown/.test(error.message) &&
      /subagent_result/.test(error.message)
  )
  assert.ok(internals.rateLimitedUntil >= startedAt + 15 * 60_000)
  assert.equal(pageCreates, 0)

  modalVisible = false
  await assert.rejects(
    module.ask({ agentId: "still-rate-limited", prompt: "Review this too.", oververbosity: MCP_CONFIG.chatGpt.defaultOververbosity }),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_RATE_LIMITED"
  )
  assert.equal(pageCreates, 0)
  await module.dispose()
})

test("rate limit cooldown does not block retrieving an existing turn", async () => {
  const module = createModule()
  const turn = {
    turnId: "rate-limit-existing-turn",
    agentId: "rate-limit-existing-agent",
    status: "completed" as const,
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
    response: "finished",
  }
  const internals = module as unknown as {
    turns: Map<string, typeof turn>
    rateLimitedUntil: number
  }
  internals.turns.set(turn.turnId, turn)
  internals.rateLimitedUntil = Date.now() + 15 * 60_000

  const result = await module.poll(turn.turnId, 0)
  assert.equal(result.status, "completed")
  assert.equal(result.response, "finished")
  await module.dispose()
})

test("expired rate limit cooldown dismisses stale modals before new subagent work", async () => {
  const module = createModule()
  let modalVisible = true
  let gotItClicks = 0
  const modal = {
    isVisible: async () => modalVisible,
    getByRole: () => ({
      first: () => ({
        click: async () => {
          gotItClicks += 1
          modalVisible = false
        },
      }),
    }),
  }
  const page = {
    url: () => "https://chatgpt.com/",
    locator: () => ({ first: () => modal }),
  }
  const internals = module as unknown as {
    context: { pages(): Array<typeof page> }
    rateLimitedUntil: number
    clearExpiredRateLimit(): Promise<void>
  }
  internals.context = { pages: () => [page] }
  internals.rateLimitedUntil = Date.now() - 1

  await internals.clearExpiredRateLimit()

  assert.equal(gotItClicks, 1)
  assert.equal(modalVisible, false)
  assert.equal(internals.rateLimitedUntil, 0)
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
  const state = {
    agentId: "lost-before-conversation",
    page: { isClosed: () => true },
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    ensureActivePage(value: typeof state): Promise<unknown>
  }
  internals.agents.set(state.agentId, state)

  await assert.rejects(internals.ensureActivePage(state), (error: unknown) => error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST")
  assert.equal(internals.agents.has(state.agentId), false)
})

test("fails explicitly when a saved ChatGPT conversation was deleted", async () => {
  const module = createModule()
  let closes = 0
  const page = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/",
    goto: async () => undefined,
    close: async () => {
      closes += 1
    },
    locator: () => ({
      first: () => ({ isVisible: async () => false }),
    }),
    getByText: () => ({
      first: () => ({ isVisible: async () => false }),
    }),
    context: () => context,
  }
  const context = {
    newPage: async () => page,
    newCDPSession: async () => ({ send: async () => undefined, detach: async () => undefined }),
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
  await module.dispose()
})

test("subagent_result waits on shared turn settlement without reconciling ChatGPT", async () => {
  const module = createModule()
  const settlement = deferred()
  const turn = {
    turnId: "turn-test",
    agentId: "poll-test",
    status: "running" as "running" | "completed" | "failed",
    activity: "Searching the web" as const,
    lastActivityAt: Date.now() - 1_000,
    response: undefined as string | undefined,
    settled: settlement.promise,
  }
  const internals = module as unknown as { turns: Map<string, typeof turn> }
  internals.turns.set(turn.turnId, turn)

  const running = await module.poll(turn.turnId, 0)
  assert.equal(running.status, "running")
  assert.equal(running.activity, "Searching the web")

  setTimeout(() => {
    turn.status = "completed"
    turn.response = "finished"
    settlement.resolve()
  }, 10)

  const completed = await module.poll(turn.turnId, 100)
  assert.equal(completed.status, "completed")
  assert.equal(completed.response, "finished")
  await module.dispose()
})

test("shared assistant response completes a detached turn and releases capacity exactly once", async () => {
  const module = createModule()
  const settlement = deferred()
  let observationDisposals = 0
  const state = {
    agentId: "event-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
    },
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn = {
    turnId: "event-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
    observation: {
      response: Promise.resolve("```ts\nconst exact = true\n```"),
      dispose: async () => {
        observationDisposals += 1
      },
    },
    settled: settlement.promise,
    settle: settlement.resolve,
  }
  const internals = module as unknown as {
    waitForTurnResponse(value: typeof turn, agent: typeof state): Promise<void>
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    activeGenerationCount: number
  }
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1

  await internals.waitForTurnResponse(turn, state)

  assert.equal(turn.status, "completed")
  assert.equal((turn as typeof turn & { response?: string }).response, "```ts\nconst exact = true\n```")
  assert.equal(observationDisposals, 1)
  assert.equal(internals.activeTurnsByAgent.has(state.agentId), false)
  assert.equal(internals.activeAgentIds.has(state.agentId), false)
  assert.equal(internals.activeGenerationCount, 0)
  assert.deepEqual(module.drainEvents(), [`agent_finished:${state.agentId}:${turn.turnId}`])
  assert.deepEqual(module.drainEvents(), [])
  await module.dispose()
})

test("assistant observation failure gets one catastrophic recovery attempt before failing", async () => {
  const module = createModule()
  const settlement = deferred()
  let recoveryAttempts = 0
  const state = {
    agentId: "recovery-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
    },
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn = {
    turnId: "recovery-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
    tracking: { baselineDom: [], prompt: "review" },
    settled: settlement.promise,
    settle: settlement.resolve,
  }
  const internals = module as unknown as {
    failOrRecoverSubmittedTurn(value: typeof turn, agent: typeof state, error: unknown): Promise<void>
    recoverSubmittedTurn(value: typeof turn, agent: typeof state): Promise<void>
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    activeGenerationCount: number
  }
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1
  internals.recoverSubmittedTurn = async () => {
    recoveryAttempts += 1
    throw new Error("recovery failed")
  }

  await internals.failOrRecoverSubmittedTurn(turn, state, new Error("observation failed"))
  await internals.failOrRecoverSubmittedTurn(turn, state, new Error("second failure"))

  assert.equal(recoveryAttempts, 1)
  assert.equal(turn.status, "failed")
  assert.equal((turn as typeof turn & { errorMessage?: string }).errorMessage, "recovery failed")
  assert.equal(internals.activeGenerationCount, 0)
  await module.dispose()
})

test("catastrophic recovery opens the saved conversation in a fresh tab without reloading", async () => {
  const module = createModule()
  const settlement = deferred()
  const conversationUrl = "https://chatgpt.com/c/conversation-1"
  const exactResponse = "```ts\nconst recovered = true\n```"
  let oldCloses = 0
  let newPages = 0
  const oldPage = {
    isClosed: () => false,
    url: () => conversationUrl,
    close: async () => {
      oldCloses += 1
    },
  }
  const newPage = {
    isClosed: () => false,
    url: () => conversationUrl,
    goto: async () => undefined,
    close: async () => undefined,
    waitForResponse: async (predicate: (response: { url(): string; status(): number }) => boolean) => {
      const response = {
        url: () => "https://chatgpt.com/backend-api/conversation/conversation-1",
        status: () => 200,
        json: async () => ({
          current_node: "assistant-1",
          mapping: {
            user: {
              id: "user-1",
              parent: null,
              children: ["assistant-1"],
              message: {
                id: "user-1",
                author: { role: "user" },
                content: { parts: ["review"] },
                status: "finished_successfully",
                end_turn: null,
                metadata: {},
                recipient: "all",
              },
            },
            assistant: {
              id: "assistant-1",
              parent: "user-1",
              children: [],
              message: {
                id: "assistant-1",
                author: { role: "assistant" },
                content: { parts: [exactResponse] },
                status: "finished_successfully",
                end_turn: true,
                metadata: { is_complete: true },
                recipient: "all",
              },
            },
          },
        }),
      }
      assert.equal(predicate(response), true)
      return response
    },
    locator: (selector: string) => {
      if (selector === "[data-message-author-role]") return { count: async () => 1 }
      return { first: () => ({ isVisible: async () => false }) }
    },
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
    context: () => context,
  }
  const context = {
    newPage: async () => {
      newPages += 1
      return newPage
    },
    newCDPSession: async () => ({ send: async () => undefined, detach: async () => undefined }),
  }
  const state = {
    agentId: "catastrophic-agent",
    page: oldPage,
    hasSubmittedTurn: true,
    conversationId: "conversation-1",
    conversationUrl,
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn = {
    turnId: "catastrophic-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
    tracking: { baselineDom: [], prompt: "review" },
    settled: settlement.promise,
    settle: settlement.resolve,
  }
  const internals = module as unknown as {
    context: typeof context
    recoverSubmittedTurn(value: typeof turn, agent: typeof state): Promise<void>
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    activeGenerationCount: number
  }
  internals.context = context
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1

  await internals.recoverSubmittedTurn(turn, state)

  assert.equal(newPages, 1)
  assert.equal(oldCloses, 1)
  assert.equal(state.page, newPage)
  assert.equal(turn.status, "completed")
  assert.equal((turn as typeof turn & { response?: string }).response, exactResponse)
  assert.equal(internals.activeGenerationCount, 0)
  assert.deepEqual(module.drainEvents(), [`agent_finished:${state.agentId}:${turn.turnId}`])
  await module.dispose()
})

test("submitted turn without a saved conversation fails without catastrophic recovery", async () => {
  const module = createModule()
  const settlement = deferred()
  let recoveryAttempts = 0
  const state = {
    agentId: "unrecoverable-agent",
    page: { isClosed: () => false, url: () => "https://chatgpt.com/" },
    hasSubmittedTurn: true,
    lastUsedAt: Date.now(),
    turnCount: 1,
  }
  const turn = {
    turnId: "unrecoverable-agent_turn_1",
    agentId: state.agentId,
    status: "running" as "running" | "completed" | "failed",
    activity: "Generating response" as const,
    lastActivityAt: Date.now(),
    tracking: { baselineDom: [], prompt: "review" },
    settled: settlement.promise,
    settle: settlement.resolve,
  }
  const internals = module as unknown as {
    failOrRecoverSubmittedTurn(value: typeof turn, agent: typeof state, error: unknown): Promise<void>
    recoverSubmittedTurn(value: typeof turn, agent: typeof state): Promise<void>
    activeTurnsByAgent: Map<string, string>
    activeAgentIds: Set<string>
    activeGenerationCount: number
  }
  internals.recoverSubmittedTurn = async () => {
    recoveryAttempts += 1
  }
  internals.activeTurnsByAgent.set(state.agentId, turn.turnId)
  internals.activeAgentIds.add(state.agentId)
  internals.activeGenerationCount = 1

  await internals.failOrRecoverSubmittedTurn(turn, state, new Error("browser failed"))

  assert.equal(recoveryAttempts, 0)
  assert.equal(turn.status, "failed")
  assert.equal(internals.activeGenerationCount, 0)
  await module.dispose()
})

test("dispose closes managed agent pages but leaves user-repurposed tabs alone", async () => {
  const module = createModule()
  let managedCloses = 0
  let repurposedCloses = 0
  let browserCloses = 0
  const managed = {
    agentId: "managed",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        managedCloses += 1
      },
    },
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
    conversationId: "conversation-2",
    conversationUrl: "https://chatgpt.com/c/conversation-2",
  }
  const internals = module as unknown as {
    agents: Map<string, typeof managed | typeof repurposed>
    browser: { close(): Promise<void> }
  }
  internals.agents.set(managed.agentId, managed)
  internals.agents.set(repurposed.agentId, repurposed)
  internals.browser = {
    close: async () => {
      browserCloses += 1
    },
  }

  await module.dispose()

  assert.equal(managedCloses, 1)
  assert.equal(repurposedCloses, 0)
  assert.equal(browserCloses, 1)
})

test("expires idle agent tabs and local completed turn state", async () => {
  const module = createModule()
  let closes = 0
  const state = {
    agentId: "idle-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        closes += 1
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
  assert.equal(internals.agents.has(state.agentId), false)
  assert.equal(internals.turns.size, 0)
  assert.deepEqual(module.drainEvents(), [])
  await module.dispose()
})

test("30-minute active-turn deadline reuses observed progress and preserves conversation recovery metadata", async () => {
  const module = createModule()
  let closes = 0
  let observationDisposals = 0
  const settlement = deferred()
  const state = {
    agentId: "long-running-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        closes += 1
      },
    },
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
    observation: {
      response: new Promise<string>(() => undefined),
      dispose: async () => {
        observationDisposals += 1
      },
    },
    settled: settlement.promise,
    settle: settlement.resolve,
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
  assert.equal(observationDisposals, 1)
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
