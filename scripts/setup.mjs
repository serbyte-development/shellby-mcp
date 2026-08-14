import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { checkPublicRuntime } from "./preflight.mjs"
import { failure, intro, note, outro, spinner } from "./setup-ui.mjs"
import { initializeWorkspace } from "./workspace-setup.mjs"

const scriptsDir = dirname(fileURLToPath(import.meta.url))
intro()

const prerequisiteStep = spinner("Checking prerequisites")
const { errors } = await checkPublicRuntime()
if (errors.length > 0) {
  prerequisiteStep.fail("Prerequisites need attention")
  failure("Setup cannot continue", errors)
  process.exit(1)
}
prerequisiteStep.succeed("Prerequisites ready")

await mkdir(join(homedir(), ".unhinged-agent"), { recursive: true })

const workspaceStep = spinner("Preparing agent workspace")
const workspace = await initializeWorkspace()
workspaceStep.succeed(workspace.created ? "Agent workspace created" : "Agent workspace ready")
note("Workspace", workspace.agentsPath)

await commandStep("Building Unhinged Agent", "Build ready", "npm", ["run", "build"])

const computer = await commandStep(
  "Checking Computer Use",
  "Computer Use checked",
  process.execPath,
  [join(scriptsDir, "peekaboo-permissions.mjs"), "--status", "--optional"],
  { allowFailure: true }
)
note("Computer Use", combinedOutput(computer))

const browser = await commandStep(
  "Preparing multi-agent Chrome",
  "Multi-agent Chrome checked",
  process.execPath,
  [join(scriptsDir, "chatgpt-browser.mjs"), "--setup", "--optional"],
  { allowFailure: true }
)
note("Multi-agent", combinedOutput(browser))

outro(["Sign into ChatGPT if the dedicated Chrome window opened.", "Run `npm start` to launch Unhinged Agent."])

async function commandStep(label, successMessage, command, args, options = {}) {
  const step = spinner(label)
  const result = await run(command, args)
  if (result.status === 0) {
    step.succeed(successMessage)
    return result
  }

  if (options.allowFailure) {
    step.warn(`${label} needs attention`)
    return result
  }

  step.fail(`${label} failed`)
  failure(`${label} failed`, [combinedOutput(result) || `Command exited with status ${result.status}.`])
  process.exit(result.status ?? 1)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("close", (status) => resolve({ status: status ?? 1, stdout, stderr }))
  })
}

function combinedOutput(result) {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
}
