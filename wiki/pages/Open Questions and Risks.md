# Open Questions and Risks

Verified 2026-08-01.

## What This Is

This is the maintainer lint target for unresolved architectural risks and source drift.

## Active Risks

- **Unauthenticated arbitrary execution:** no HTTP authentication or authorization exists. Host validation prevents mismatched localhost Host headers but does not identify callers (`src/http-server.ts`, `src/mcp-server.ts`).
- **Caller-selected state boundaries:** named shells isolate runtime state, but the server does not authenticate callers or assign ownership. Any caller that knows or guesses another `shell_id` can access or reset that shell, and all shells retain the same operating-system permissions (`src/mcp-server.ts`, `src/shell-session-manager.ts`).
- **Child-process resource use is not sandboxed:** the named-shell count, transcripts, command records, and idle lifetime are bounded, and abandoned named shells are closed automatically. A currently active command or background process can still consume arbitrary CPU or memory under the local user account (`src/shell-session-manager.ts`, `src/shell-session.ts`).
- **Browser rendering is open-world:** `web_open` can navigate to HTTP or HTTPS resources reachable from the host, including local or private-network services. Cached extracted documents are count-, TTL-, and byte-bounded, but concurrent browser renders can still cause temporary CPU or memory spikes (`src/web-open.ts`, `src/mcp-server.ts`).
- **Best-effort descendant cleanup:** process-group signaling errors are swallowed to keep the server alive. A process the local user cannot signal may outlive reset or shutdown (`src/shell-session.ts`).
- **Rolling-output loss:** global eviction is reported through `cursor_expired`; per-command ceiling loss is reported through `output_truncated` and `dropped_output_bytes`. Neither class of discarded output is recoverable (`src/index.ts`, `src/shell-session.ts`).
- **Command logging can disclose values:** summary mode limits and escapes the preview but can still expose secrets from the first command line; full mode prints raw commands. Output is not logged (`src/index.ts`, `src/shell-session.ts`).
- **No CI enforcement:** tests, typecheck, and build exist only as local package scripts (`package.json`).
- **Port configuration is not composed:** `PORT` can move the HTTP listener, while the included ngrok command and Host rewrite remain fixed at 3333 (`src/index.ts`, `package.json`, `ngrok-traffic-policy.yml`).
- **Peekaboo and permission drift:** the ten Computer Use schemas are stable at server startup, but the installed Peekaboo CLI version, JSON fields, daemon/Bridge selection, Screen Recording, Accessibility, and Event Synthesizing permissions can change independently. Calls surface the resulting error and are never retried (`src/peekaboo.ts`, `src/computer-use-tools.ts`).
- **Ephemeral observation targets:** screenshot IDs and their capture-target mappings live only in process memory, are capped at 64, and disappear on restart or eviction. Coordinate actions fail closed when the mapping is unavailable, so callers must observe again (`src/peekaboo.ts`, `src/computer-use-tools.ts`).
- **Coordinate interpretation:** screen captures require display-origin translation, while app/window clicks use screenshot-relative coordinates with an explicit capture target. Multi-display layout or upstream bounds changes are important real-CLI regression cases (`src/peekaboo.ts`, `src/computer-use-tools.ts`, `test/peekaboo.test.ts`).
- **Future child-tool privilege inheritance:** Messages, recording, history, Codex, browser, and document tools may inherit the local user's macOS permissions or ChatGPT/Codex authentication. A future bridge must account for that boundary ([[pages/Bundled MCP and Agent Surfaces]]).
- **Private-interface drift:** application-bundle paths, generated app-server schemas, internal endpoints, and helper behavior can change independently of this repository. Runtime discovery and compatibility checks are required before any remaining candidate becomes a first-class tool ([[pages/Host Application Binary Reuse]]).

## Disconnected or Unenforced Conventions

- Generated-tool paths and catalog rules exist only in model instructions. Decide whether they should remain documentation-only or gain explicit workspace provisioning (`src/mcp-server.ts`, `src/index.ts`).
- The workspace location is prompt guidance and an initial cwd, not a filesystem boundary (`src/index.ts`, `src/mcp-server.ts`).
- `prepareApplyPatch` accepts an already-existing executable at `<workspace>/bin/apply_patch` without confirming that it targets the current `MCP_CODEX_BIN`; a stale but executable link can survive configuration changes (`src/workspace-tools.ts`).
- `PersistentShellSession.snapshot` accepts a `boundedToCommand` branch flag, but every production call passes `true`; the unbounded branch is currently dead complexity (`src/shell-session.ts`).

## Staleness Watch

`README.md` is retained as a raw source and may continue to contain user-facing setup details that drift independently of server code. Update maintained architectural truth here first, then update the README only when its public instructions also need to change ([[raw/source-manifest]]).

No feature is currently recorded as deliberately parked. Reclassify disconnected code here before expanding it into a full page.

## Related

- [[pages/HTTP Transport]]
- [[pages/Persistent Shell Runtime]]
- [[pages/Workspace Tooling]]
- [[pages/Host Application Binary Reuse]]
- [[pages/Bundled MCP and Agent Surfaces]]
- [[pages/Build and Test]]
