import { access, mkdir, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

const setup = process.argv.includes("--setup")
const auto = process.argv.includes("--auto")
const optional = process.argv.includes("--optional")
const endpoint = new URL(process.env.MCP_CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222")
const profileDir = join(homedir(), ".shelly", "chatgpt-chrome")
const markerPath = join(profileDir, ".configured")
const configured = await exists(markerPath)
const cdpReady = await isCdpReady(endpoint)

if (!isLocalEndpoint(endpoint)) {
  console.log(`ChatGPT browser: using configured CDP endpoint ${endpoint.href}`)
  process.exit(0)
}

if (!setup && !configured) {
  console.log(
    cdpReady
      ? "ChatGPT browser: existing CDP session detected (not managed by setup)"
      : auto
        ? "ChatGPT browser: not configured (run `npm run setup:chatgpt` to enable subagents)"
        : "ChatGPT browser is not configured. Run `npm run setup:chatgpt` first."
  )
  process.exit(0)
}

if (cdpReady) {
  if (setup && !configured) {
    fail(
      `${endpoint.host} is already serving a Chrome DevTools session. Close that debug Chrome or configure a different MCP_CHATGPT_CDP_ENDPOINT before setup.`
    )
  }
  console.log("ChatGPT browser: already running")
  if (setup) console.log("Sign into ChatGPT in that dedicated Chrome window if needed.")
  process.exit(0)
}

const chrome = await findChrome()
if (!chrome) {
  const message = "Google Chrome was not found in /Applications or ~/Applications."
  if (auto || optional) {
    console.warn(`ChatGPT browser: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

await mkdir(profileDir, { recursive: true })
const port = endpoint.port || "9222"
const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com/",
  ],
  { detached: true, stdio: "ignore" }
)
child.unref()

if (!(await waitForCdp(endpoint))) {
  const message = `Chrome launched but CDP did not become available at ${endpoint.href}`
  if (auto || optional) {
    console.warn(`ChatGPT browser: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

await writeFile(markerPath, "configured\n", "utf8")
console.log("ChatGPT browser: running")
if (setup) {
  console.log("Sign into ChatGPT in the dedicated Chrome window. Future `npm start` runs will launch this profile automatically.")
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN?.trim(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next normal macOS Chrome location.
    }
  }
  return undefined
}

async function waitForCdp(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isCdpReady(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function isCdpReady(url) {
  try {
    const versionUrl = new URL("/json/version", url)
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(500) })
    if (!response.ok) return false
    const payload = await response.json()
    return typeof payload.webSocketDebuggerUrl === "string"
  } catch {
    return false
  }
}

function isLocalEndpoint(url) {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
}

function fail(message) {
  if (optional) {
    console.warn(`ChatGPT browser setup skipped: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
