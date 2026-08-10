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
      args: ["http", "3333", "--url=geologic-catalog-deodorant.ngrok-free.dev", "--traffic-policy-file=./ngrok-traffic-policy.yml"],
      cwd: __dirname,
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
    },
  ],
}
