/**
 * Probe authenticated ChatGPT startup without submitting a prompt.
 *
 * Run sequentially with `npm run probe:chatgpt-startup` or compare concurrent
 * startup with `npm run probe:chatgpt-startup -- parallel`. The latest private
 * report is written under test/live/artifacts/.
 */
import { mkdir, writeFile } from "node:fs/promises"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"
import { type Browser, type BrowserContext, chromium } from "playwright-core"

import { MCP_CONFIG } from "../../../src/config.js"
import {
  assertAuthenticated,
  createBackgroundPage,
  enterPrompt,
  findComposer,
  navigateChatGptPage,
} from "../../../src/tools/delegation/chatgpt-browser.js"
import { readChatGptPageState } from "../../../src/tools/delegation/diagnostics.js"

const ATTEMPTS = [1, 2, 3] as const
const ARTIFACT_DIRECTORY = new URL("../artifacts/", import.meta.url)
const DRAFT = "Diagnostic draft only. This will not be submitted."
// Match chatgpt-service.ts settling before and after prompt entry.
const INTERACTION_DELAY_MS = 2_000
const MODES = ["sequential", "parallel"] as const

type Mode = (typeof MODES)[number]

interface StageTiming {
  stage: string
  elapsed_ms: number
}

interface AttemptReport {
  attempt: number
  started_at: string
  elapsed_ms: number
  stages: StageTiming[]
  result: "ready" | "unexpected-ui" | "failed"
  submissions: number
  browser_errors: string[]
  page_state?: Awaited<ReturnType<typeof readChatGptPageState>>
  error?: string
}

// Node's default test discovery loads every TypeScript file below test/. Keep
// browser interaction explicit even when this module is evaluated by `npm test`.
if (process.env.RUN_CHATGPT_STARTUP_PROBE === "1") await main()

async function main(): Promise<void> {
  const mode = parseMode(process.argv[2])
  const browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, {
    timeout: 3_000,
  })
  const context = browser.contexts()[0]
  if (!context) {
    await browser.close()
    throw new Error("Connected Chrome exposed no browser context.")
  }

  let reports: AttemptReport[]
  try {
    reports =
      mode === "parallel"
        ? await Promise.all(ATTEMPTS.map((attempt) => runAttempt(browser, context, attempt)))
        : await runSequentially(browser, context)
  } finally {
    await browser.close()
  }

  reports.sort((left, right) => left.attempt - right.attempt)
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true })
  const output = new URL(`startup-probe-${mode}.json`, ARTIFACT_DIRECTORY)
  await writeFile(output, `${JSON.stringify({ mode, reports }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })

  for (const report of reports) console.log(JSON.stringify(report))
  console.log(`Private startup report: ${output.pathname}`)
  if (reports.some((report) => report.result !== "ready")) process.exitCode = 1
}

async function runSequentially(
  connectedBrowser: Browser,
  browserContext: BrowserContext
): Promise<AttemptReport[]> {
  const sequentialReports: AttemptReport[] = []
  for (const attempt of ATTEMPTS) {
    sequentialReports.push(await runAttempt(connectedBrowser, browserContext, attempt))
  }
  return sequentialReports
}

async function runAttempt(
  connectedBrowser: Browser,
  browserContext: BrowserContext,
  attempt: number
): Promise<AttemptReport> {
  const startedAt = Date.now()
  const stages: StageTiming[] = []
  const browserErrors: string[] = []
  let submissions = 0
  const record = (stage: string) => stages.push({ stage, elapsed_ms: Date.now() - startedAt })
  const page = await createBackgroundPage(connectedBrowser, browserContext)

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(bounded(message.text()))
  })
  page.on("pageerror", (error) => browserErrors.push(bounded(error.stack ?? error.message)))
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/backend-api/f/conversation"
    )
      submissions += 1
  })

  try {
    record("navigate")
    await navigateChatGptPage(page, MCP_CONFIG.chatGpt.projectUrl)
    record("authenticate")
    await assertAuthenticated(page)
    record("find-composer")
    const composer = await findComposer(page)
    await delay(INTERACTION_DELAY_MS)
    record("enter-draft")
    await enterPrompt(page, composer, DRAFT)
    await delay(INTERACTION_DELAY_MS)
    record("inspect")
    const pageState = await page.evaluate(readChatGptPageState)
    const result =
      pageState.composer_visible && !pageState.try_again_visible && submissions === 0
        ? "ready"
        : "unexpected-ui"
    return {
      attempt,
      started_at: new Date(startedAt).toISOString(),
      elapsed_ms: Date.now() - startedAt,
      stages,
      result,
      submissions,
      browser_errors: browserErrors,
      page_state: pageState,
    }
  } catch (error) {
    return {
      attempt,
      started_at: new Date(startedAt).toISOString(),
      elapsed_ms: Date.now() - startedAt,
      stages,
      result: "failed",
      submissions,
      browser_errors: browserErrors,
      page_state: await page.evaluate(readChatGptPageState).catch(() => undefined),
      error: bounded(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    }
  } finally {
    await page.close().catch(() => undefined)
  }
}

function parseMode(value: string | undefined): Mode {
  if (value === undefined) return "sequential"
  if ((MODES as readonly string[]).includes(value)) return value as Mode
  throw new Error(`Unknown startup probe mode ${JSON.stringify(value)}; use ${MODES.join(" or ")}.`)
}

function bounded(value: string, maximumLength = 2_500): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength)}…`
}
