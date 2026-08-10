const optional = process.argv.includes("--optional")
const configuredDomain = process.env.NGROK_URL?.trim()

const url = configuredDomain ? fromConfiguredDomain(configuredDomain) : await discoverNgrokUrl(optional ? 1 : 20)

if (url) {
  console.log(`MCP URL: ${url}`)
} else {
  console.error("MCP URL unavailable. Start ngrok with `npm run tunnel` or set NGROK_URL.")
  if (!optional) process.exitCode = 1
}

function fromConfiguredDomain(value) {
  const domain = value
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\/mcp$/, "")
  return `https://${domain}/mcp`
}

async function discoverNgrokUrl(attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) {
        const payload = await response.json()
        const tunnel = payload.tunnels?.find((candidate) => candidate.proto === "https" && candidate.public_url)
        if (tunnel) return `${tunnel.public_url.replace(/\/+$/, "")}/mcp`
      }
    } catch {
      // ngrok may still be starting.
    }

    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return undefined
}
