import assert from "node:assert/strict"
import test from "node:test"

import {
  ChatGptConversationTracker,
  ChatGptSubagentError,
  ChatGptSubagentModule,
  extractConversationMessages,
  extractConversationNodes,
} from "../src/tools/subagent/chatgpt-subagent.js"

test("module fails clearly when the expected Chrome CDP endpoint is unavailable", async () => {
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
    connectTimeoutMs: 250,
  })

  await assert.rejects(module.connect(), /already-running debuggable Chrome instance.*attach-only.*will not launch Chrome/i)
})

test("hard caps concurrent generations at three", async () => {
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
    maxConcurrentAgents: 99,
  })
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
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
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
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
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

test("keeps an unbound new-chat page through ChatGPT's transient web conversation route", async () => {
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
  const state = {
    agentId: "transient-new-chat",
    page: {
      isClosed: () => false,
      url: () => "https://chatgpt.com/c/WEB%3Atemporary-conversation-id",
    },
    tracker: { dispose() {} },
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    ensureActivePage(value: typeof state): Promise<typeof state>
  }
  internals.agents.set(state.agentId, state)

  const active = await internals.ensureActivePage(state)

  assert.equal(active, state)
  assert.deepEqual(module.listAgents(), [
    {
      agentId: state.agentId,
      conversationId: undefined,
      conversationUrl: undefined,
      targetId: undefined,
      pageClosed: false,
    },
  ])
})

test("fails explicitly when a saved ChatGPT conversation was deleted", async () => {
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
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
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
  let finish!: () => void
  const completion = new Promise<void>((resolve) => {
    finish = resolve
  })
  const turn = {
    turnId: "turn-test",
    agentId: "poll-test",
    status: "running" as "running" | "completed" | "failed",
    activity: "Searching the web" as const,
    lastActivityAt: Date.now() - 1_000,
    completion,
    response: undefined as string | undefined,
  }
  const internals = module as unknown as {
    turns: Map<string, typeof turn>
  }
  internals.turns.set(turn.turnId, turn)

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

  setTimeout(() => {
    turn.status = "completed"
    turn.response = "finished"
    finish()
  }, 10)

  const completed = await module.poll(turn.turnId, 100)
  assert.equal(completed.status, "completed")
  assert.equal(completed.response, "finished")
})

test("poll reconciles a completed DOM response that background tracking missed", async () => {
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
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
  const controller = new AbortController()
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
    controller,
    completion: new Promise<void>(() => undefined),
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    turns: Map<string, typeof turn>
  }
  internals.agents.set(state.agentId, state)
  internals.turns.set(turn.turnId, turn)

  const result = await module.poll(turn.turnId)

  assert.equal(result.status, "completed")
  assert.equal(result.response, "recovered answer")
  assert.equal(result.messageId, "message-1")
  assert.equal(controller.signal.aborted, true)
  await module.dispose()
})

test("tracker emits coarse activity only when observed conversation state changes", () => {
  const tracker = new ChatGptConversationTracker()
  const activities: string[] = []
  tracker.setActivityListener((activity) => activities.push(activity))

  const webNode = {
    id: "tool-1",
    message: {
      id: "tool-1",
      author: { role: "assistant" },
      content: { parts: ["searching"] },
      status: "in_progress",
      end_turn: false,
      metadata: { working_turn_id: "turn-1" },
      recipient: "web.run",
    },
    children: [],
  }

  tracker.ingestPayload(webNode)
  tracker.ingestPayload(webNode)
  tracker.ingestPayload({
    ...webNode,
    message: {
      ...webNode.message,
      content: { parts: ["searching more"] },
    },
  })
  tracker.ingestPayload({
    id: "assistant-1",
    message: {
      id: "assistant-1",
      author: { role: "assistant" },
      content: { parts: ["draft"] },
      status: "in_progress",
      end_turn: false,
      metadata: { working_turn_id: "turn-1" },
      recipient: "all",
    },
    children: [],
  })

  assert.deepEqual(activities, ["Searching the web", "Searching the web", "Generating response"])
})

test("dispose closes managed agent pages but leaves user-repurposed tabs alone", async () => {
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
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
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
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
    completion: Promise.resolve(),
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    turns: Map<string, typeof turn>
    cleanupIdleAgents(now: number): Promise<void>
  }
  internals.agents.set(state.agentId, state)
  internals.turns.set(turn.turnId, turn)

  await internals.cleanupIdleAgents(1_000 + 30 * 60_000)

  assert.equal(closes, 1)
  assert.equal(trackerDisposals, 1)
  assert.deepEqual(module.listAgents(), [])
  assert.equal(internals.turns.size, 0)
  await module.dispose()
})

test("uses active-turn progress for idle expiry and preserves conversation recovery metadata", async () => {
  const module = new ChatGptSubagentModule({
    cdpEndpoint: "http://127.0.0.1:1",
  })
  let closes = 0
  const controller = new AbortController()
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
    controller,
    completion: new Promise<void>(() => undefined),
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
  assert.equal(controller.signal.aborted, true)
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

test("extractConversationNodes normalizes ChatGPT mapping nodes", () => {
  const payload = {
    mapping: {
      user: {
        id: "u1",
        message: {
          id: "u1",
          author: { role: "user" },
          create_time: 10,
          content: { content_type: "text", parts: ["hello"] },
          status: "finished_successfully",
          metadata: { turn_exchange_id: "turn-1" },
          recipient: "all",
        },
        parent: null,
        children: ["tool"],
      },
      tool: {
        id: "tool",
        message: {
          id: "tool",
          author: { role: "assistant" },
          create_time: 11,
          content: { content_type: "code", text: "internal" },
          status: "finished_successfully",
          end_turn: false,
          metadata: { is_complete: true, turn_exchange_id: "turn-1" },
          recipient: "web.run",
        },
        parent: "u1",
        children: ["a1"],
      },
      assistant: {
        id: "a1",
        message: {
          id: "a1",
          author: { role: "assistant" },
          create_time: 12,
          content: { content_type: "text", parts: ["final answer"] },
          status: "finished_successfully",
          end_turn: true,
          metadata: { is_complete: true, turn_exchange_id: "turn-1" },
          recipient: "all",
        },
        parent: "tool",
        children: [],
      },
    },
  }

  const nodes = extractConversationNodes(payload)
  assert.equal(nodes.length, 3)
  assert.equal(nodes.find((node) => node.id === "a1")?.message.text, "final answer")
})

test("tracker returns only the new final assistant response for a turn", () => {
  const tracker = new ChatGptConversationTracker()
  tracker.ingestPayload({
    id: "old",
    message: {
      id: "old",
      author: { role: "assistant" },
      create_time: 1,
      content: { parts: ["old response"] },
      status: "finished_successfully",
      end_turn: true,
      metadata: { is_complete: true },
      recipient: "all",
    },
    children: [],
  })
  const baseline = tracker.snapshotIds()

  tracker.ingestPayload([
    {
      id: "u2",
      message: {
        id: "u2",
        author: { role: "user" },
        create_time: 2,
        content: { parts: ["next question"] },
        status: "finished_successfully",
        metadata: { turn_exchange_id: "turn-2" },
        recipient: "all",
      },
      parent: "old",
      children: ["tool2"],
    },
    {
      id: "tool2",
      message: {
        id: "tool2",
        author: { role: "assistant" },
        create_time: 3,
        content: { text: "tool payload" },
        status: "finished_successfully",
        end_turn: false,
        metadata: { is_complete: true, turn_exchange_id: "turn-2" },
        recipient: "web.run",
      },
      parent: "u2",
      children: ["a2"],
    },
    {
      id: "a2",
      message: {
        id: "a2",
        author: { role: "assistant" },
        create_time: 4,
        content: { parts: ["new response"] },
        status: "finished_successfully",
        end_turn: true,
        metadata: { is_complete: true, turn_exchange_id: "turn-2" },
        recipient: "all",
      },
      parent: "tool2",
      children: [],
    },
  ])

  const result = tracker.findFinalResponse({
    baselineIds: baseline,
    prompt: "next question",
    sentAtSeconds: 2,
  })

  assert.equal(result?.id, "a2")
  assert.equal(result?.message.text, "new response")
})

test("tracker does not return an already-seen assistant response", () => {
  const tracker = new ChatGptConversationTracker()
  tracker.ingestPayload({
    id: "a1",
    message: {
      id: "a1",
      author: { role: "assistant" },
      create_time: 1,
      content: { parts: ["answer"] },
      status: "finished_successfully",
      end_turn: true,
      metadata: { is_complete: true },
      recipient: "all",
    },
    children: [],
  })

  assert.equal(tracker.findFinalResponse({ baselineIds: tracker.snapshotIds() }), undefined)
})

test("tracker rejects completed assistant nodes that explicitly do not end the turn", () => {
  const tracker = new ChatGptConversationTracker()
  const baseline = tracker.snapshotIds()
  tracker.ingestPayload({
    id: "intermediate",
    message: {
      id: "intermediate",
      author: { role: "assistant" },
      create_time: 5,
      content: { parts: ["not final"] },
      status: "finished_successfully",
      end_turn: false,
      metadata: { is_complete: true },
      recipient: "all",
    },
    children: [],
  })

  assert.equal(tracker.findFinalResponse({ baselineIds: baseline }), undefined)
})

test("extractConversationMessages follows the active branch and excludes tool nodes", () => {
  const payload = {
    current_node: "a2",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["u1"] },
      u1: {
        id: "u1",
        message: {
          id: "u1",
          author: { role: "user" },
          content: { parts: ["first"] },
          status: "finished_successfully",
          recipient: "all",
          metadata: {},
        },
        parent: "root",
        children: ["a1"],
      },
      a1: {
        id: "a1",
        message: {
          id: "a1",
          author: { role: "assistant" },
          content: { parts: ["one"] },
          status: "finished_successfully",
          end_turn: true,
          recipient: "all",
          metadata: { is_complete: true },
        },
        parent: "u1",
        children: ["u2"],
      },
      u2: {
        id: "u2",
        message: {
          id: "u2",
          author: { role: "user" },
          content: { parts: ["second"] },
          status: "finished_successfully",
          recipient: "all",
          metadata: {},
        },
        parent: "a1",
        children: ["tool"],
      },
      tool: {
        id: "tool",
        message: {
          id: "tool",
          author: { role: "assistant" },
          content: { text: "internal" },
          status: "finished_successfully",
          end_turn: false,
          recipient: "web.run",
          metadata: { is_complete: true },
        },
        parent: "u2",
        children: ["a2"],
      },
      a2: {
        id: "a2",
        message: {
          id: "a2",
          author: { role: "assistant" },
          content: { parts: ["two"] },
          status: "finished_successfully",
          end_turn: true,
          recipient: "all",
          metadata: { is_complete: true },
        },
        parent: "tool",
        children: [],
      },
    },
  }

  assert.deepEqual(extractConversationMessages(payload), [
    { id: "u1", role: "user", text: "first" },
    { id: "a1", role: "assistant", text: "one" },
    { id: "u2", role: "user", text: "second" },
    { id: "a2", role: "assistant", text: "two" },
  ])
})
