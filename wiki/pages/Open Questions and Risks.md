# Open Questions and Risks

Verified 2026-08-10.

## Active Risks

- **Remote trust depends on the deployment boundary:** production remote access relies on ngrok's `com.openai.chatgpt` source category plus the `X-Shelly-Remote: 1` marker it adds after that check. A different public proxy must provide an equivalent trusted-origin check and marker; otherwise Shelly will treat unmarked `/mcp` traffic as local (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`, `src/auth/auth.ts`).
- **Local MCP remains intentionally unauthenticated:** exact `/mcp` is still available to local clients, while the exact regex route rejects `/mcp/`. The checked-in ngrok policy exposes only public `/mcp`, but changing the tunnel/reverse-proxy policy can still expose the local endpoint remotely (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`).
- **Authenticated browser delegation:** `chatgpt_subagent` can act through the ChatGPT account already authenticated in the configured debuggable Chrome instance. The MCP trust boundary therefore includes that browser session; the server does not launch Chrome or choose a profile (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`).
- **Caller-selected shell boundaries are not per-user ACLs:** remote ChatGPT is single-owner by default, but local MCP clients share the same named-shell namespace. Any authorized/local caller that knows or guesses another `shell_id` can access or reset that shell, and all shells retain the same operating-system permissions (`src/auth/auth.ts`, `src/tools/shell/shell-tools.ts`, `src/tools/shell/session-manager.ts`).
- **Child-process resource use is not sandboxed:** the named-shell count, transcripts, command records, and idle lifetime are bounded, and abandoned named shells are closed automatically. A currently active command or background process can still consume arbitrary CPU or memory under the local user account (`src/tools/shell/session-manager.ts`, `src/tools/shell/session.ts`).
- **Website fetching is open-world:** `fetch_website` can navigate to HTTP or HTTPS resources reachable from the host, including local or private-network services. Cached documents are count-, TTL-, and byte-bounded, but concurrent fetches can still cause temporary CPU or memory spikes (`src/tools/web/web-tool.ts`, `src/tools/web/web-open.ts`).
- **Best-effort descendant cleanup:** process-group signaling errors are swallowed to keep the server alive. A process the local user cannot signal may outlive reset or shutdown (`src/tools/shell/session.ts`).
- **Rolling-output loss:** global eviction is reported through `cursor_expired`; per-command ceiling loss is reported through `output_truncated` and `dropped_output_bytes`. Neither class of discarded output is recoverable (`src/index.ts`, `src/tools/shell/session.ts`).
- **MCP audit logging can disclose values:** bounded `tools/call` inputs are stored in the gitignored repository-local `agent-commands.yaml`, including shell commands, prompt prefixes, URLs, and other tool arguments. Ordinary arguments are capped at 600 characters and shell commands at 2,000 characters. `apply_patch` bodies are intentionally omitted and only cwd plus patch size are logged. Tool output is not persisted (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit-log.ts`).
- **No CI enforcement:** tests, type-check, and build exist only as local package scripts (`package.json`).
- **Port configuration is not composed:** `PORT` can move the HTTP listener, while the included ngrok command and Host rewrite remain fixed at 3333 (`src/index.ts`, `package.json`, `ngrok-traffic-policy.yml`).
- **Peekaboo and permission drift:** the eleven Computer Use schemas are stable at server startup, but the installed Peekaboo CLI version, JSON fields, daemon/Bridge selection, Screen Recording, Accessibility, and Event Synthesizing permissions can change independently. Calls surface the resulting error and are never retried (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).
- **Ephemeral observation targets:** screenshot IDs and their capture-target mappings live only in process memory, are capped at 64, and disappear on restart or eviction. Coordinate actions fail closed when the mapping is unavailable, so callers must observe again (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).
- **Coordinate interpretation:** screen captures require display-origin translation, while app/window clicks use screenshot-relative coordinates with an explicit capture target. Multi-display layout or upstream bounds changes are important real-CLI regression cases (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`, `test/peekaboo.test.ts`).

## Intentional Unenforced Conventions

- Generated-tool paths and catalog rules intentionally exist only in model instructions; the server does not provision or validate them (`src/server/mcp-server.ts`, `src/index.ts`).
- The workspace location is prompt guidance and an initial cwd, not a filesystem boundary (`src/index.ts`, `src/server/mcp-server.ts`).

`README.md` remains a potentially stale user-facing source. Update current architectural truth here first and public setup instructions only when needed (`wiki/raw/source-manifest.md`). The server is feature-complete; raw host-capability surveys are evidence, not a roadmap.
