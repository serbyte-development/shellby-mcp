import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import type { Page } from "playwright-core"

import { MCP_CONFIG } from "../src/config.js"
import {
  isConversationPayloadUrl,
  isExpectedAgentPage,
  waitForStableConversationLocation,
  type ManagedAgentPageState,
} from "../src/tools/subagent/chatgpt-subagent-browser.js"
import { observeAssistantResponse } from "../src/tools/subagent/chatgpt-subagent-observer.js"
import { ChatGptStructuredTurnTracker, extractConversationMessages, extractConversationNodes } from "../src/tools/subagent/chatgpt-subagent-protocol.js"
import { askSubagent, createChatGptSubagentRuntimeState, disposeSubagents } from "../src/tools/subagent/chatgpt-subagent.js"

function turnFrame(topicId: string, encodedItem: string): string {
  return JSON.stringify([
    {
      type: "message",
      topic_id: topicId,
      payload: {
        type: "conversation-turn-stream",
        payload: { type: "stream-item", encoded_item: encodedItem },
      },
    },
  ])
}

function deltaMessage(role: "user" | "assistant", text: string, options: { recipient?: string; status?: string; endTurn?: boolean | null } = {}): string {
  return `event: delta\ndata: ${JSON.stringify({
    v: {
      message: {
        id: `${role}-${Math.random()}`,
        author: { role },
        content: { content_type: "text", parts: [text] },
        status: options.status ?? "finished_successfully",
        end_turn: options.endTurn ?? null,
        metadata: {},
        recipient: options.recipient ?? "all",
      },
    },
  })}\n\n`
}

test("DOM response observation re-arms after first-turn navigation destroys its execution context", async () => {
  let domAttempts = 0
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async () => undefined,
        on: () => undefined,
        detach: async () => undefined,
      }),
    }),
    on: () => page,
    off: () => page,
    isClosed: () => false,
    mainFrame: () => ({}),
    waitForLoadState: async () => undefined,
    evaluate: async (_fn: unknown, argument?: Record<string, unknown>) => {
      if (!argument || !("prompt" in argument)) return undefined
      domAttempts += 1
      if (domAttempts === 1) throw new Error("Execution context was destroyed, most likely because of a navigation")
      return "rearmed mobile answer"
    },
  }

  const observation = await observeAssistantResponse(page as unknown as Page, {
    baselineDom: [],
    prompt: "mobile prompt",
    settleMs: 1,
  })

  assert.equal(await observation.response, "rearmed mobile answer")
  assert.equal(domAttempts, 2)
  await observation.dispose()
})

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

test("conversation payload URL matching follows the current ChatGPT saved-conversation route", () => {
  const conversationId = "conversation-1"

  assert.equal(
    isConversationPayloadUrl(`https://chatgpt.com/backend-api/conversations/${conversationId}?include_has_versions=true&num_turns=10`, conversationId),
    true
  )
  assert.equal(isConversationPayloadUrl(`https://chatgpt.com/backend-api/conversation/${conversationId}`, conversationId), false)
  assert.equal(isConversationPayloadUrl("https://chatgpt.com/backend-api/conversations/wrong-conversation", conversationId), false)
  assert.equal(isConversationPayloadUrl(`https://example.com/backend-api/conversations/${conversationId}`, conversationId), false)
})

test("start-time conversation binding ignores transient WEB routes and stores the stable ChatGPT URL", async () => {
  let currentUrl = "https://chatgpt.com/g/g-p-example/project"
  const page = {
    url: () => currentUrl,
    waitForURL: async (predicate: (url: URL) => boolean) => {
      assert.equal(predicate(new URL("https://chatgpt.com/c/WEB%3Atemporary-conversation-id")), false)
      currentUrl = "https://chatgpt.com/g/g-p-example-agentic-work/c/conversation-1"
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
  const runtime = createChatGptSubagentRuntimeState({ interactionDelayMs: 0 })
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
    context: () => ({
      newCDPSession: async () => ({
        send: async () => undefined,
        on: () => undefined,
        detach: async () => undefined,
      }),
    }),
    on: () => page,
    off: () => page,
    mainFrame: () => ({}),
    waitForLoadState: async () => undefined,
    evaluate: async (_fn: unknown, argument?: unknown) => {
      if (argument && typeof argument === "object" && "baseline" in argument) return new Promise<never>(() => undefined)
      return undefined
    },
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
  const state = {
    agentId: "modal-agent",
    page,
    lastUsedAt: Date.now(),
    turnCount: 0,
  }
  runtime.context = { pages: () => [page] } as never
  runtime.browser = { isConnected: () => true, close: async () => undefined } as never
  runtime.agents.set(state.agentId, state as never)

  const result = await askSubagent(runtime, {
    agentId: state.agentId,
    prompt: "Review this.",
    oververbosity: MCP_CONFIG.chatGpt.defaultOververbosity,
  })

  assert.equal(result.status, "running")
  assert.equal(composerClicks, 2)
  assert.equal(escapePresses, 1)
  await disposeSubagents(runtime)
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

test("WebSocket turn tracker reports activity only after binding the submitted prompt", () => {
  const activities: string[] = []
  const tracker = new ChatGptStructuredTurnTracker("review", (activity) => activities.push(activity))
  const topic = "conversation-turn-turn-1"

  tracker.ingestFrame(turnFrame("conversation-turn-unrelated", deltaMessage("user", "other prompt")))
  tracker.ingestFrame(turnFrame(topic, deltaMessage("user", "review")))
  tracker.ingestFrame(turnFrame(topic, deltaMessage("assistant", "searching", { recipient: "web.run", status: "in_progress", endTurn: false })))
  tracker.ingestFrame(turnFrame(topic, deltaMessage("assistant", "draft", { status: "in_progress", endTurn: false })))

  assert.deepEqual(activities, ["Working", "Searching the web", "Generating response"])
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

test("WebSocket turn tracker reconstructs the exact final assistant text from inherited delta patches", () => {
  const prompt = "review"
  const topic = "conversation-turn-turn-1"
  const tracker = new ChatGptStructuredTurnTracker(prompt)

  assert.equal(tracker.ingestFrame(turnFrame("conversation-turn-other", deltaMessage("user", prompt))), undefined)
  assert.equal(tracker.ingestFrame(turnFrame(topic, deltaMessage("user", prompt))), undefined)
  assert.equal(
    tracker.ingestFrame(
      turnFrame(
        topic,
        deltaMessage("assistant", "", {
          status: "in_progress",
          endTurn: null,
        })
      )
    ),
    undefined
  )
  assert.equal(
    tracker.ingestFrame(turnFrame(topic, 'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"## Findings\\n\\n"}\n\n')),
    undefined
  )
  assert.equal(tracker.ingestFrame(turnFrame(topic, 'event: delta\ndata: {"v":"- exact server response"}\n\n')), undefined)

  assert.equal(
    tracker.ingestFrame(
      turnFrame(
        topic,
        'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"\\n\\n```ts\\nconst answer = 42;\\n```"},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\n'
      )
    ),
    undefined
  )

  const final = tracker.ingestFrame(turnFrame(topic, 'data: {"type":"message_stream_complete","conversation_id":"conversation-1"}\n\n'))

  assert.equal(final, "## Findings\n\n- exact server response\n\n```ts\nconst answer = 42;\n```")
})

test("WebSocket turn tracker ignores final-looking output until the submitted prompt binds that topic", () => {
  const tracker = new ChatGptStructuredTurnTracker("expected prompt")
  const topic = "conversation-turn-turn-2"

  assert.equal(
    tracker.ingestFrame(
      turnFrame(
        topic,
        deltaMessage("assistant", "wrong conversation", {
          status: "finished_successfully",
          endTurn: true,
        })
      )
    ),
    undefined
  )

  tracker.ingestFrame(turnFrame(topic, deltaMessage("user", "expected prompt")))
  assert.equal(
    tracker.ingestFrame(
      turnFrame(
        topic,
        deltaMessage("assistant", "right conversation", {
          status: "finished_successfully",
          endTurn: true,
        })
      )
    ),
    undefined
  )
  assert.equal(tracker.ingestFrame(turnFrame(topic, 'data: {"type":"message_stream_complete","conversation_id":"conversation-1"}\n\n')), "right conversation")
})

test("structured turn tracker reconstructs a mobile HTTP SSE response", () => {
  const tracker = new ChatGptStructuredTurnTracker("mobile prompt")
  const response = [
    deltaMessage("user", "mobile prompt"),
    deltaMessage("assistant", "", { status: "in_progress", endTurn: null }),
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"mobile exact response"}\n\n',
    'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\n',
    'data: {"type":"message_stream_complete","conversation_id":"conversation-1"}\n\n',
    "data: [DONE]\n\n",
  ].join("")

  assert.equal(tracker.ingestSse(response), "mobile exact response")
})

test("HTTP completion cannot complete an assistant response that came from WebSocket", () => {
  const tracker = new ChatGptStructuredTurnTracker("review")
  const topic = "conversation-turn-turn-3"

  tracker.ingestSse(`${deltaMessage("user", "review")}data: {"type":"message_stream_complete"}\n\n`)
  tracker.ingestFrame(turnFrame(topic, deltaMessage("user", "review")))
  tracker.ingestFrame(turnFrame(topic, deltaMessage("assistant", "websocket answer", { status: "finished_successfully", endTurn: true })))

  assert.equal(tracker.ingestFrame(turnFrame(topic, 'data: {"type":"message_stream_complete"}\n\n')), "websocket answer")
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
