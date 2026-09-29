import assert from "node:assert/strict"
import test from "node:test"

import {
  bindAgentParent,
  findAgentIdentity,
  getAgentChildren,
  getAgentIdentity,
  runWithAgent,
  setAgentTaskSlug,
} from "../../src/agent/context.js"

test("keeps one process-wide identity per OpenAI session and adds task context", () => {
  const first = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  const same = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  const second = runWithAgent("agent-context-b", () => getAgentIdentity()!)

  assert.equal(same, first)
  assert.equal(findAgentIdentity(first.sessionId), first)
  assert.equal(findAgentIdentity("unregistered-session"), undefined)
  assert.equal(same.agent, first.agent)
  assert.equal(
    Number(second.agent.slice("agent-".length)),
    Number(first.agent.slice("agent-".length)) + 1
  )

  runWithAgent("agent-context-a", () => setAgentTaskSlug("identity-context-test"))
  const updated = runWithAgent("agent-context-a", () => getAgentIdentity()!)
  assert.equal(updated.taskSlug, "identity-context-test")
  assert.equal(getAgentIdentity(), undefined)
})

test("parent links use canonical identities, stay idempotent, and reject conflicting or cyclic links", () => {
  const parent = runWithAgent("lineage-parent", () => getAgentIdentity()!)
  const child = runWithAgent("lineage-child", () => getAgentIdentity()!)
  const other = runWithAgent("lineage-other", () => getAgentIdentity()!)
  assert.equal(child.parent, undefined)
  assert.equal(bindAgentParent(child.sessionId, parent.sessionId), child)
  assert.equal(child.parent, parent)
  assert.equal(bindAgentParent(child.sessionId, parent.sessionId), child)
  assert.equal(bindAgentParent(child.sessionId, other.sessionId), undefined)
  assert.equal(bindAgentParent(parent.sessionId, parent.sessionId), undefined)
  const grandchild = bindAgentParent("lineage-grandchild", child.sessionId)!
  assert.equal(grandchild.parent, child)
  assert.equal(bindAgentParent(parent.sessionId, grandchild.sessionId), undefined)
  assert.deepEqual(getAgentChildren(parent), [child])
  assert.deepEqual(getAgentChildren(child), [grandchild])
  runWithAgent(parent.sessionId, () => setAgentTaskSlug("parent-task"))
  assert.equal(grandchild.parent?.parent?.taskSlug, "parent-task")
  assert.equal(parent.parent, undefined)
})
