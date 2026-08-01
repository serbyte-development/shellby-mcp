# Wiki Maintenance Log

## [2026-08-01] reconcile | enforce command output boundaries and absolute workspace paths

- Rejected `shell_poll` cursors before the requested command so polling cannot return earlier command output.
- Made rolling transcript eviction drop complete Unicode surrogate pairs.
- Normalized `MCP_CWD` to an absolute path while expanding `~` and resolving relative values from startup cwd.
- Recorded the ChatGPT-web-only decision to keep command output solely in `structuredContent` and avoid duplicated context.
- Reconciled stale tool counts, named-shell transport wording, implemented lifecycle tools, source-manifest claims, and verification dates across maintained pages.

## [2026-08-01] research | document bundled MCP and local capability surfaces

- Verified four ChatGPT child MCP servers and their advertised tools: Computer Use, Messages, Record & Replay event stream, and Computer History.
- Verified Codex's MCP server, experimental app-server transports and generated schema categories, sandbox interface, Code Mode host, Chronicle recorder, Playwright, Pixelmatch, OCR/PDF packages, Tectonic, and site utilities.
- Expanded the host integration survey with Craft Agents, LM Studio, Screen Studio, Screaming Frog, VS Code, and stable macOS-native command and framework alternatives.
- Added a three-adapter architecture: child MCP bridge, validated CLI adapter, and narrow protocol client.
- Recorded explicit safety boundaries for GUI writes, Messages, recording/history, inherited authentication and permissions, protocol breadth, version drift, and redistribution.

## [2026-08-01] update | add explicit shell lifecycle tools

- Added `shell_list` for read-only lifecycle inspection without refreshing idle timers.
- Added `shell_close` to terminate named shells and release capacity immediately.
- Protected the `default` shell from closure while preserving `shell_reset` recovery.
- Added manager and MCP integration coverage for listing, closure, active-command termination, capacity release, default protection, and reset compatibility.

## [2026-07-19] initialize | create maintainer architecture vault

- Scope: build and implementation architecture only; end-user agent usage is intentionally excluded.
- Ingested `README.md` as a potentially stale raw source and verified claims against `src/`, `test/`, `package.json`, `tsconfig.json`, `ngrok-traffic-policy.yml`, and recent Git history.
- Created nine maintained pages covering transport, tools, shell lifecycle, transcript semantics, workspace integration, configuration, testing, and risks.
- Recorded README drift around generated-tool provisioning, transcript units, best-effort process cleanup, coupled tunnel ports, and external ChatGPT instructions.
- Assumed no feature is deliberately parked; disconnected or unenforced behavior is listed in [[pages/Open Questions and Risks]].
- Validated all wiki links and index entries, verified the private-notes ignore rule, scanned for common secret patterns, and passed the repository test suite and TypeScript check.

## [2026-07-19] reconcile | update README from verified architecture

- Added a prominent maintainer link to [[index]].
- Corrected README claims about shell recovery, best-effort process-group cleanup, existing `apply_patch` reuse, generated-tool provisioning, transcript units, and tunnel port coupling.
- Preserved external ChatGPT and ngrok UI instructions as unverified setup guidance.

## [2026-07-19] update | add native patching and bounded command capture

- Added native `apply_patch` MCP tooling backed by the shared persistent shell, including absolute-cwd validation, generated internal request IDs, bounded results, and concurrent-command rejection.
- Moved concise RTK guidance into the `shell_run` tool and command-field descriptions while keeping it advisory.
- Replaced boolean raw logging with `off`, compact `summary`, and raw `full` modes; summary logs escape control characters and include line/byte counts.
- Added `MCP_COMMAND_TRANSCRIPT_BYTES`, `output_truncated`, and `dropped_output_bytes` so noisy commands cannot consume an unbounded share of the rolling transcript without an explicit signal.
- Hardened completion parsing with function-local wrapper state, random marker tokens kept outside evaluated state, safe-integer statuses, and surrogate-safe marker prefix flushing.
- Invoked native patching through the prepared absolute executable path and separated command-dropped bytes from response-omitted bytes.
- Added targeted shell and MCP integration coverage; 28 tests, TypeScript validation, and production build passed.

## [2026-07-20] research | document host application binary reuse

- Added a point-in-time survey of reusable executables bundled in installed macOS applications, including ChatGPT/Codex, Craft Agents, LM Studio, Screaming Frog, Screen Studio, VS Code, Cursor, Docker, GIMP, browsers, BBEdit, and iTerm.
- Documented four integration patterns: supported application CLI, bundled third-party utility, multicall binary, and extracted internal client.
- Recorded the current boundary that only `apply_patch` is provisioned and registered by this server; all other discoveries remain host integration candidates.
- Added integration guidance covering discovery, environment reconstruction, testing, output bounds, authentication safety, update fragility, and redistribution limits.

## [2026-07-31] roadmap | add possible features page

- Added [[pages/Possible Features]] as a noncommittal feature backlog for usability, output efficiency, process management, portability, optional security controls, and related improvements.
- Included lightweight AI-agent delegation as a possible future primitive without expanding it into an orchestration design.

## [2026-07-22] optimize | compact model-facing shell responses

- Lowered the default per-response output cap from 4096 to 2048 UTF-8 bytes while retaining the 32768-byte override and 262144-byte per-command transcript ceiling.
- Made pagination and diagnostic metadata conditional so normal completed commands return only status, exit code, and output.
- Removed duplicated `apply_patch` output from the human-readable content block; structured content remains authoritative.
- Shortened published instructions and added concrete RTK examples: `rtk test npm test` and `rtk git diff`.
- Added integration coverage proving a 6000-byte multibyte output can be reconstructed exactly through compact paginated responses.

## [2026-08-01] document | expose persistent Codex sub-agent workflow

- Added model-facing guidance for calling the installed Codex CLI noninteractively through `shell_run`.
- Documented CLI verification, `codex exec`, explicit-session `codex exec resume`, the `--ephemeral` continuity limitation, and the no-PTY TUI boundary.
- Added README guidance and integration coverage so future agents receive and retain the workflow.
