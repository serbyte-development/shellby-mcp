import assert from "node:assert/strict"
import test from "node:test"
import { groupAgentFamilies } from "../../ui/src/features/dashboard/agent-families.js"
import type { Agent } from "../../ui/src/types.js"

const agent = (id: string, parentId?: string): Agent => ({
  id,
  parentId,
  firstSeenAt: 1,
  lastSeenAt: 1,
  recent: [],
  instructions: [],
})

test("groups children observed before their parent and nested descendants into one family", () => {
  const child = agent("child", "parent")
  const grandchild = agent("grandchild", "child")
  const other = agent("other")
  const parent = agent("parent")
  assert.deepEqual(groupAgentFamilies([child, other, grandchild, parent], []), [
    { rootId: "parent", agents: [parent, child, grandchild] },
    { rootId: "other", agents: [other] },
  ])
})

test("dismissed parents retain family membership without becoming visible", () => {
  const root = agent("root")
  const parent = agent("parent", "root")
  const child = agent("child", "parent")
  const sibling = agent("sibling", "root")
  assert.deepEqual(groupAgentFamilies([child, sibling], [root, parent]), [
    { rootId: "root", agents: [child, sibling] },
  ])
  assert.deepEqual(groupAgentFamilies([root, child, sibling], [parent]), [
    { rootId: "root", agents: [root, child, sibling] },
  ])
})

test("siblings with a parent not yet observed remain together without a fabricated card", () => {
  const first = agent("first", "unseen-parent")
  const second = agent("second", "unseen-parent")
  assert.deepEqual(groupAgentFamilies([first, second], []), [
    { rootId: "unseen-parent", agents: [first, second] },
  ])
})
