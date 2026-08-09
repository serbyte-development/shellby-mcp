# Wiki Maintenance Log

## [2026-08-06] trim | remove wiki filler and consolidate runtime pages

- Made the index the sole description and navigation layer; removed repeated page-purpose sections and related-link footers.
- Folded transcript, polling, idempotency, and concurrency contracts into the persistent-shell page.
- Removed obsolete feature, historical-surface, and host-binary pages whose durable facts already live in active architecture pages or raw evidence.
- Compressed maintainer rules, test coverage, and supporting templates without removing source authority, verification, logging, or secret-handling constraints.

## [2026-08-06] vendor | pin the Codex apply_patch executable

- Added the macOS arm64 Codex multicall executable as the private repository's Git-LFS-managed `vendor/apply_patch` snapshot.
- Made the vendored executable the default while preserving `MCP_CODEX_BIN` as an explicit override.
- Added default-path coverage and documented LFS checkout, platform scope, and workspace-symlink behavior.

## [2026-08-06] simplify | decouple native apply_patch from persistent shells

- Removed `shell_id` and made absolute `cwd` required for the native `apply_patch` tool.
- Replaced randomized shell heredocs and polling with a direct prepared-executable spawn and patch stdin.
- Kept bounded combined output and cancellation while allowing patching and shell commands to run independently.
- Updated integration coverage, README behavior, and maintained architecture pages.

## [2026-08-06] update | make shell labels contextual and persistent usage explicit

- Replaced the six-character request-ID recommendation with short contextual task and command labels while preserving the existing 1–128 character backend validation.
- Clarified that `shell_id` summarizes the task or project and `request_id` summarizes the specific command or step.
- Repositioned `cwd` as a one-time or intentional directory switch that should be omitted after the persistent shell reaches the desired directory.
- Expanded RTK guidance from Ripgrep searches to supported reads, listings, diffs, logs, tests, builds, and other noisy commands.
- Restored the concise screenshot privacy warning required by the existing integration contract.
- Updated integration assertions, README guidance, and the maintained tool-surface documentation.

## [2026-08-05] finalize | reconcile finished server and trim roadmap

- Re-verified the repository against source, tests, package scripts, PM2 configuration, README, and maintained wiki pages.
- Removed the stale possible-features backlog and recast host/application capability pages as concise historical reference rather than an active roadmap.
- Repaired the compact one-line command-history format and restored `apply_patch` output schemas, annotations, webpage-selection guidance, and the Computer Use privacy instruction after a tool-metadata regression.
- Corrected package-script names, `apply_patch` registration details, Computer Use tool counts, and the source-manifest verification tripwire.
- Made workspace `apply_patch` symlinks follow `MCP_CODEX_BIN` changes and removed an unused shell-snapshot branch.
- Recorded the server as feature-complete while retaining concrete operational risks and point-in-time raw research.

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

## [2026-08-06] document | note cross-platform apply_patch builds

- Documented that future platform-specific `apply_patch` binaries can be built from a pinned Codex source submodule instead of copying a partial Rust source tree.

## [2026-08-06] simplify | remove obsolete Git LFS configuration

- Removed the repository attribute, local filters, and pre-push hook after replacing the oversized Codex snapshot with the directly tracked standalone `apply_patch` binary.

## [2026-08-07] implement | add browser ChatGPT subagent module

- Added `src/chatgpt-subagent.ts`, a reusable Playwright-over-CDP module that creates one ChatGPT page per agent, reuses the same page for continuation, serializes same-agent sends, and recovers a closed page from the stored conversation URL.
- Added ChatGPT conversation response tracking with message-ID baselines, turn correlation, final user-facing assistant selection, and DOM fallback so later calls do not repeat the previous answer.
- Added focused unit coverage for conversation-node normalization, intermediate tool-message filtering, final-response selection, and duplicate suppression.
- Kept the module unregistered from MCP until live Chrome validation proves the browser contract.

## [2026-08-07] integrate | publish caller-named ChatGPT subagents

- Registered `chatgpt_subagent` as a first-class MCP tool with required descriptive `agent_id` and prompt inputs; only `agent_id` and final response are returned to the caller.
- Injected one process-level `ChatGptSubagentModule` across stateless MCP requests and added `MCP_CHATGPT_CDP_ENDPOINT` while keeping Chrome startup/profile selection external.
- Replaced same-agent queuing with `AGENT_BUSY`, capped simultaneous generations at two, added a 1.5-second local inter-turn delay, propagated request cancellation, and added stable semantic failures without automatic retries.
- Hardened managed-tab drift: foreground tab changes are irrelevant, while a closed or user-navigated managed tab is recovered at most once from its stored conversation without hijacking the changed tab.
- Added fake-service MCP integration coverage for caller-named agent continuity; validation was intentionally not executed in this change.

## [2026-08-07] harden | clean up subagent lifecycle

- Discard unrecoverable pre-conversation agent state after `AGENT_TARGET_LOST` so a caller can explicitly reuse the same descriptive `agent_id` on a later call without adding a reset tool.
- Made subagent disposal asynchronous and close only still-managed module-created ChatGPT pages, preventing orphaned tabs across MCP restarts while leaving the externally owned Chrome process and user-repurposed tabs untouched.
- Removed stale documentation that still described MCP registration as pending.

## [2026-08-07] improve | add MCP input and output character counts

- Added result/error character counts to MCP audit completion lines so `agent-commands.log` shows both tool input and output size without persisting full tool output.
- Changed audit timestamps to a human-readable `MON-D-H:MM:SS` format such as `AUG-23-14:23:23`.

## [2026-08-07] simplify | make browser subagent module attach-only

- Made Chrome lifecycle and profile selection explicit external prerequisites instead of adding a launcher/profile manager to the subagent module.
- Added a short CDP connection timeout and a clear failure when the configured debuggable Chrome endpoint is unavailable; the module never launches Chrome or chooses a profile.
- Added focused coverage for the unavailable-browser contract and updated the browser-subagent implementation plan accordingly.

## [2026-08-07] validate | prove live browser ChatGPT subagents

- Connected the module to a dedicated Chrome profile seeded from the active signed-in profile and verified authenticated ChatGPT conversations over CDP without foreground macOS input.
- Fixed composer submission to use page-targeted virtual keyboard input plus the ChatGPT send button; this removed duplicated prompt text seen with direct contenteditable filling.
- Verified two-turn memory on one `agentId`, normalized history reads, two concurrent agents with distinct Chrome targets, and closed-tab recovery through the stored conversation URL.
- Added hydration and send-button waits required for reliable continuation after reopening a conversation page.
- Confirmed normal background Chrome works; headless Chrome currently encounters a Cloudflare challenge.

## [2026-08-07] design | document browser-backed ChatGPT subagents

- Added [[pages/Browser ChatGPT Subagents]] with the proposed CDP/Playwright architecture, process-level agent-to-page registry, same-tab continuation, stale-target recovery, and per-agent concurrency rules.
- Documented network-level conversation tracking using message IDs and turn/graph metadata so each delegated call returns only its new final assistant response.
- Defined a minimal `chatgpt_subagent` MCP contract and an implementation/test plan that fits the current composition and exact tool-list contracts.

## [2026-08-07] audit | log every MCP tool invocation

- Replaced shell-only command-history recording with `src/mcp-audit-log.ts`, which intercepts JSON-RPC `tools/call` requests at the HTTP boundary so all current and future tools are covered automatically.
- `agent-commands.log` now records tool name, full serialized arguments, serialized-argument character count, and a separate completion line with duration, HTTP status, and finished/closed state.
- Removed duplicate shell-specific persistence while retaining `MCP_LOG_COMMANDS` as the independent shell console-log control.

## [2026-08-07] refine | improve MCP audit readability

- Changed `shell_run` audit entries to place command text in its own readable block instead of JSON-escaping it alongside metadata.
- Changed `apply_patch` audit entries to omit patch bodies while retaining total input size, patch character count, cwd, and other parameters.

## [2026-08-07] improve | detach long-running ChatGPT subagent turns

- Changed `chatgpt_subagent` to return immediately after submission with a server-owned `turn_id` instead of holding the MCP request open for the full ChatGPT generation.
- Added `chatgpt_subagent_poll` with immediate or bounded long-poll status checks and terminal completed/failed results; polling never resubmits a prompt.
- Kept one active turn per agent and the global generation cap for the full background turn lifetime, and removed the fixed response-duration timeout so long-running subagents can continue until completion or a concrete browser failure.

## [2026-08-07] harden | bound apply_patch abort cleanup

- Changed direct `apply_patch` processes to use a detached POSIX process group and mirror the shell runtime's `SIGTERM` → 500 ms grace → `SIGKILL` cleanup sequence on request abort.
- Added forced promise settlement after a second bounded grace period so a missing child `close` event cannot leave the MCP tool request pending forever.
- Added a focused integration regression using a SIGTERM-resistant fake patch executable and verified the process group is force-killed after the originating HTTP request closes.

## [2026-08-08] improve | add subagent progress heartbeat

- Added `activity` and `activity_age_ms` to running `chatgpt_subagent_poll` results so parent agents can tell that long-running delegated work is still progressing.
- Kept the activity vocabulary deliberately coarse: `Working`, `Searching the web`, `Using tools`, and `Generating response`; intermediate reasoning text is not exposed.
- Refresh heartbeat time only when tracked network state changes or visible assistant response text grows, so repeated polling cannot manufacture false liveness.
- Added unit and MCP schema coverage and verified the full test suite, type-check, and build.

## [2026-08-08] implement | add dynamic workspace skills

- Added `skill_list` and `skill_use` backed by `<workspace>/skills`, keeping individual skill names out of the MCP schema so the catalog can change without a rebuild.
- Added path-safe skill-name validation, 256 KiB `SKILL.md` bounds, optional frontmatter descriptions, and compatibility with skill-directory symlinks.
- Seeded the workspace with the complete existing `create-wiki` skill bundle; the current copy can later be replaced by a symlink to the Codex skill directory.
- Added focused unit and MCP schema coverage.

## [2026-08-08] refine | clarify subagent continuation contract

- Reframed `chatgpt_subagent` as a persistent multi-turn conversation tool: reuse the same `agent_id` to continue the same conversation, while each call returns a separate `turn_id` for polling.
- Simplified the subagent and polling descriptions so conversation identity, next-message semantics, turn polling, and liveness are clear without duplicating the full workflow across fields.
- Removed integration assertions that lock server/tool description or instruction prose while retaining behavioral, annotation, ordering, and schema-mechanics coverage.

## [2026-08-08] refine | make subagent verbosity caller-selectable

- Added `oververbosity` 1-5 to `chatgpt_subagent`, defaulting to 2; level 5 sends the first prompt unchanged.
- Replaced the custom first-turn brevity instruction with the Caveman prompt wording, mapping lower verbosity levels to ultra/full/lite and using a softened lite mode at level 4.
- Kept response-style injection first-turn-only so continuation prompts remain untouched.

## [2026-08-08] refine | make subagent responses context-efficient

- Appended a compact expert-user "Caveman Mode" directive to only the first successfully submitted prompt for each `agent_id`; follow-up prompts remain unchanged.
- Tracked whether an agent has submitted its first turn and passed the exact augmented prompt into response matching so first-turn tracking remains reliable.

## [2026-08-08] refine | clarify subagent oververbosity scope

- Clarified `oververbosity` as a 1-5 setting for a new subagent conversation, defaulting to `2` and applying only when an `agent_id` is first created.
- Removed implementation-specific level behavior from the public field description so callers can rely on normal verbosity semantics while still understanding that later values do not change an existing conversation.
