const ngrokArgs = ["http", "3333"]
if (process.env.NGROK_URL) ngrokArgs.push(`--url=${process.env.NGROK_URL}`)
ngrokArgs.push("--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false")

module.exports = {
  apps: [
    {
      name: "unhinged-terminal-mcp",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
    },
    {
      name: "unhinged-terminal-ngrok",
      script: "/opt/homebrew/bin/ngrok",
      args: ngrokArgs,
      cwd: __dirname,
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
    },
  ],
}
