import { spawnSync } from "node:child_process"
import { dirname } from "node:path"

import { MCP_CONFIG } from "../../config.js"

const REWRITE_TIMEOUT_MS = 2_000
const REWRITE_MAX_BUFFER_BYTES = 256 * 1024
const TRAILING_NEWLINE_RE = /\r?\n$/u
const NPM_SCRIPT_RE = /\bnpm[ \t]+run(?:-script)?(?=[ \t])/u
const LEADING_NPM_SCRIPT_RE = /^[ \t]*npm[ \t]+run(?:-script)?(?=[ \t])/u

export function prepareShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const executable = MCP_CONFIG.shell.rtkExecutable
  if (!MCP_CONFIG.shell.rtk || !executable) return command

  const rewritten = spawnSync(executable, ["rewrite", command], {
    cwd,
    env: rtkEnvironment(env),
    encoding: "utf8",
    timeout: REWRITE_TIMEOUT_MS,
    maxBuffer: REWRITE_MAX_BUFFER_BYTES,
  })

  if (rewritten.error || (rewritten.status !== 0 && rewritten.status !== 3)) return command
  let value = rewritten.stdout.replace(TRAILING_NEWLINE_RE, "")
  if (!value) return command

  // RTK maps "npm run lint" to ESLint, bypassing the project's script. Its
  // generic npm wrapper preserves arguments and expects "run", not "run-script".
  // Embedded scripts keep their original shell text without needing a shell parser.
  if (LEADING_NPM_SCRIPT_RE.test(command)) {
    value = command.replace(LEADING_NPM_SCRIPT_RE, "rtk npm run")
  } else if (NPM_SCRIPT_RE.test(command) && value !== command) {
    return command
  }

  const rtkDirectory = dirname(executable)
  return [
    "() {",
    "local RTK_TEE=0 RTK_TELEMETRY_DISABLED=1 RTK_DB_PATH=/dev/null",
    `local PATH=${shellQuote(rtkDirectory)}:$PATH`,
    "export PATH RTK_TEE RTK_TELEMETRY_DISABLED RTK_DB_PATH",
    `eval ${shellQuote(value)}`,
    "}",
  ].join("\n")
}

function rtkEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    RTK_TEE: "0",
    RTK_TELEMETRY_DISABLED: "1",
    RTK_DB_PATH: "/dev/null",
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
