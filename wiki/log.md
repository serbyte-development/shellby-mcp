# Wiki Maintenance Log

## [2026-08-05] update | collect agent shell command history

- Added the fixed, repository-local `agent-commands.log` for every newly accepted model-supplied `shell_run` command.
- Used compact local timestamps and JSON-escaped command text so multiline commands remain one physical line.
- Kept exact retries and internal native `apply_patch` commands out of the history.
- Gitignored the file and documented the behavior separately from configurable terminal logging.

## [2026-08-05] update | prefer RTK-backed ripgrep searches

- Updated shared and tool-specific MCP instructions to prefer `rtk rg` and `rtk rg --files` for text and file searches.
- Preserved raw `rg` as an explicit exception when exact unfiltered output is necessary.
- Updated integration assertions, README guidance, and the MCP tool-surface wiki page.

## [2026-08-05] update | add explicit persistent shell cwd

- Added optional `shell_run.cwd` for starting a command in a validated absolute directory.
- Documented that a successful explicit directory selection persists for later calls using the same `shell_id`.
- Added `cwd` to run and poll results, with completed commands reporting the resulting persistent directory even when the command changes it internally.
- Updated the shell protocol, tool-surface, README, and test-coverage documentation.

## [2026-08-05] reconcile | reduce duplicated model instructions

- Replaced copied command-surface wording with MCP-native `shell_run.command` terminology.
- Made tool descriptions and schemas authoritative for tool-specific mechanics such as polling, request IDs, cursor continuation, RTK preference, URL fetching, and snapshot targeting.
- Reduced the server-level instruction block to cross-tool efficiency rules, file-editing constraints, workspace conventions, and trust boundaries.
- Removed the unnecessary blocking-wait rule.
- Replaced the expanded file-editing policy with the concise `apply_patch` guidance used by GPT-5.6 Sol, including its formatter, bulk-rewrite, simple-shell, and Python exceptions.
- Added integration assertions that tool-specific guidance is not duplicated in the global instructions.

## [2026-08-04] update | make website fetching explicit and format-aware

- Renamed the model-facing `web_open` tool to `fetch_website` so its purpose is obvious during tool selection.
- Made cleaned Markdown the default and added `clean_html` and `raw_html` output formats.
- Bound cached cursors to both URL and format and returned the selected format in structured results.
- Directed models to use `fetch_website` before shell commands, scripts, or browser automation for known URLs, with fallbacks only for failures, authentication, or interaction.
- Updated focused unit and MCP integration coverage plus the maintained architecture documentation.

## [2026-08-01] ops | run the stateful MCP in PM2 fork mode

- Changed the single MCP process from PM2 cluster mode to fork mode.
- Kept the ngrok process in fork mode and preserved one instance of each app.
- Verified local health and the public MCP handshake after recreating and saving the PM2 process list.

## [2026-08-01] ops | keep the ngrok tunnel alive with PM2

- Added `unhinged-terminal-ngrok` to the PM2 ecosystem using the existing fixed domain and traffic policy.
- Added focused npm scripts for starting, inspecting, logging, and stopping the PM2-managed tunnel.
- Retained the foreground `npm run tunnel` command for temporary debugging.

## [2026-08-01] update | identify non-default shell responses

- Added `shell_id` to `shell_run` and `shell_poll` structured responses only when a non-default shell is selected.
- Kept default-shell responses unchanged and compact.
- Added integration coverage for default omission and named-shell run/poll responses.

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

## [2026-08-01] update | replace child Computer Use bridge with direct Peekaboo CLI

- Replaced stale ChatGPT Computer Use child-MCP architecture claims with the shared serialized `PeekabooClient` and stable ten-tool `computer_*` surface.
- Documented snapshot-first actions, screenshot-relative coordinate translation, bounded JSON/image handling, direct `execFile` invocation, and the no-retry boundary.
- Added Homebrew installation, `MCP_PEEKABOO_BIN`, permission status/request commands, and the rule that advanced Peekaboo operations remain available through `shell_run`.
- Updated architecture, tool, startup, test, reuse, bundled-surface, roadmap, risk, index, README, and source-manifest documentation from current `src/` and `test/` evidence.

## [2026-08-02] optimize | compress Computer Use observations

- Added Sharp and changed `computer_observe` image responses from Peekaboo's temporary PNG to a same-dimension quality-75 JPEG.
- Preserved screenshot-relative coordinate geometry while reducing large full-display payloads before base64 and tunnel transport.
- Updated focused Peekaboo and MCP integration expectations for `image/jpeg`.

## [2026-08-02] optimize | make Computer Use observations visual-first

- Changed `computer_observe` to omit accessibility elements by default while preserving the screenshot, snapshot ID, and targeting metadata.
- Added `computer_inspect`, which exposes Peekaboo's separately bounded `inspect-ui` text view for an existing snapshot without duplicating its structured response envelope.
- Updated model instructions, README, architecture, tool-contract, and integration-test documentation.

## [2026-08-04] secure | require a shared MCP bearer token

- Added a required 32-character `MCP_AUTH_TOKEN` and constant-time bearer-token validation for every `/mcp` method while keeping `/healthz` public.
- Loaded the gitignored repository-root `.env` at startup when present while retaining launch-environment overrides.
- Added integration coverage for authenticated clients plus missing and invalid credentials.
- Documented launch configuration, client header format, secret handling, and the remaining shared-secret trust boundary.

## [2026-08-04] revert | remove shared MCP bearer token

- Removed the static bearer-token middleware and required `MCP_AUTH_TOKEN` after confirming the ChatGPT connector supports OAuth rather than a fixed custom token in this setup.
- Restored the no-auth MCP transport, client tests, startup configuration, and documentation. The gitignored local `.env` remains user-owned and is not loaded by the server.

## [2026-08-05] organize | list Computer Use tools last

- Registered all seven core tools before the eleven `computer_*` tools so the Computer Use group appears at the end of `tools/list`.
- Added an exact integration assertion for the published tool order.

## [2026-08-05] organize | group core tools by workflow

- Ordered the non-Computer tools as independent utilities followed by the complete shell workflow: `fetch_website`, `apply_patch`, `shell_run`, `shell_poll`, `shell_reset`, `shell_list`, and `shell_close`.
- Updated the exact `tools/list` integration contract.
