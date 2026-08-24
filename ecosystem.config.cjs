const { execFileSync } = require("node:child_process")
const { existsSync } = require("node:fs")
const { dirname, join } = require("node:path")

const envFile = join(__dirname, ".env")
if (existsSync(envFile)) process.loadEnvFile(envFile)

const ngrokExecutable = process.env.NGROK_BIN || execFileSync("/usr/bin/which", ["ngrok"], { encoding: "utf8" }).trim()
const ngrokArgs = ["http", "3333"]
if (process.env.NGROK_URL) ngrokArgs.push(`--url=${process.env.NGROK_URL}`)
ngrokArgs.push("--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false")

const peekabooExecutable = process.env.MCP_PEEKABOO_BIN?.trim()
const cursorHostExecutable =
  process.env.MCP_PEEKABOO_CURSOR_HOST_BIN?.trim() ||
  (peekabooExecutable ? join(dirname(peekabooExecutable), "peekaboo-cursor-host") : undefined)

const apps = [
  {
    name: "shellby-mcp",
    script: "dist/index.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    kill_timeout: 10_000,
  },
  {
    name: "shellby-ngrok",
    script: ngrokExecutable,
    args: ngrokArgs,
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
  },
]

if (cursorHostExecutable && existsSync(cursorHostExecutable)) {
  apps.push({
    name: "shellby-cursor-host",
    script: cursorHostExecutable,
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
  })
}

module.exports = {
  apps,
}
