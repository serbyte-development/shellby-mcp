import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { MCP_CONFIG } from "../src/config.js"
import {
  ChatGptConversationTracker,
  extractConversationMessages,
  extractConversationNodes,
  isExpectedAgentPage,
  waitForStableConversationLocation,
  type ManagedAgentPageState,
} from "../src/tools/subagent/chatgpt-subagent-browser.js"
import type { ChatGptSubagentOptions } from "../src/tools/subagent/chatgpt-subagent-contracts.js"
import { ChatGptSubagentModule } from "../src/tools/subagent/chatgpt-subagent.js"

function createModule(options: ChatGptSubagentOptions = {}): ChatGptSubagentModule {
  return new ChatGptSubagentModule({ cdpEndpoint: "http://127.0.0.1:1", ...options })
}

test("frozen real ChatGPT conversation fixture preserves the expected user and fenced Markdown assistant messages", async () => {
  const payload = JSON.parse(await readFile(new URL("./fixtures/chatgpt-live-fixture/conversation.json", import.meta.url), "utf8")) as unknown
  const messages = extractConversationMessages(payload)

  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, "user")
  assert.ok(messages[0]?.text.includes("This is a live integration fixture."))
  assert.equal(messages[1]?.role, "assistant")
  assert.ok(messages[1]?.text.includes("LIVE_SUBAGENT_FIXTURE_BEGIN"))
  assert.ok(messages[1]?.text.includes("## Live Fixture"))
  assert.ok(messages[1]?.text.includes("inline `code`"))
  assert.ok(messages[1]?.text.includes("```md\n### Nested Markdown\nCONTEXT_KEY: LIVE_CTX_b9536da73e8e\n```"))
  assert.ok(messages[1]?.text.includes("```ts\nconst answer: number = 42;\n```"))
  assert.ok(messages[1]?.text.includes("| fixture | ok |"))
  assert.equal(messages[1]?.text.match(/LONG_LINE:(x+)/)?.[1]?.length, 320)
  assert.ok(messages[1]?.text.endsWith("LIVE_SUBAGENT_FIXTURE_END"))
})

test("start-time conversation binding ignores transient WEB routes and stores the stable ChatGPT URL", async () => {
  let currentUrl = "https://chatgpt.com/g/g-p-6a863444b7d08191bffa3e468da73458/project"
  const page = {
    url: () => currentUrl,
    waitForURL: async (predicate: (url: URL) => boolean) => {
      assert.equal(predicate(new URL("https://chatgpt.com/c/WEB%3Atemporary-conversation-id")), false)
      currentUrl = "https://chatgpt.com/g/g-p-6a863444b7d08191bffa3e468da73458-agentic-work/c/conversation-1"
      assert.equal(predicate(new URL(currentUrl)), true)
    },
  }
  const state = {
    agentId: "binding-agent",
    page,
    conversationId: undefined as string | undefined,
    conversationUrl: undefined as string | undefined,
  }

  const bound = await waitForStableConversationLocation(state as unknown as ManagedAgentPageState, 5_000)

  assert.equal(bound, true)
  assert.equal(state.conversationId, "conversation-1")
  assert.equal(state.conversationUrl, currentUrl)
})

test("subagent start dismisses a ChatGPT modal that races with composer interaction and retries only the blocked click", async () => {
  const module = createModule({ interactionDelayMs: 0 })
  let modalVisible = false
  let composerClicks = 0
  let escapePresses = 0
  const composer = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => {
      composerClicks += 1
      if (composerClicks === 1) {
        modalVisible = true
        throw new Error("modal intercepts pointer events")
      }
    },
    press: async () => undefined,
  }
  const emptyLocator = {
    count: async () => 0,
    isVisible: async () => false,
    isEnabled: async () => false,
  }
  const page = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/",
    locator: (selector: string) => ({
      first: () => {
        if (selector === '#modal-beacon, [data-testid="modal-beacon"]') {
          return {
            count: async () => 1,
            isVisible: async () => modalVisible,
          }
        }
        if (selector === "#prompt-textarea") return composer
        if (selector === '[data-message-author-role="assistant"]') {
          return {
            ...emptyLocator,
            evaluateAll: async () => [],
          }
        }
        if (selector.includes("send-button")) {
          return {
            count: async () => 1,
            isVisible: async () => true,
            isEnabled: async () => true,
            click: async () => undefined,
          }
        }
        return emptyLocator
      },
      evaluateAll: async () => [],
    }),
    keyboard: {
      insertText: async () => undefined,
      press: async (key: string) => {
        if (key === "Escape") {
          escapePresses += 1
          modalVisible = false
        }
      },
    },
    close: async () => undefined,
  }
  const tracker = {
    snapshotIds: () => new Set<string>(),
    setActivityListener() {},
    setUpdateListener() {},
    findFinalResponse: () => undefined,
    dispose() {},
  }
  const state = {
    agentId: "modal-agent",
    page,
    tracker,
    hasSubmittedTurn: false,
    lastUsedAt: Date.now(),
    turnCount: 0,
  }
  const internals = module as unknown as {
    agents: Map<string, typeof state>
    connect(): Promise<void>
  }
  internals.connect = async () => undefined
  internals.agents.set(state.agentId, state)

  const result = await module.ask({
    agentId: state.agentId,
    prompt: "Review this.",
    oververbosity: MCP_CONFIG.chatGpt.defaultOververbosity,
  })

  assert.equal(result.status, "running")
  assert.equal(composerClicks, 2)
  assert.equal(escapePresses, 1)
  await module.dispose()
})

test("unbound new-chat pages accept ChatGPT's transient web conversation route", () => {
  const state = {
    agentId: "transient-new-chat",
    page: {
      url: () => "https://chatgpt.com/c/WEB%3Atemporary-conversation-id",
    },
  } as unknown as ManagedAgentPageState

  assert.equal(isExpectedAgentPage(state), true)
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

test("extractConversationNodes preserves fenced Markdown from server content parts exactly", () => {
  const response = "```md\n## Findings\n\n- exact server response\n```"
  const nodes = extractConversationNodes({
    id: "assistant-markdown",
    message: {
      id: "assistant-markdown",
      author: { role: "assistant" },
      content: { content_type: "text", parts: [response] },
      status: "finished_successfully",
      end_turn: true,
      metadata: { is_complete: true },
      recipient: "all",
    },
    children: [],
  })

  assert.equal(nodes[0]?.message.text, response)
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

test("tracker rejects an unrelated completed conversation when the submitted prompt is absent", () => {
  const tracker = new ChatGptConversationTracker()
  const baseline = tracker.snapshotIds()
  tracker.ingestPayload([
    {
      id: "other-user",
      message: {
        id: "other-user",
        author: { role: "user" },
        create_time: 10,
        content: { parts: ["Send the market report."] },
        status: "finished_successfully",
        metadata: { turn_exchange_id: "other-turn" },
        recipient: "all",
      },
      children: ["other-assistant"],
    },
    {
      id: "other-assistant",
      message: {
        id: "other-assistant",
        author: { role: "assistant" },
        create_time: 11,
        content: { parts: ["Market report complete."] },
        status: "finished_successfully",
        end_turn: true,
        metadata: { is_complete: true, turn_exchange_id: "other-turn" },
        recipient: "all",
      },
      parent: "other-user",
      children: [],
    },
  ])

  assert.equal(
    tracker.findFinalResponse({
      baselineIds: baseline,
      prompt: "Review the implementation.",
      sentAtSeconds: 9,
    }),
    undefined
  )
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

test("tracker rejects completed assistant nodes until ChatGPT marks end_turn true", () => {
  const tracker = new ChatGptConversationTracker()
  const baseline = tracker.snapshotIds()
  tracker.ingestPayload({
    id: "thinking",
    message: {
      id: "thinking",
      author: { role: "assistant" },
      create_time: 5,
      content: { parts: ["Thinking"] },
      status: "finished_successfully",
      end_turn: null,
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
    { role: "user", text: "first" },
    { role: "assistant", text: "one" },
    { role: "user", text: "second" },
    { role: "assistant", text: "two" },
  ])
})
