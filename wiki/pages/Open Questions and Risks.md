# Open Questions and Risks

Verified 2026-08-22.

## What This Is

This page is the maintenance lint target for current trust, resource, external-integration, and intentionally unenforced boundaries.

## Active Risks

- **Remote trust depends on the deployment boundary:** replacing or weakening the checked-in ngrok origin policy can accidentally turn traffic that should be remote-authenticated into effectively local traffic. Preserve an equivalent trusted-origin marker contract; see [HTTP Transport](./HTTP%20Transport.md).
- **Local MCP remains intentionally unauthenticated:** exposing the localhost listener through a different proxy changes the threat model. Exact routing and ownership behavior are canonical in [HTTP Transport](./HTTP%20Transport.md).
- **Authenticated browser delegation:** `subagent_run` can act through the ChatGPT account already authenticated in the configured debuggable Chrome instance. The MCP trust boundary therefore includes that browser session. The subagent runtime service remains attach-only, while the public setup/start helpers may launch the dedicated `~/.unhinged-agent/chatgpt-chrome` profile (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`, `scripts/chatgpt-browser.mjs`).
- **Caller-selected shell boundaries are not per-user ACLs:** remote ChatGPT is single-owner by default, but local MCP clients share the same named-shell namespace. Any authorized/local caller that knows or guesses another `shell_id` can access or reset that shell, and all shells retain the same operating-system permissions (`src/auth/auth.ts`, `src/tools/shell/shell-tools.ts`, `src/tools/shell/session-manager.ts`).
- **Child-process resource use is not sandboxed:** shell capacity, hibernation, and batch limits bound orchestration but do not prevent an active local-user process from consuming arbitrary CPU or memory. Caller consequences are in [`shell_run` / `shell_poll`](./tools/shell_run.md); implementation mechanics are in [Persistent Shell Runtime](./Persistent%20Shell%20Runtime.md).
- **Website fetching is open-world:** `fetch_website` can navigate to HTTP or HTTPS resources reachable from the host, including local or private-network services. Cached documents are count-, TTL-, and byte-bounded, but concurrent fetches can still cause temporary CPU or memory spikes (`src/tools/web/web-tool.ts`, `src/tools/web/web-open.ts`).
- **Best-effort descendant cleanup:** process-group signaling errors are swallowed to keep the server alive. A process the local user cannot signal may outlive reset or shutdown (`src/tools/shell/session.ts`).
- **Rolling-output loss:** some shell output can become permanently unrecoverable after retention/capture limits are exceeded. The exact caller-visible distinction between truncation and loss is canonical in [`shell_run` / `shell_poll`](./tools/shell_run.md).
- **`apply_patch` paths are not sandboxed:** patching retains the local user's filesystem authority. Exact path/parser behavior is canonical in [apply_patch](./tools/apply_patch.md).
- **MCP audit logging can disclose values:** `agent-commands.yaml` can contain sensitive tool inputs even though it is gitignored, permission-restricted, and bounded. Treat the whole file as sensitive; see [Audit Logging](./Audit%20Logging.md) and [Secret Handling](./Secret%20Handling.md).
- **Peekaboo and permission drift:** the eleven Computer Use schemas are stable at server startup, but the installed Peekaboo CLI version, JSON fields, daemon/Bridge selection, Screen Recording, Accessibility, and Event Synthesizing permissions can change independently. Calls surface the resulting error and are never retried (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).
- **Ephemeral observation targets:** screenshot IDs and their capture-target mappings live only in process memory, are capped at 64, and disappear on restart or eviction. Coordinate actions fail closed when the mapping is unavailable, so callers must observe again (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).
- **Coordinate interpretation:** screen captures require display-origin translation, while app/window clicks use screenshot-relative coordinates with an explicit capture target. Multi-display layout or upstream bounds changes are important real-CLI regression cases (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`, `test/peekaboo.test.ts`).

## Intentional Unenforced Conventions

- Generated-tool paths and catalog rules intentionally exist only in model instructions; the server does not provision or validate them. See [Workspace Tooling](./Workspace%20Tooling.md).
- The workspace location is prompt guidance and an initial cwd, not a filesystem boundary (`src/index.ts`, `src/server/mcp-server.ts`).

`README.md` is the concise public entry point; the maintained wiki remains the detailed maintainer source. Update implementation truth here first and mirror only user-relevant setup or capability changes into the README (`wiki/raw/source-manifest.md`). Raw host-capability surveys are point-in-time evidence, not a roadmap.

## Related

- [Project Overview](./Project%20Overview.md)
- [Architecture Map](./Architecture%20Map.md)
- [HTTP Transport](./HTTP%20Transport.md)
- [Configuration and Startup](./Configuration%20and%20Startup.md)
- [Build and Test](./Build%20and%20Test.md)
- [ROADMAP](./ROADMAP.md)
- [Audit Logging](./Audit%20Logging.md)
- [apply_patch](./tools/apply_patch.md)
