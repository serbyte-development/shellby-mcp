module.exports = {
  apps: [
    {
      name: "unhinged-terminal-mcp",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "cluster",
      autorestart: true,
    },
  ],
};
