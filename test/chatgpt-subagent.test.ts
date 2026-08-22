import assert from "node:assert/strict"
import test from "node:test"

import { MCP_CONFIG } from "../src/config.js"
import { ChatGptSubagentError, type ChatGptSubagentOptions } from "../src/tools/subagent/chatgpt-subagent-contracts.js"
import {
  askSubagent,
  beginAgentOperation,
  cleanupIdleAgents,
  clearExpiredRateLimit,
  createAgent,
  createChatGptSubagentRuntimeState,
  createChatGptSubagentService,
  disposeSubagents,
  endAgentOperation,
  ensureActivePage,
  failOrRecoverSubmittedTurn,
  pollSubagent,
  recoverSubmittedTurn,
  waitForTurnResponse,
  type BrowserAgentState,
  type BrowserTurnState,
  type ChatGptSubagentRuntimeState,
} from "../src/tools/subagent/chatgpt-subagent.js"

function createRuntime(options: ChatGptSubagentOptions = {}): ChatGptSubagentRuntimeState {
  return createChatGptSubagentRuntimeState({ cdpEndpoint: "http://127.0.0.1:1", ...options })
}

function installBackgroundPage(runtime: ChatGptSubagentRuntimeState, page: object, targetId = "background-target-1"): unknown[] {
  const existingPage = { isClosed: () => false }
  const pages: object[] = [existingPage]
  const createTargetCalls: unknown[] = []

  runtime.context = {
    pages: () => pages,
    newCDPSession: async (candidate: object) => ({
      send: async (method: string) => {
        assert.equal(candidate, page)
        assert.equal(method, "Target.getTargetInfo")
        return { targetInfo: { targetId } }
      },
      detach: async () => undefined,
    }),
  } as never
  runtime.browser = {
    newBrowserCDPSession: async () => ({
      send: async (method: string, params?: unknown) => {
        if (method === "Target.createTarget") {
          createTargetCalls.push(params)
          pages.push(page)
          return { targetId }
        }
        if (method === "Target.closeTarget") return { success: true }
        throw new Error(`unexpected CDP method: ${method}`)
      },
      detach: async () => undefined,
    }),
  } as never

  return createTargetCalls
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function runningTurn(agentId: string, overrides: Partial<BrowserTurnState> = {}): BrowserTurnState {
  const settlement = deferred()
  return {
    turnId: `${agentId}_turn_1`,
    agentId,
    status: "running",
    recoveryAttempted: false,
    activity: "Generating response",
    lastActivityAt: Date.now(),
    prompt: "review",
    settled: settlement.promise,
    settle: settlement.resolve,
    ...overrides,
  }
}

test("starts new subagent conversations from normal ChatGPT when no project URL is configured", () => {
  assert.equal(createRuntime().chatGptUrl, "https://chatgpt.com/")
  assert.equal(createRuntime({ chatGptUrl: "https://chatgpt.com/g/example/project" }).chatGptUrl, "https://chatgpt.com/g/example/project")
})

test("service fails clearly when the expected Chrome CDP endpoint is unavailable", async () => {
  const service = createChatGptSubagentService({ cdpEndpoint: "http://127.0.0.1:1", connectTimeoutMs: 250 })
  await assert.rejects(service.connect(), /already-running debuggable Chrome instance.*attach-only.*will not launch Chrome/i)
  await service.dispose()
})

test("hard caps concurrent generations at three", () => {
  const runtime = createRuntime({ maxConcurrentAgents: 99 })

  beginAgentOperation(runtime, "agent-a")
  beginAgentOperation(runtime, "agent-b")
  beginAgentOperation(runtime, "agent-c")
  assert.throws(
    () => beginAgentOperation(runtime, "agent-d"),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CAPACITY_REACHED" && /capacity is 3/.test(error.message)
  )

  endAgentOperation(runtime, "agent-a")
  endAgentOperation(runtime, "agent-b")
  endAgentOperation(runtime, "agent-c")
  assert.equal(runtime.activeOperations.size, 0)
})

test("rate limit modal starts a 15-minute cooldown for new subagent turns", async () => {
  const runtime = createRuntime()
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
  runtime.context = { pages: () => [page] } as never
  runtime.browser = {
    isConnected: () => true,
    close: async () => undefined,
    newBrowserCDPSession: async () => {
      pageCreates += 1
      throw new Error("should not create a page while rate limited")
    },
  } as never

  const startedAt = Date.now()
  await assert.rejects(
    askSubagent(runtime, { agentId: "rate-limited", prompt: "Review this.", oververbosity: MCP_CONFIG.chatGpt.defaultOververbosity }),
    (error: unknown) =>
      error instanceof ChatGptSubagentError &&
      error.code === "SUBAGENT_RATE_LIMITED" &&
      /15-minute cooldown/.test(error.message) &&
      /subagent_result/.test(error.message)
  )
  assert.ok(runtime.rateLimitedUntil >= startedAt + 15 * 60_000)
  assert.equal(pageCreates, 0)
  assert.equal(runtime.activeOperations.size, 0)

  modalVisible = false
  await assert.rejects(
    askSubagent(runtime, { agentId: "still-rate-limited", prompt: "Review this too.", oververbosity: MCP_CONFIG.chatGpt.defaultOververbosity }),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_RATE_LIMITED"
  )
  assert.equal(pageCreates, 0)
  await disposeSubagents(runtime)
})

test("rate limit cooldown does not block retrieving an existing turn", async () => {
  const runtime = createRuntime()
  const turn = runningTurn("rate-limit-existing-agent", {
    turnId: "rate-limit-existing-turn",
    status: "completed",
    response: "finished",
  })
  runtime.turns.set(turn.turnId, turn)
  runtime.rateLimitedUntil = Date.now() + 15 * 60_000

  const result = await pollSubagent(runtime, turn.turnId, 0)
  assert.equal(result.status, "completed")
  assert.equal(result.response, "finished")
})

test("expired rate limit cooldown dismisses stale modals before new subagent work", async () => {
  const runtime = createRuntime()
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
  runtime.context = { pages: () => [page] } as never
  runtime.rateLimitedUntil = Date.now() - 1

  await clearExpiredRateLimit(runtime)

  assert.equal(gotItClicks, 1)
  assert.equal(modalVisible, false)
  assert.equal(runtime.rateLimitedUntil, 0)
})

test("creates managed subagent pages as unfocused background Chrome targets", async () => {
  const runtime = createRuntime()
  let currentUrl = "about:blank"
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    setViewportSize: async () => undefined,
    goto: async (url: string) => {
      currentUrl = url
    },
    close: async () => undefined,
    locator: (selector: string) => ({
      first: () => ({
        count: async () => (selector === "#prompt-textarea" ? 1 : 0),
        isVisible: async () => selector === "#prompt-textarea",
      }),
    }),
  }
  const createTargetCalls = installBackgroundPage(runtime, page)

  const agent = await createAgent(runtime, "background-agent")

  assert.equal(agent.page, page)
  assert.deepEqual(createTargetCalls, [{ url: "about:blank", background: true, focus: false }])
})

test("forgets an agent whose page is lost before a conversation can be recovered", async () => {
  const runtime = createRuntime()
  const agent = {
    agentId: "lost-before-conversation",
    page: { isClosed: () => true },
    lastUsedAt: Date.now(),
    turnCount: 0,
  } as unknown as BrowserAgentState
  runtime.agents.set(agent.agentId, agent)

  await assert.rejects(ensureActivePage(runtime, agent), (error: unknown) => error instanceof ChatGptSubagentError && error.code === "AGENT_TARGET_LOST")
  assert.equal(runtime.agents.has(agent.agentId), false)
})

test("fails explicitly when a saved ChatGPT conversation was deleted", async () => {
  const runtime = createRuntime()
  let closes = 0
  const page = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/",
    setViewportSize: async () => undefined,
    goto: async () => undefined,
    close: async () => {
      closes += 1
    },
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
  }
  const createTargetCalls = installBackgroundPage(runtime, page, "deleted-agent-target")
  runtime.conversationRefs.set("deleted-agent", {
    conversationId: "deleted-conversation",
    conversationUrl: "https://chatgpt.com/c/deleted-conversation",
    turnCount: 3,
  })

  await assert.rejects(
    createAgent(runtime, "deleted-agent"),
    (error: unknown) => error instanceof ChatGptSubagentError && error.code === "SUBAGENT_CONVERSATION_NOT_FOUND"
  )
  assert.equal(closes, 1)
  assert.equal(createTargetCalls.length, 1)
  assert.equal(runtime.conversationRefs.has("deleted-agent"), true)
})

test("subagent_result waits on shared turn settlement without reconciling ChatGPT", async () => {
  const runtime = createRuntime()
  const settlement = deferred()
  const turn = runningTurn("poll-test", {
    turnId: "turn-test",
    activity: "Searching the web",
    lastActivityAt: Date.now() - 1_000,
    settled: settlement.promise,
    settle: settlement.resolve,
  })
  runtime.turns.set(turn.turnId, turn)

  const running = await pollSubagent(runtime, turn.turnId, 0)
  assert.equal(running.status, "running")
  assert.equal(running.activity, "Searching the web")

  setTimeout(() => {
    turn.status = "completed"
    turn.response = "finished"
    settlement.resolve()
  }, 10)

  const completed = await pollSubagent(runtime, turn.turnId, 100)
  assert.equal(completed.status, "completed")
  assert.equal(completed.response, "finished")
})

test("shared assistant response completes a detached turn and releases capacity exactly once", async () => {
  const runtime = createRuntime()
  let observationDisposals = 0
  const agent = {
    agentId: "event-agent",
    page: { isClosed: () => false, url: () => "https://chatgpt.com/c/conversation-1" },
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: Date.now(),
    turnCount: 1,
  } as BrowserAgentState
  const turn = runningTurn(agent.agentId, {
    observation: {
      response: Promise.resolve("```ts\nconst exact = true\n```"),
      dispose: async () => {
        observationDisposals += 1
      },
    },
  })
  runtime.activeOperations.set(agent.agentId, turn.turnId)

  await waitForTurnResponse(runtime, turn, agent)

  assert.equal(turn.status, "completed")
  assert.equal(turn.response, "```ts\nconst exact = true\n```")
  assert.equal(observationDisposals, 1)
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
  assert.deepEqual(runtime.pendingEvents.splice(0), [`agent_finished:${agent.agentId}:${turn.turnId}`])
  assert.deepEqual(runtime.pendingEvents.splice(0), [])
})

test("assistant observation failure gets one catastrophic recovery attempt before failing", async () => {
  const runtime = createRuntime()
  let recoveryAttempts = 0
  const agent = {
    agentId: "recovery-agent",
    page: { isClosed: () => false, url: () => "https://chatgpt.com/c/conversation-1" },
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: Date.now(),
    turnCount: 1,
  } as BrowserAgentState
  const turn = runningTurn(agent.agentId)
  runtime.activeOperations.set(agent.agentId, turn.turnId)
  const recover = async () => {
    recoveryAttempts += 1
    throw new Error("recovery failed")
  }

  await failOrRecoverSubmittedTurn(runtime, turn, agent, new Error("observation failed"), undefined, recover)
  await failOrRecoverSubmittedTurn(runtime, turn, agent, new Error("second failure"), undefined, recover)

  assert.equal(recoveryAttempts, 1)
  assert.equal(turn.status, "failed")
  assert.equal(turn.errorMessage, "recovery failed")
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
})

test("catastrophic recovery opens the saved conversation in a fresh tab without reloading", async () => {
  const runtime = createRuntime()
  const conversationUrl = "https://chatgpt.com/c/conversation-1"
  const exactResponse = "```ts\nconst recovered = true\n```"
  let oldCloses = 0
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
    setViewportSize: async () => undefined,
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
  }
  const createTargetCalls = installBackgroundPage(runtime, newPage, "catastrophic-recovery-target")
  const agent = {
    agentId: "catastrophic-agent",
    page: oldPage,
    conversationId: "conversation-1",
    conversationUrl,
    lastUsedAt: Date.now(),
    turnCount: 1,
  } as unknown as BrowserAgentState
  const turn = runningTurn(agent.agentId)
  runtime.activeOperations.set(agent.agentId, turn.turnId)

  await recoverSubmittedTurn(runtime, turn, agent)

  assert.equal(createTargetCalls.length, 1)
  assert.equal(oldCloses, 1)
  assert.equal(agent.page, newPage)
  assert.equal(turn.status, "completed")
  assert.equal(turn.response, exactResponse)
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
  assert.deepEqual(runtime.pendingEvents.splice(0), [`agent_finished:${agent.agentId}:${turn.turnId}`])
})

test("submitted turn without a saved conversation fails without catastrophic recovery", async () => {
  const runtime = createRuntime()
  let recoveryAttempts = 0
  const agent = {
    agentId: "unrecoverable-agent",
    page: { isClosed: () => false, url: () => "https://chatgpt.com/" },
    lastUsedAt: Date.now(),
    turnCount: 1,
  } as unknown as BrowserAgentState
  const turn = runningTurn(agent.agentId)
  runtime.activeOperations.set(agent.agentId, turn.turnId)

  await failOrRecoverSubmittedTurn(runtime, turn, agent, new Error("browser failed"), undefined, async () => {
    recoveryAttempts += 1
  })

  assert.equal(recoveryAttempts, 0)
  assert.equal(turn.status, "failed")
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
})

test("dispose closes managed agent pages but leaves user-repurposed tabs alone", async () => {
  const runtime = createRuntime()
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
    lastUsedAt: Date.now(),
    turnCount: 1,
  } as BrowserAgentState
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
    lastUsedAt: Date.now(),
    turnCount: 1,
  } as BrowserAgentState
  runtime.agents.set(managed.agentId, managed)
  runtime.agents.set(repurposed.agentId, repurposed)
  runtime.browser = {
    close: async () => {
      browserCloses += 1
    },
  } as never

  await disposeSubagents(runtime)

  assert.equal(managedCloses, 1)
  assert.equal(repurposedCloses, 0)
  assert.equal(browserCloses, 1)
})

test("expires idle agent tabs and local completed turn state", async () => {
  const runtime = createRuntime()
  let closes = 0
  const agent = {
    agentId: "idle-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        closes += 1
      },
    },
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: 1_000,
    turnCount: 2,
  } as BrowserAgentState
  const turn = runningTurn(agent.agentId, {
    turnId: "idle-agent_turn_2",
    status: "completed",
    lastActivityAt: 1_000,
  })
  runtime.agents.set(agent.agentId, agent)
  runtime.turns.set(turn.turnId, turn)
  runtime.pendingEvents.push(`agent_finished:${agent.agentId}:${turn.turnId}`)

  await cleanupIdleAgents(runtime, 1_000 + 30 * 60_000)

  assert.equal(closes, 1)
  assert.equal(runtime.agents.has(agent.agentId), false)
  assert.equal(runtime.turns.size, 0)
  assert.deepEqual(runtime.pendingEvents, [])
})

test("30-minute active-turn deadline reuses observed progress and preserves conversation recovery metadata", async () => {
  const runtime = createRuntime()
  let closes = 0
  let observationDisposals = 0
  const agent = {
    agentId: "long-running-agent",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/conversation-1",
      close: async () => {
        closes += 1
      },
    },
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    lastUsedAt: 1_000,
    turnCount: 4,
  } as BrowserAgentState
  const turn = runningTurn(agent.agentId, {
    turnId: "long-running-agent_turn_4",
    activity: "Using tools",
    lastActivityAt: 1_000,
    observation: {
      response: new Promise<string>(() => undefined),
      dispose: async () => {
        observationDisposals += 1
      },
    },
  })
  runtime.agents.set(agent.agentId, agent)
  runtime.turns.set(turn.turnId, turn)
  runtime.activeOperations.set(agent.agentId, turn.turnId)

  await cleanupIdleAgents(runtime, 1_000 + 29 * 60_000)
  assert.equal(closes, 0)
  assert.equal(runtime.agents.has(agent.agentId), true)
  assert.equal(runtime.activeOperations.get(agent.agentId), turn.turnId)

  await cleanupIdleAgents(runtime, 1_000 + 30 * 60_000)
  assert.equal(closes, 1)
  assert.equal(observationDisposals, 1)
  assert.equal(runtime.agents.has(agent.agentId), false)
  assert.equal(runtime.turns.has(turn.turnId), false)
  assert.equal(runtime.activeOperations.has(agent.agentId), false)
  assert.deepEqual(runtime.conversationRefs.get(agent.agentId), {
    conversationId: "conversation-1",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    turnCount: 4,
  })
})
