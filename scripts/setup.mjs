import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { checkPublicRuntime, printPreflightErrors } from "./preflight.mjs"

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const { errors } = await checkPublicRuntime()
if (errors.length > 0) {
  printPreflightErrors(errors)
  process.exitCode = 1
} else {
  await mkdir(join(homedir(), ".shelly"), { recursive: true })
  run("npm", ["run", "build"])
  run(process.execPath, [join(scriptsDir, "chatgpt-browser.mjs"), "--setup", "--optional"])
  console.log("Setup complete. Sign into ChatGPT if the dedicated Chrome window opened, then run `npm start`.")
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
