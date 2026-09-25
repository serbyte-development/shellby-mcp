import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

import { type AgentIdentity, getAgentIdentity, runWithAgent } from "../../../src/agent/context.js"
import { MCP_CONFIG } from "../../../src/config.js"
import { ChatGptDelegationError } from "../../../src/tools/delegation/contracts.js"
import { DelegationLifecycle } from "../../../src/tools/delegation/lifecycle.js"

test("retains the latest 100 settled turns per caller in completion order and preserves running turns", (t) => {
  const lifecycle = createLifecycle(t)
  const now = Date.now()
  const otherCaller = runWithAgent("other-retention-caller", () => getAgentIdentity()!)
  const other = submit(lifecycle, "worker", now, otherCaller)
  lifecycle.completeTurn(other, "other caller", now)
  const slow = submit(lifecycle, "slow", now)
  const active = submit(lifecycle, "active", now)

  for (let index = 1; index <= 100; index++) {
    const turn = submit(lifecycle, "worker", now)
    lifecycle.completeTurn(turn, `response ${index}`, now + index)
  }
  lifecycle.completeTurn(slow, "finished later", now + 101)
  const latest = submit(lifecycle, "worker", now + 102)
  lifecycle.completeTurn(latest, "latest response", now + 102)

  for (const turnId of ["worker_turn_1", "worker_turn_2"]) {
    assert.throws(() => lifecycle.requireTurn(undefined, turnId), { code: "UNKNOWN_TURN" })
  }
  assert.equal(lifecycle.requireTurn(undefined, "worker_turn_3").response, "response 3")
  assert.equal(lifecycle.requireTurn(undefined, slow.turnId).response, "finished later")
  assert.equal(lifecycle.requireTurn(undefined, active.turnId).status, "running")
  assert.equal(lifecycle.requireTurn(otherCaller, other.turnId).response, "other caller")
  assert.equal(latest.submittedMessageId, undefined)
  assert.equal(active.submittedMessageId, "active-message")
})

test("completed and failed turns expire after 24 hours without changing active work or settled status", async (t) => {
  const lifecycle = createLifecycle(t)
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 })
  const now = Date.now()
  const completed = submit(lifecycle, "completed", now)
  const failed = submit(lifecycle, "failed", now)
  const active = submit(lifecycle, "active", now)

  assert.ok(lifecycle.completeTurn(completed, "done", now))
  assert.ok(lifecycle.failTurn(failed, new ChatGptDelegationError("AGENT_TARGET_LOST", "lost")))
  await Promise.all([completed.settled, failed.settled])
  assert.equal(lifecycle.completeTurn(completed, "duplicate", now), undefined)
  const completedAgent = lifecycle.getAgent(undefined, "completed")!
  const failedAgent = lifecycle.getAgent(undefined, "failed")!
  lifecycle.recordActivity(completedAgent, completed, "Working", now + 1)
  lifecycle.recordActivity(failedAgent, failed, "Working", now + 1)
  assert.equal(completedAgent.status, "idle")
  assert.equal(failedAgent.status, "uncertain")
  assert.equal(failed.submittedMessageId, undefined)
  assert.equal(failed.observation, undefined)

  t.mock.timers.tick(24 * 60 * 60_000 - 1)
  assert.equal(lifecycle.requireTurn(undefined, completed.turnId).response, "done")
  assert.equal(lifecycle.requireTurn(undefined, failed.turnId).errorCode, "AGENT_TARGET_LOST")
  t.mock.timers.tick(1)
  assert.throws(() => lifecycle.requireTurn(undefined, completed.turnId), { code: "UNKNOWN_TURN" })
  lifecycle.idleCleanupActions(Date.now())
  assert.throws(() => lifecycle.requireTurn(undefined, failed.turnId), { code: "UNKNOWN_TURN" })
  assert.equal(lifecycle.requireTurn(undefined, active.turnId).status, "running")
})

function createLifecycle(t: TestContext): DelegationLifecycle {
  const directory = mkdtempSync(join(tmpdir(), "shellby-turn-retention-"))
  const previousStateDir = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const lifecycle = new DelegationLifecycle()
  t.after(() => {
    lifecycle.dispose()
    MCP_CONFIG.stateDir = previousStateDir
    rmSync(directory, { recursive: true, force: true })
  })
  return lifecycle
}

function submit(
  lifecycle: DelegationLifecycle,
  agentId: string,
  now: number,
  parentAgent?: AgentIdentity
) {
  lifecycle.reserveOperation(parentAgent, agentId, {})
  const agent =
    lifecycle.getAgent(parentAgent, agentId) ??
    lifecycle.createSubagentAgent(parentAgent, agentId, false, now)
  lifecycle.registerAgent(parentAgent, agent)
  const turn = lifecycle.createTurn(parentAgent, agent, now)
  lifecycle.recordSubmittedMessage(turn, `${agentId}-message`)
  lifecycle.recordSubmittedTurn(
    parentAgent,
    agent,
    turn,
    {
      response: new Promise(() => {}),
      submit: async (action) => action(),
      dispose: async () => {},
    },
    now
  )
  return turn
}
