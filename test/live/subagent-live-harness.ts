import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import type { TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { chromium, type Page } from "playwright-core"
import { MCP_CONFIG } from "../../src/config.js"
import { extractConversationId } from "../../src/tools/delegation/chatgpt-browser.js"
import { DelegationDiagnostics } from "../../src/tools/delegation/diagnostics.js"
import { createDelegationStore } from "../../src/tools/delegation/store.js"
import { createSubagents } from "../../src/tools/delegation/subagents.js"
import { submittedUserMessageId } from "../../src/tools/delegation/turn-protocol.js"
import { asRecord } from "../../src/utils.js"
import { startMcpHttpServer, toolText } from "../integrations/helpers.js"

const AGENT_ID = "live-subagent-integration"
const ARTIFACT_DIR = new URL("./artifacts/", import.meta.url)
const CONVERSATION_FILE = new URL("subagent-live-conversation.json", ARTIFACT_DIR)
const RESULT_FILE = new URL("subagent-live-last.json", ARTIFACT_DIR)
// A regression ceiling for collection, separate from the agent's working time.
const MAX_COMPLETION_LATENCY_MS = 5_000
type LiveAgent = "source" | "fork"

interface RunTurn {
  agent_id: string
  turn_id?: string
  status: "running" | "failed"
  error?: string
}

interface ResultTurn {
  turn_id: string
  status: "running" | "completed" | "failed"
  activity?: string
  activity_age_ms?: number
  response?: string
  error?: string
}

interface Submission {
  agent: LiveAgent
  elapsed_ms: number
  message_id: string
  turn_id?: string
  prompt: string
}

interface HistoryClock {
  serverDate?: string
  requestStartedAtMs: number
  responseReceivedAtMs: number
}

/**
 * Own the real-browser test's MCP server, disposable local state, evidence and cleanup.
 * Reuse requires a saved/explicit conversation ID; only `fresh` permits new-chat startup.
 * A fork needs a separate agent and an explicit startSource on run; saved targets take precedence.
 * No resubmission, production-server restart or production database writes occur here.
 * Save identity as soon as observed, including failed runs; restart discards only local state.
 */
export async function openLiveSubagentHarness(t: TestContext, deadline: number) {
  const startedAt = Date.now()
  const runId = randomUUID()
  // Share the exact heading between submission and capture so prompt wording
  // cannot silently break source/fork correlation.
  const promptHeadings: Record<LiveAgent, string> = {
    source: `Workstream: ${runId}/notes.`,
    fork: `Workstream: ${runId}/draft.`,
  }
  const agents: Record<LiveAgent, { id: string; url?: string; fixture: URL }> = {
    source: {
      id: AGENT_ID,
      url: await startingConversationUrl(process.env.LIVE_SUBAGENT_START),
      fixture: CONVERSATION_FILE,
    },
    fork: {
      id: "live-subagent-fork",
      fixture: new URL("subagent-live-fork-conversation.json", ARTIFACT_DIR),
    },
  }
  const submissions: Submission[] = []
  const timeline: Array<Record<string, unknown>> = []
  const polls = new Map<string, Array<ResultTurn & { elapsed_ms: number }>>()
  const completionLatencies: Array<Record<string, unknown>> = []
  const artifact: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    start: process.env.LIVE_SUBAGENT_START ?? "reuse",
    agent_id: AGENT_ID,
    run_id: runId,
    submissions,
    timeline,
    completion_latency: completionLatencies,
    result: "running",
  }
  const failures: unknown[] = []
  artifact.delegation_diagnostics = failures
  const warn = console.warn.bind(console)
  t.mock.method(console, "warn", (...args: unknown[]) => {
    const message = args[0]
    if (typeof message === "string" && message.startsWith("[delegation] ")) {
      const failure: unknown = JSON.parse(message.slice("[delegation] ".length))
      if (
        Object.values(agents).some((agent) => agent.id === asRecord(failure)?.agent_id) &&
        failures.length < 20
      )
        failures.push(failure)
    }
    warn(...args)
  })

  const previousStateDir = MCP_CONFIG.stateDir
  const stateDir = await mkdtemp(join(tmpdir(), "shellby-live-subagent-"))
  MCP_CONFIG.stateDir = stateDir
  const store = createDelegationStore(join(stateDir, "subagents.sqlite"))
  let server: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined
  let client: Client | undefined
  let history:
    | { page: Page; payload: Promise<unknown>; elapsedMs: number; clock: HistoryClock }
    | undefined
  const ownedPages = new Set<Page>()
  const diagnostics = new DelegationDiagnostics(AGENT_ID, undefined)
  t.after(async () => {
    await persist().catch((error: unknown) => warn("Could not save live evidence:", error))
    await client?.close().catch(() => undefined)
    await server?.close().catch(() => undefined)
    diagnostics.dispose()
    store.close()
    MCP_CONFIG.stateDir = previousStateDir
    await rm(stateDir, { recursive: true, force: true })
  })

  try {
    if (agents.source.url) store.set(undefined, AGENT_ID, { conversationUrl: agents.source.url })
    // Attach-only. Closing this Playwright connection disconnects CDP, not managed Chrome.
    const browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, {
      timeout: 5_000,
    })
    t.after(() => browser.close())
    const context = browser.contexts()[0]
    assert.ok(context, "Managed Chrome must expose its authenticated profile")
    artifact.chrome_version = browser.version()
    context.on("response", (response) => {
      const conversationId = agents.source.url && extractConversationId(agents.source.url)
      if (!conversationId || response.status() !== 200) return
      const url = new URL(response.url())
      if (
        url.origin !== "https://chatgpt.com" ||
        url.pathname !== `/backend-api/conversations/${conversationId}`
      )
        return
      // Observe the UI's authenticated request when it reopens the test conversation.
      // A direct cookie-only fetch returns 401; neither credentials nor raw history are saved.
      history = {
        page: response.request().frame().page(),
        payload: response.json().catch(() => undefined),
        elapsedMs: elapsed(),
        clock: {
          serverDate: response.headers().date,
          requestStartedAtMs: response.request().timing().startTime,
          responseReceivedAtMs: Date.now(),
        },
      }
      timeline.push({
        stage: "authenticated history observed",
        elapsed_ms: elapsed(),
        clock: history.clock,
      })
    })
    context.on("request", (request) => {
      if (request.method() !== "POST") return
      const body = request.postData()
      if (!body?.includes(runId)) return
      const messageId = submittedUserMessageId(body)
      if (!messageId) return
      const page = request.frame().page()
      ownedPages.add(page)
      diagnostics.watch(page)
      const requestBody = asRecord(JSON.parse(body))
      const messages = requestBody?.messages as Array<{ content?: { parts?: unknown[] } }>
      const prompt = messages.flatMap((message) => message.content?.parts ?? []).join("\n")
      const agent = (Object.keys(agents) as LiveAgent[]).find((key) =>
        prompt.includes(promptHeadings[key])
      )
      if (!agent) return
      submissions.push({ agent, elapsed_ms: elapsed(), message_id: messageId, prompt })
      timeline.push({
        stage: "submission observed",
        agent,
        elapsed_ms: elapsed(),
        message_id: messageId,
      })
    })
    await startServer()
    await persist()
  } catch (error) {
    await fail(error)
    throw error
  }

  return {
    submissions,
    stage,
    page,
    reconnectClient,
    assertSavedConversation,
    async run(
      prompt: string,
      options: { agent?: LiveAgent; startSource?: string } = {}
    ): Promise<RunTurn> {
      const key = options.agent ?? "source"
      const agent = agents[key]
      const submissionIndex = submissions.length
      const result = await call("subagent_run", {
        agents: [
          {
            agent_id: agent.id,
            prompt: `${promptHeadings[key]}\n${prompt}`,
            ...(options.startSource ? { start_from: options.startSource } : {}),
          },
        ],
      })
      const turn = parseRunTurn(result)
      assert.equal(turn.agent_id, agent.id)
      if (turn.turn_id) {
        // The separate CDP connection can report Send after the MCP response arrives.
        // Sequential test runs bind their own new submission, never the previous turn.
        const captureDeadline = Math.min(deadline, Date.now() + 5_000)
        while (submissions.length === submissionIndex && Date.now() < captureDeadline)
          await delay(10)
        assert.equal(submissions.length, submissionIndex + 1, "Observe exactly one new submission")
        const submission = submissions[submissionIndex]!
        assert.equal(submission.agent, key)
        submission.turn_id = turn.turn_id
        diagnostics.submitted(turn.turn_id, submission.message_id)
      }
      timeline.push({ elapsed_ms: elapsed(), operation: "run", ...turn })
      await persist()
      return turn
    },
    poll,
    async complete(turnId: string): Promise<string> {
      while (Date.now() < deadline) {
        const result = await poll(turnId, Math.min(30_000, deadline - Date.now()))
        if (result.status === "completed") {
          const response = result.response ?? ""
          assert.ok(response.trim(), "Completed turns must return a non-empty response")
          return response
        }
        assert.notEqual(result.status, "failed", result.error)
      }
      throw new Error(`Timed out waiting for ${turnId}; see ${RESULT_FILE.pathname}`)
    },
    assertLongTurn(turnId: string, waitMs: number): void {
      const samples = polls.get(turnId) ?? []
      const submission = submissions[0]
      assert.ok(submission)
      const completed = samples.find((sample) => sample.status === "completed")
      assert.ok(completed)
      assert.ok(
        completed.elapsed_ms - submission.elapsed_ms >= waitMs,
        "A fast answer cannot pass the long-wait test"
      )
      assert.ok(
        samples.some(
          (sample) =>
            sample.status === "running" && sample.elapsed_ms - submission.elapsed_ms > 180_000
        ),
        "Must observe the turn still running after three minutes"
      )
      artifact.long_turn = {
        elapsed_ms: completed.elapsed_ms - submission.elapsed_ms,
        maximum_observed_activity_age_ms: Math.max(
          ...samples.map((sample) => sample.activity_age_ms ?? 0)
        ),
      }
    },
    async assertWaitExecuted(waitMs: number): Promise<void> {
      await assertSavedConversation()
      assert.ok(
        history && history.page === page(),
        "Reopening must load the test conversation's authenticated history"
      )
      artifact.timer_evidence = recordedCodeModeWait(
        await history.payload,
        submissions[0]!.message_id,
        waitMs
      )
      await persist()
    },
    async assertCompletionLatency(turnId: string): Promise<void> {
      const submission = submissions.filter((item) => item.turn_id === turnId).at(-1)
      const completed = polls.get(turnId)?.find((sample) => sample.status === "completed")
      assert.ok(submission && completed, "Latency needs a submission and its first completed poll")
      assert.ok(history && history.page === page(), "Reopen the source to read completion evidence")
      const evidence = recordedCompletionLatency(
        await history.payload,
        submission.message_id,
        startedAt + completed.elapsed_ms,
        history.clock
      )
      completionLatencies.push({ turn_id: turnId, ...evidence })
      await persist()
      t.diagnostic(
        `${turnId}: saved final -> MCP ${evidence.minimum_latency_ms.toFixed(1)}..${evidence.maximum_latency_ms.toFixed(1)}ms (clock uncertainty included)`
      )
      assert.ok(
        evidence.maximum_latency_ms - evidence.minimum_latency_ms < MAX_COMPLETION_LATENCY_MS,
        "History clock calibration is too imprecise to measure completion latency"
      )
      // Stream delivery can precede the final message's saved update timestamp slightly.
      assert.ok(
        evidence.maximum_latency_ms >= -MAX_COMPLETION_LATENCY_MS,
        "The result predates its saved final answer; timing evidence is inconsistent"
      )
      assert.ok(
        evidence.maximum_latency_ms < MAX_COMPLETION_LATENCY_MS,
        `Final answer took up to ${evidence.maximum_latency_ms.toFixed(1)}ms to reach subagent_result`
      )
    },
    async restartFromConversation(): Promise<void> {
      await client!.close()
      client = undefined
      await server!.close()
      server = undefined
      // Polling IDs can repeat after losing counters; results belong to the current service.
      polls.clear()
      // Omitting turnCount intentionally loses local numbering as well as in-memory results.
      for (const agent of Object.values(agents)) {
        if (!agent.url) continue
        store.set(undefined, agent.id, { conversationUrl: agent.url })
        assert.equal(store.get(undefined, agent.id)?.turnCount, 0)
      }
      await startServer()
    },
    async assertForkIsolated(): Promise<void> {
      const forkSubmissions = submissions.filter((submission) => submission.agent === "fork")
      assert.ok(forkSubmissions.length > 0)
      assert.ok(history && history.page === page(), "Reopen the source to verify its saved history")
      assert.ok(
        history.elapsedMs > forkSubmissions.at(-1)!.elapsed_ms,
        "Source history must be read after the fork's turns"
      )
      const sourceMessages = activeBranchMessages(await history.payload)
      const ids = new Set(sourceMessages.map((message) => message.id))
      const sourceSubmissions = submissions.filter((submission) => submission.agent === "source")
      assert.ok(
        ids.has(sourceSubmissions.at(-2)!.message_id),
        "History must include the source checkpoint before forking"
      )
      for (const submission of forkSubmissions)
        assert.ok(
          !ids.has(submission.message_id),
          "Fork submissions must never appear in source history"
        )
      artifact.fork_isolated = true
      await persist()
    },
    async finish(): Promise<void> {
      artifact.result = "pass"
      await stage("completed")
      t.diagnostic(`LIVE SUBAGENT E2E: PASS. Evidence: ${RESULT_FILE.pathname}`)
    },
    fail,
  }

  function elapsed(): number {
    return Date.now() - startedAt
  }

  function page(key: LiveAgent = "source"): Page {
    const url = store.get(undefined, agents[key].id)?.conversationUrl
    assert.ok(url, `The ${key} must have a saved conversation URL`)
    const matches = [...ownedPages].filter(
      (candidate) =>
        !candidate.isClosed() &&
        extractConversationId(candidate.url()) === extractConversationId(url)
    )
    assert.equal(matches.length, 1, `The test must own exactly one live ${key} tab`)
    return matches[0]!
  }

  async function startServer(): Promise<void> {
    server = await startMcpHttpServer({
      subagents: createSubagents(),
      profile: {
        tools: {
          review: false,
          shell: false,
          applyPatch: false,
          fileRead: false,
          fileWrite: false,
          subagents: true,
          web: false,
          skills: false,
          image: false,
          computer: false,
        },
      },
    })
    await reconnectClient()
  }

  async function reconnectClient(): Promise<void> {
    await client?.close()
    client = new Client(
      { name: "live-subagent-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(server!.url)))
  }

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    assert.ok(Date.now() < deadline, "Live test deadline expired")
    const result = await client!.callTool(
      { name, arguments: args },
      {
        signal: t.signal,
        timeout: Math.min(90_000, deadline - Date.now()),
      }
    )
    // The compact wire format appends once-only notices to the answer block.
    // Keep them as evidence, not as part of the response used in repeat-poll assertions.
    const [output, ...notices] = toolText(result).split("\n\n**Notice:** ")
    if (notices.length) timeline.push({ elapsed_ms: elapsed(), notices })
    return output!
  }

  async function poll(turnId: string, waitMs: number): Promise<ResultTurn> {
    const cached = polls.get(turnId)?.some((sample) => sample.status === "completed")
    const calledAt = performance.now()
    const result = parseResultTurn(
      await call("subagent_result", { turn_ids: [turnId], yield_time_ms: waitMs })
    )
    assert.equal(result.turn_id, turnId)
    const sample = {
      elapsed_ms: elapsed(),
      call_duration_ms: performance.now() - calledAt,
      yield_time_ms: waitMs,
      ...result,
    }
    const samples = polls.get(turnId) ?? []
    samples.push(sample)
    polls.set(turnId, samples)
    timeline.push({ operation: "poll", ...sample })
    t.diagnostic(
      `+${sample.elapsed_ms}ms ${turnId}: ${result.status}, activity=${result.activity ?? "none"}, age=${result.activity_age_ms ?? "none"}ms`
    )
    await persist()
    if (cached && result.status === "completed")
      assert.ok(
        sample.call_duration_ms < MAX_COMPLETION_LATENCY_MS,
        `Cached result retrieval took ${sample.call_duration_ms.toFixed(1)}ms`
      )
    return result
  }

  async function stage(label: string): Promise<void> {
    artifact.last_completed_stage = artifact.stage
    artifact.stage = label
    diagnostics.stage(label)
    timeline.push({ stage: label, elapsed_ms: elapsed() })
    t.diagnostic(label)
    await persist()
  }

  async function assertSavedConversation(key: LiveAgent = "source"): Promise<string> {
    const agent = agents[key]
    const saved = store.get(undefined, agent.id)
    assert.ok(saved, "The service must persist conversation identity")
    assert.ok(extractConversationId(saved.conversationUrl))
    if (agent.url)
      assert.equal(
        extractConversationId(saved.conversationUrl),
        extractConversationId(agent.url),
        "Every step must stay in the same conversation"
      )
    assert.equal(
      extractConversationId(page(key).url()),
      extractConversationId(saved.conversationUrl)
    )
    await persist()
    return extractConversationId(saved.conversationUrl)!
  }

  async function persist(): Promise<void> {
    for (const [key, agent] of Object.entries(agents)) {
      const saved = store.get(undefined, agent.id)
      if (!saved) continue
      agent.url ??= saved.conversationUrl
      const identity = {
        agent_id: agent.id,
        conversation_url: saved.conversationUrl,
        conversation_id: extractConversationId(saved.conversationUrl),
      }
      if (key === "source") Object.assign(artifact, identity)
      else artifact[key] = identity
      await writeJson(agent.fixture, { conversation_url: agent.url })
    }
    await writeJson(RESULT_FILE, artifact)
  }

  async function fail(error: unknown): Promise<void> {
    artifact.result = "fail"
    artifact.failure =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) }
    artifact.failed_at = new Date().toISOString()
    await diagnostics.failure(error)
    await persist()
    t.diagnostic(`LIVE SUBAGENT E2E: FAIL. Evidence: ${RESULT_FILE.pathname}`)
  }
}

async function startingConversationUrl(start: string | undefined): Promise<string | undefined> {
  if (start === "fresh") return undefined
  if (start !== undefined) {
    assert.match(start, /^[\w-]{1,128}$/u, "LIVE_SUBAGENT_START must be fresh or a conversation ID")
    return `https://chatgpt.com/c/${encodeURIComponent(start)}`
  }
  let saved: unknown
  try {
    saved = JSON.parse(await readFile(CONVERSATION_FILE, "utf8"))
  } catch (error) {
    throw new Error(
      "No readable saved live conversation. Run npm run test:live:subagent:fresh once, or set LIVE_SUBAGENT_START=<conversation-id>.",
      { cause: error }
    )
  }
  const url = asRecord(saved)?.conversation_url
  assert.ok(
    typeof url === "string" &&
      new URL(url).origin === "https://chatgpt.com" &&
      extractConversationId(url),
    "Saved live conversation must contain a ChatGPT conversation URL"
  )
  return url
}

async function writeJson(path: URL, value: unknown): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const temporary = new URL(`${path.href}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function parseRunTurn(text: string): RunTurn {
  const match = text.match(
    /^- agent_id=("(?:\\.|[^"\\])*"|\S+)(?: turn_id=("(?:\\.|[^"\\])*"|\S+))? status=(running|failed)(?: error=("(?:\\.|[^"\\])*"|\S+))?$/mu
  )
  assert.ok(match, `Expected one subagent_run result: ${text.slice(0, 1000)}`)
  return {
    agent_id: scalar(match[1]!),
    turn_id: match[2] ? scalar(match[2]) : undefined,
    status: match[3] as RunTurn["status"],
    error: match[4] ? scalar(match[4]) : text.match(/^\s+error:\n([\s\S]*)$/mu)?.[1]?.trim(),
  }
}

function parseResultTurn(text: string): ResultTurn {
  const match = text.match(
    /^---- turn_id=("(?:\\.|[^"\\])*"|\S+) status=(running|completed|failed)(?: activity=("(?:\\.|[^"\\])*"|\S+))?(?: activity_age_ms=(\d+))? ----(?:\n\n([\s\S]*))?$/u
  )
  assert.ok(match, `Expected one subagent_result result: ${text.slice(0, 1000)}`)
  const status = match[2] as ResultTurn["status"]
  return {
    turn_id: scalar(match[1]!),
    status,
    activity: match[3] ? scalar(match[3]) : undefined,
    activity_age_ms: match[4] ? Number(match[4]) : undefined,
    response: status === "completed" ? match[5] : undefined,
    error: status === "failed" ? match[5] : undefined,
  }
}

function scalar(value: string): string {
  return value.startsWith('"') ? (JSON.parse(value) as string) : value
}

/** Verify one submitted turn's real Code Mode duration using saved invocation/result metadata.
 * ChatGPT redacts these message bodies; an assistant's text alone cannot establish tool execution.
 */
export function recordedCodeModeWait(payload: unknown, userMessageId: string, minimumMs: number) {
  const turn = submittedTurnMessages(payload, userMessageId)
  const invocation = turn.find(
    (message) =>
      asRecord(message.author)?.role === "assistant" && message.recipient === "functions.exec"
  )
  assert.ok(invocation, "History must contain an actual Code Mode invocation for this turn")
  assert.ok(typeof invocation.id === "string" && invocation.id, "The invocation must have an ID")
  const result = turn.find(
    (message) =>
      asRecord(message.author)?.role === "tool" &&
      asRecord(message.metadata)?.parent_id === invocation.id
  )
  assert.ok(result, "History must contain the linked Code Mode result")
  assert.ok(typeof result.id === "string" && result.id, "The tool result must have an ID")
  assert.equal(asRecord(result.author)?.name, invocation.recipient)
  assert.equal(result.status, "finished_successfully")
  assert.ok(
    typeof result.create_time === "number" && typeof invocation.create_time === "number",
    "Tool timing must use recorded server timestamps"
  )
  const elapsedMs = (result.create_time - invocation.create_time) * 1000
  assert.ok(
    Number.isFinite(elapsedMs) && elapsedMs >= minimumMs,
    "The recorded Code Mode invocation must span the full wait"
  )
  return { invocation_id: invocation.id, result_id: result.id, elapsed_ms: elapsedMs }
}

/**
 * Bound saved-final -> first completed MCP response latency in milliseconds, independently
 * of the production stream decoder. The history response's HTTP Date calibrates server/local
 * clock skew; its one-second precision and request round trip remain in the reported interval.
 * Missing final identity/timing is a test failure, never zero latency or an older turn's answer.
 */
export function recordedCompletionLatency(
  payload: unknown,
  userMessageId: string,
  resultReceivedAtMs: number,
  clock: HistoryClock
) {
  const final = submittedTurnMessages(payload, userMessageId).find(
    (message) =>
      asRecord(message.author)?.role === "assistant" &&
      message.channel === "final" &&
      message.status === "finished_successfully" &&
      message.end_turn === true &&
      (message.recipient === undefined || message.recipient === "all")
  )
  assert.ok(final, "History must contain the submitted turn's completed final answer")
  assert.ok(typeof final.id === "string" && final.id, "The final answer must have an ID")
  assert.ok(
    typeof final.update_time === "number" && Number.isFinite(final.update_time),
    "Final completion timing needs the saved update_time, not the start of generation"
  )
  const serverDateMs = Date.parse(clock.serverDate ?? "")
  assert.ok(Number.isFinite(serverDateMs), "History needs an HTTP Date for clock calibration")
  assert.ok(
    Number.isFinite(resultReceivedAtMs) &&
      Number.isFinite(clock.requestStartedAtMs) &&
      Number.isFinite(clock.responseReceivedAtMs) &&
      clock.requestStartedAtMs >= 0 &&
      clock.requestStartedAtMs <= clock.responseReceivedAtMs,
    "Completion timing needs valid local request/response timestamps"
  )
  const completedAtMs = final.update_time * 1000
  return {
    message_id: final.id,
    server_completed_at_ms: completedAtMs,
    result_received_at_ms: resultReceivedAtMs,
    minimum_latency_ms:
      resultReceivedAtMs + serverDateMs - clock.responseReceivedAtMs - completedAtMs,
    maximum_latency_ms:
      resultReceivedAtMs + serverDateMs + 1000 - clock.requestStartedAtMs - completedAtMs,
  }
}

function submittedTurnMessages(payload: unknown, userMessageId: string): Record<string, unknown>[] {
  const messages = activeBranchMessages(payload)
  const firstIndex = messages.findIndex((message) => message.id === userMessageId)
  assert.ok(firstIndex >= 0, "History must contain the observed user submission")
  const nextUser = messages.findIndex(
    (message, index) => index > firstIndex && asRecord(message.author)?.role === "user"
  )
  return messages.slice(firstIndex + 1, nextUser < 0 ? undefined : nextUser)
}

function activeBranchMessages(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload)
  if (Array.isArray(root?.messages))
    return root.messages.map(asRecord).filter((message) => message !== undefined)
  const mapping = asRecord(root?.mapping)
  const messages: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let id = root?.current_node
  while (typeof id === "string" && !seen.has(id)) {
    seen.add(id)
    const node = asRecord(mapping?.[id])
    const message = asRecord(node?.message)
    if (message) messages.push(message)
    id = node?.parent
  }
  return messages.reverse()
}
