import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { getAgentIdentity, runWithAgent } from "../../../src/agent/context.js"
import { MCP_CONFIG } from "../../../src/config.js"
import { createDelegationStore } from "../../../src/tools/delegation/store.js"
import { ChatGptDelegationError } from "../../../src/tools/delegation/subagent-error.js"
import { createSubagents } from "../../../src/tools/delegation/subagents.js"
import { sendAgentMessage } from "../../fixtures/subagents.js"

for (const limit of [1, 3, 5]) {
  test(`limits each main agent to ${limit} persisted delegated agents while allowing reuse`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "shellby-agent-limit-"))
    const previousStateDir = MCP_CONFIG.stateDir
    MCP_CONFIG.stateDir = directory
    const previousLimit = MCP_CONFIG.chatGpt.maxDelegatedAgents
    MCP_CONFIG.chatGpt.maxDelegatedAgents = limit
    t.after(() => {
      MCP_CONFIG.stateDir = previousStateDir
      MCP_CONFIG.chatGpt.maxDelegatedAgents = previousLimit
      rmSync(directory, { recursive: true, force: true })
    })

    const sessionId = "delegated-agent-limit-session"
    const parentAgent = runWithAgent(sessionId, () => getAgentIdentity()!)
    const store = createDelegationStore(join(directory, "subagents.sqlite"))
    assert.ok(store)
    for (let index = 1; index <= limit; index++) {
      store.set(parentAgent, `agent-${index}`, {
        conversationUrl: `https://chatgpt.com/c/agent-${index}`,
        turnCount: index,
      })
    }
    store.close()

    const service = createSubagents()
    const controller = new AbortController()
    controller.abort()
    const existing = Array.from({ length: limit }, (_, index) => `agent-${index + 1}`).join(", ")
    const expectedMessage = `This main agent already has the maximum ${limit} delegated agents. Reuse one of these agent IDs: ${existing}.`

    try {
      await assert.rejects(
        runWithAgent(sessionId, () =>
          sendAgentMessage(
            service,
            { agentId: "extra", prompt: "New work" },
            { signal: controller.signal }
          )
        ),
        (error: unknown) =>
          error instanceof ChatGptDelegationError &&
          error.code === "AGENT_LIMIT_REACHED" &&
          error.message === expectedMessage
      )
      await assert.rejects(
        runWithAgent(sessionId, () =>
          sendAgentMessage(
            service,
            { agentId: "agent-1", prompt: "Follow up" },
            { signal: controller.signal }
          )
        ),
        (error: unknown) =>
          error instanceof ChatGptDelegationError && error.code === "REQUEST_ABORTED"
      )
      // Other sessions have their own quota, and raising the configured limit opens another slot.
      await assert.rejects(
        runWithAgent("other-session", () =>
          sendAgentMessage(
            service,
            { agentId: "extra", prompt: "New work" },
            { signal: controller.signal }
          )
        ),
        (error: unknown) =>
          error instanceof ChatGptDelegationError && error.code === "REQUEST_ABORTED"
      )
      MCP_CONFIG.chatGpt.maxDelegatedAgents = limit + 1
      await assert.rejects(
        runWithAgent(sessionId, () =>
          sendAgentMessage(
            service,
            { agentId: "extra", prompt: "New work" },
            { signal: controller.signal }
          )
        ),
        (error: unknown) =>
          error instanceof ChatGptDelegationError && error.code === "REQUEST_ABORTED"
      )
    } finally {
      await service.dispose()
    }
  })
}

test("drains persisted delegated agents once after service restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-agent-events-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  t.after(() => {
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })

  const sessionId = "persisted-agent-events-session"
  const parentAgent = runWithAgent(sessionId, () => getAgentIdentity()!)
  const store = createDelegationStore(join(directory, "subagents.sqlite"))
  assert.ok(store)
  store.set(parentAgent, "reviewer", {
    conversationUrl: "https://chatgpt.com/c/reviewer",
    turnCount: 1,
  })
  store.set(parentAgent, "tester", {
    conversationUrl: "https://chatgpt.com/c/tester",
    turnCount: 3,
  })
  store.close()

  const service = createSubagents()
  try {
    assert.deepEqual(
      runWithAgent(sessionId, () => service.drainEvents()),
      ["existing_agent agent_id=reviewer", "existing_agent agent_id=tester"]
    )
    assert.deepEqual(
      runWithAgent(sessionId, () => service.drainEvents()),
      []
    )
  } finally {
    await service.dispose()
  }
})
