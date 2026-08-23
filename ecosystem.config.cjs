const { execFileSync } = require("node:child_process")
const { existsSync } = require("node:fs")
const { join } = require("node:path")

const envFile = join(__dirname, ".env")
if (existsSync(envFile)) process.loadEnvFile(envFile)

const ngrokExecutable = process.env.NGROK_BIN || execFileSync("/usr/bin/which", ["ngrok"], { encoding: "utf8" }).trim()
const ngrokArgs = ["http", "3333"]
if (process.env.NGROK_URL) ngrokArgs.push(`--url=${process.env.NGROK_URL}`)
ngrokArgs.push("--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false")

module.exports = {
  apps: [
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
  ],
}
