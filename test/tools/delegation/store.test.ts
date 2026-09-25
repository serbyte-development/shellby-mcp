import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import type { AgentIdentity } from "../../../src/agent/context.js"
import { createDelegationStore, DelegationStoreError } from "../../../src/tools/delegation/store.js"

test("persists subagent conversation state across store reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagents-"))
  const path = join(directory, "subagents.sqlite")
  const mainA: AgentIdentity = { sessionId: "main-session-a", agent: "agent-1" }
  const mainB: AgentIdentity = { sessionId: "main-session-b", agent: "agent-2" }
  try {
    const first = createDelegationStore(path)
    assert.equal(first.status, "available")
    first.set(mainA, "reviewer", {
      conversationUrl: "https://chatgpt.com/c/example-a",
      turnCount: 4,
    })
    first.set(mainA, "analyst", {
      conversationUrl: "https://chatgpt.com/c/analyst",
      turnCount: 1,
    })
    first.set(mainB, "reviewer", {
      conversationUrl: "https://chatgpt.com/c/example-b",
      turnCount: 2,
    })
    assert.deepEqual(first.list(mainA), [
      {
        agentId: "analyst",
        conversationUrl: "https://chatgpt.com/c/analyst",
        turnCount: 1,
      },
      {
        agentId: "reviewer",
        conversationUrl: "https://chatgpt.com/c/example-a",
        turnCount: 4,
      },
    ])
    first.close()

    const second = createDelegationStore(path)
    assert.equal(second.status, "available")
    assert.deepEqual(second.get(mainA, "reviewer"), {
      conversationUrl: "https://chatgpt.com/c/example-a",
      turnCount: 4,
    })
    assert.deepEqual(second.get(mainB, "reviewer"), {
      conversationUrl: "https://chatgpt.com/c/example-b",
      turnCount: 2,
    })
    assert.deepEqual(
      second.list(mainB).map((agent) => agent.agentId),
      ["reviewer"]
    )
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("reads and updates saved conversations from existing databases", () => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-existing-agent-store-"))
  const path = join(directory, "subagents.sqlite")
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE agents (
      parent_session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      conversation_url TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'subagent',
      PRIMARY KEY (parent_session_id, agent_id)
    );
    INSERT INTO agents VALUES ('', 'worker', 'https://chatgpt.com/c/saved', 2, 'subagent');
  `)
  db.close()
  const store = createDelegationStore(path)
  try {
    assert.deepEqual(store.get(undefined, "worker"), {
      conversationUrl: "https://chatgpt.com/c/saved",
      turnCount: 2,
    })
    store.set(undefined, "worker", { conversationUrl: "https://chatgpt.com/c/saved", turnCount: 3 })
    store.set(undefined, "new-worker", { conversationUrl: "https://chatgpt.com/c/new" })
    assert.equal(store.get(undefined, "worker")?.turnCount, 3)
    assert.equal(store.get(undefined, "new-worker")?.turnCount, 0)
    assert.equal(store.list(undefined).length, 2)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("conversation mappings remain available without usable turn counters", () => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-conversation-identity-"))
  const path = join(directory, "subagents.sqlite")
  const store = createDelegationStore(path)
  try {
    store.set(undefined, "worker", {
      conversationUrl: "https://chatgpt.com/c/saved",
    })
    assert.equal(store.get(undefined, "worker")?.turnCount, 0)
    const db = new DatabaseSync(path)
    for (const count of ["missing", -1, 0.5]) {
      db.prepare("UPDATE agents SET turn_count = ?").run(count)
      const agent = store.get(undefined, "worker")
      assert.equal(agent?.conversationUrl, "https://chatgpt.com/c/saved")
      assert.equal(agent?.turnCount, undefined)
      assert.equal(store.list(undefined)[0]?.conversationUrl, agent?.conversationUrl)
      assert.equal(store.status, "available")
    }
    db.close()
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("represents store initialization failure explicitly and logs it", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagents-init-failure-"))
  const blockedDirectory = join(directory, "not-a-directory")
  writeFileSync(blockedDirectory, "blocked")
  const warn = t.mock.method(console, "warn", () => {})

  try {
    const store = createDelegationStore(join(blockedDirectory, "subagents.sqlite"))
    assert.equal(store.status, "unavailable")
    assert.ok(store.failure instanceof DelegationStoreError)
    assert.equal(store.failure.operation, "initialize")
    assert.throws(
      () => store.list(undefined),
      (error: unknown) => error === store.failure
    )
    assert.equal(warn.mock.callCount(), 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("marks the store unavailable after a read failure", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagents-read-failure-"))
  const path = join(directory, "subagents.sqlite")
  const warn = t.mock.method(console, "warn", () => {})

  try {
    const store = createDelegationStore(path)
    const breaker = new DatabaseSync(path)
    breaker.exec("DROP TABLE agents")
    breaker.close()

    assert.throws(
      () => store.list(undefined),
      (error: unknown) => error instanceof DelegationStoreError && error.operation === "read"
    )
    assert.equal(store.status, "unavailable")
    assert.equal(store.failure?.operation, "read")
    assert.equal(warn.mock.callCount(), 1)
    store.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("marks the store unavailable after a write failure", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagents-write-failure-"))
  const path = join(directory, "subagents.sqlite")
  const warn = t.mock.method(console, "warn", () => {})

  try {
    const store = createDelegationStore(path)
    const breaker = new DatabaseSync(path)
    breaker.exec(`
      CREATE TRIGGER fail_agents_write
      BEFORE INSERT ON agents
      BEGIN
        SELECT RAISE(ABORT, 'forced write failure');
      END;
    `)
    breaker.close()

    assert.throws(
      () =>
        store.set(undefined, "reviewer", {
          conversationUrl: "https://chatgpt.com/c/reviewer",
          turnCount: 1,
        }),
      (error: unknown) => error instanceof DelegationStoreError && error.operation === "write"
    )
    assert.equal(store.status, "unavailable")
    assert.equal(store.failure?.operation, "write")
    assert.equal(warn.mock.callCount(), 1)
    store.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
