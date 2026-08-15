# Open Questions and Risks

Verified 2026-08-15.

## What This Is

This page is the maintenance lint target for current trust, resource, external-integration, and intentionally unenforced boundaries.

## Active Risks

- **Remote trust depends on the deployment boundary:** production remote access relies on ngrok's `com.openai.chatgpt` source category plus the `X-Unhinged-Agent-Remote: 1` marker it adds after that check. A different public proxy must provide an equivalent trusted-origin check and marker; otherwise Unhinged Agent will treat unmarked `/mcp` traffic as local (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`, `src/auth/auth.ts`).
- **Local MCP remains intentionally unauthenticated:** production binds only to `127.0.0.1`, exact `/mcp` is available to local clients, and the exact regex route rejects `/mcp/`. The checked-in ngrok policy exposes only public `/mcp`, but changing the tunnel/reverse-proxy policy can still expose the local endpoint remotely (`src/config.ts`, `ngrok-traffic-policy.yml`, `src/server/http-server.ts`).
- **Authenticated browser delegation:** `subagent_run` can act through the ChatGPT account already authenticated in the configured debuggable Chrome instance. The MCP trust boundary therefore includes that browser session. `ChatGptSubagentModule` remains attach-only, while the public setup/start helpers may launch the dedicated `~/.unhinged-agent/chatgpt-chrome` profile (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`, `scripts/chatgpt-browser.mjs`).
- **Caller-selected shell boundaries are not per-user ACLs:** remote ChatGPT is single-owner by default, but local MCP clients share the same named-shell namespace. Any authorized/local caller that knows or guesses another `shell_id` can access or reset that shell, and all shells retain the same operating-system permissions (`src/auth/auth.ts`, `src/tools/shell/shell-tools.ts`, `src/tools/shell/session-manager.ts`).
- **Child-process resource use is not sandboxed:** the named-shell count, transcripts, command records, and idle lifetime are bounded, and parallel batches add a process-wide four-child ceiling plus a 10-minute per-child timeout. Any active command or child can still consume arbitrary CPU or memory under the local user account, and ordinary persistent-shell commands/background processes remain intentionally untimed (`src/tools/shell/session-manager.ts`, `src/tools/shell/session.ts`, `src/tools/shell/parallel-runner.ts`).
- **Website fetching is open-world:** `fetch_website` can navigate to HTTP or HTTPS resources reachable from the host, including local or private-network services. Cached documents are count-, TTL-, and byte-bounded, but concurrent fetches can still cause temporary CPU or memory spikes (`src/tools/web/web-tool.ts`, `src/tools/web/web-open.ts`).
- **Best-effort descendant cleanup:** process-group signaling errors are swallowed to keep the server alive. A process the local user cannot signal may outlive reset or shutdown (`src/tools/shell/session.ts`).
- **Rolling-output loss:** global eviction is reported through `cursor_expired`; per-command capture loss is reported through `dropped_output_bytes`. Those bytes are unrecoverable. `output_truncated` is intentionally different: it only means the current response hit its read limit and can be continued with `next_cursor` (`src/index.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`).
- **`apply_patch` path rules are a caller contract, not a sandbox:** the vendored Codex binary accepts absolute patch file paths and `Add File` overwrites an existing path. The MCP validates that `cwd` is absolute but does not parse patch-internal paths, so the relative-path rule is enforced only by the published schema/instructions and the process retains the local user's filesystem permissions (`src/tools/apply-patch/apply-patch.ts`, `vendor/apply-patch/apply_patch`).
- **MCP audit logging can disclose values:** bounded `tools/call` inputs are stored in the gitignored repository-local `agent-commands.yaml`, including shell commands, prompt prefixes, URLs, and other tool arguments. Ordinary arguments are capped at 600 characters and shell commands at 2,000 characters. Successful `apply_patch` calls retain only cwd and patch size, while failed patches also retain a bounded failure message and up to 32,000 characters of patch text. Ordinary tool output is not persisted; the logger records response size and model-facing token counts when the complete response is available (`src/index.ts`, `src/server/http-server.ts`, `src/server/audit-log.ts`).
- **Peekaboo and permission drift:** the eleven Computer Use schemas are stable at server startup, but the installed Peekaboo CLI version, JSON fields, daemon/Bridge selection, Screen Recording, Accessibility, and Event Synthesizing permissions can change independently. Calls surface the resulting error and are never retried (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).
- **Ephemeral observation targets:** screenshot IDs and their capture-target mappings live only in process memory, are capped at 64, and disappear on restart or eviction. Coordinate actions fail closed when the mapping is unavailable, so callers must observe again (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).
- **Coordinate interpretation:** screen captures require display-origin translation, while app/window clicks use screenshot-relative coordinates with an explicit capture target. Multi-display layout or upstream bounds changes are important real-CLI regression cases (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`, `test/peekaboo.test.ts`).

## Intentional Unenforced Conventions

- Generated-tool paths and catalog rules intentionally exist only in model instructions; the server does not provision or validate them (`src/server/mcp-server.ts`, `src/index.ts`).
- The workspace location is prompt guidance and an initial cwd, not a filesystem boundary (`src/index.ts`, `src/server/mcp-server.ts`).

`README.md` remains a potentially stale user-facing source. Update current architectural truth here first and public setup instructions only when needed (`wiki/raw/source-manifest.md`). Raw host-capability surveys are point-in-time evidence, not a roadmap.

## Related

- [[pages/Project Overview]]
- [[pages/Architecture Map]]
- [[pages/HTTP Transport]]
- [[pages/Configuration and Startup]]
- [[pages/Build and Test]]
- [[pages/ROADMAP]]
