# Wiki Context Log

Record only durable historical context that cannot be cheaply reconstructed from commit messages, diffs, the current repository/wiki, or preserved raw evidence. Most changes do not need an entry.

## 2026-08-04 — Static bearer authentication was tried and removed

Shellby briefly required a shared `MCP_AUTH_TOKEN`, then removed it after confirming the ChatGPT connector path did not fit a fixed custom bearer-token model. Remote ownership later converged on the ngrok origin boundary plus bound OpenAI subject metadata. Do not treat the removed shared-secret design as an unfinished requirement.

## 2026-08-07 — Browser-backed subagents established important UI constraints

Live validation showed that normal background Chrome works while headless Chrome encountered a Cloudflare challenge. Direct contenteditable filling also duplicated prompt text; page-targeted keyboard insertion followed by ChatGPT's Send action avoided that failure. The current browser submission path reflects those findings.

## 2026-08-15 — Direct conversation recovery fetch was abandoned

An authenticated page-context request to `/backend-api/conversation/<conversation_id>` returned `conversation_inaccessible`, so that direct-fetch recovery approach was dropped. Recovery later converged on observed ChatGPT-owned traffic and ultimately raw-CDP turn tracking with bounded catastrophic recovery. Avoid reintroducing the direct page-context fetch without fresh evidence that the private endpoint behavior changed.
