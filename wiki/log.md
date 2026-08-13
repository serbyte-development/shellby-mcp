# Wiki Maintenance Log

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

## [2026-07-22] optimize | compact model-facing shell responses

- Lowered the default per-response output cap from 4096 to 2048 UTF-8 bytes while retaining the 65536-byte override and 262144-byte per-command transcript ceiling.
- Made pagination and diagnostic metadata conditional so normal completed commands return only status, exit code, and output.
- Removed duplicated `apply_patch` output from the human-readable content block; structured content remains authoritative.
- Shortened published instructions and added concrete RTK examples: `rtk test npm test` and `rtk git diff`.
- Added integration coverage proving a 6000-byte multibyte output can be reconstructed exactly through compact paginated responses.

## [2026-07-31] roadmap | add possible features page

- Added [[pages/Possible Features]] as a noncommittal feature backlog for usability, output efficiency, process management, portability, optional security controls, and related improvements.
- Included lightweight AI-agent delegation as a possible future primitive without expanding it into an orchestration design.

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

- Added Sharp and changed `computer_observe` image responses from Peekaboo's temporary PNG to a same-dimension quality-65 JPEG.
- Preserved screenshot-relative coordinate geometry while reducing large full-display payloads before base64 and tunnel transport.
- Updated focused Peekaboo and MCP integration expectations for `image/jpeg`.

## [2026-08-02] optimize | make Computer Use observations visual-first

- Changed `computer_observe` to omit accessibility elements by default while preserving the screenshot, snapshot ID, and targeting metadata.
- Added `computer_inspect`, which exposes Peekaboo's separately bounded `inspect-ui` text view for an existing snapshot without duplicating its structured response envelope.
- Updated model instructions, README, architecture, tool-contract, and integration-test documentation.

## [2026-08-04] update | make website fetching explicit and format-aware

- Renamed the model-facing `web_open` tool to `fetch_website` so its purpose is obvious during tool selection.
- Made cleaned Markdown the default and added `clean_html` and `raw_html` output formats.
- Bound cached cursors to both URL and format and returned the selected format in structured results.
- Directed models to use `fetch_website` before shell commands, scripts, or browser automation for known URLs, with fallbacks only for failures, authentication, or interaction.
- Updated focused unit and MCP integration coverage plus the maintained architecture documentation.

## [2026-08-04] secure | require a shared MCP bearer token

- Added a required 32-character `MCP_AUTH_TOKEN` and constant-time bearer-token validation for every `/mcp` method while keeping `/healthz` public.
- Loaded the gitignored repository-root `.env` at startup when present while retaining launch-environment overrides.
- Added integration coverage for authenticated clients plus missing and invalid credentials.
- Documented launch configuration, client header format, secret handling, and the remaining shared-secret trust boundary.

## [2026-08-04] revert | remove shared MCP bearer token

- Removed the static bearer-token middleware and required `MCP_AUTH_TOKEN` after confirming the ChatGPT connector supports OAuth rather than a fixed custom token in this setup.
- Restored the no-auth MCP transport, client tests, startup configuration, and documentation. The gitignored local `.env` remains user-owned and is not loaded by the server.

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

## [2026-08-05] organize | list Computer Use tools last

- Registered all seven core tools before the eleven `computer_*` tools so the Computer Use group appears at the end of `tools/list`.
- Added an exact integration assertion for the published tool order.

## [2026-08-05] organize | group core tools by workflow

- Ordered the non-Computer tools as independent utilities followed by the complete shell workflow: `fetch_website`, `apply_patch`, `shell_run`, `shell_poll`, `shell_reset`, `shell_list`, and `shell_close`.
- Updated the exact `tools/list` integration contract.

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

## [2026-08-09] configure | share canonical Codex skills by symlink

- Replaced the copied workspace `create-wiki` skill with a directory symlink to `~/.codex/skills/create-wiki` so the Codex skill remains the single maintained source.
- Added `skills/interview-me` as a symlink to `~/.codex/skills/interview-me`.
- Kept the workspace skill catalog selective rather than linking the entire `.codex/skills` directory.

## [2026-08-09] document | add tool metadata design standard

- Added [[pages/Tool Naming and Schema Design]] as the reusable ChatGPT-focused standard for tool names, descriptions, input schemas, parameter descriptions, and output schemas.
- Defined the core split as: name identifies, description routes, schema constrains, parameter descriptions disambiguate, output schema guides the next move, and the wiki explains implementation.
- Made negative boundary instructions reactive rather than default: add them for observed misuse or a clear recurring tool-selection collision.

## [2026-08-09] refine | apply tool metadata standard to skills

- Renamed `skill_use` to `skill_load` so the action matches what the tool actually does.
- Reduced skill tool descriptions to routing information and removed filesystem/schema-maintenance details from model-facing prose.
- Renamed the loaded `content` output field to `instructions` and kept `path` only to resolve skill-referenced local assets and files.

## [2026-08-09] implement | add agent feedback inbox

- Added `feedback_submit` for agents to record MCP problems, improvements, feature requests, and dream features they notice during normal tool use.
- Added a shared `FeedbackStore` that generates IDs and timestamps and serializes append-only JSONL writes to `feedback/agent-feedback.jsonl`.
- Added `feedback/README.md` to define the raw inbox and keep untriaged feedback separate from maintained wiki knowledge.
- Added MCP integration coverage for the tool schema and persisted record; verified the full 90-test suite and TypeScript type-check.

## [2026-08-09] trim | remove feedback folder README

- Removed `feedback/README.md`; the feedback inbox contract is already documented in the maintained wiki, so a second folder-level explanation was redundant.

## [2026-08-09] configure | advertise MCP server icon

- Added `icon-256_square.png` to the server implementation metadata as a 256x256 PNG data URI.
- Added integration coverage for the advertised icon metadata so it remains available without depending on a public asset route.

## [2026-08-09] harden | close authentication races and routing bypass

- Enabled strict Express routing so public `/mcp/` cannot alias the intentionally unauthenticated local `/mcp` endpoint.
- Moved first-owner binding after a successful tool result, buffered remote tool responses until the auth decision commits, and added a cross-process lock around first binding/reset state mutations.
- Added regression coverage for `/mcp/`, failed-call non-binding, reset-versus-bind races, and private URL normalization without doubled `/mcp` segments.
- Disabled the ngrok agent's local inspector and documented ngrok cloud request-path metadata as part of the trusted capability boundary.

## [2026-08-09] implement | add single-owner remote ChatGPT authentication

- Added durable `~/.shelly/auth.json` state with a random private MCP capability and one bound `X-OpenAI-Subject`; first valid remote tool call claims an unbound installation.
- Kept local `/mcp` agent-neutral while remote ChatGPT uses `/mcp/:capability`; reset is a local confirmed command that rotates the capability and clears ownership.
- Restricted the checked-in ngrok policy to ChatGPT source IP categories and private MCP paths so plain remote `/mcp` cannot bypass Shelly authentication.
- Added focused auth tests plus remote MCP integration coverage; full tests and TypeScript type-check pass without restarting PM2.

## [2026-08-09] document | record ChatGPT MCP identity metadata

- Documented OpenAI's `subject`, `session`, and optional `organization` metadata semantics and the live HTTP/header placement observed from ChatGPT.
- Recorded that subject remained stable across sampled conversations while session changed, without storing any actual opaque identifier values.

## [2026-08-09] simplify | remove capability URL authentication

- Removed capability generation, private `/mcp/:capability` routing, URL rotation, response buffering, and the cross-process lock dependency.
- Remote ChatGPT now uses exact `/mcp`; ngrok verifies ChatGPT origin and adds `X-Shelly-Remote: 1`, while Shelly binds the first marked `tools/call` to `X-OpenAI-Subject` before dispatch even when the tool call is invalid.
- Kept direct localhost `/mcp` unauthenticated and simplified reset to clearing only the bound subject.

## [2026-08-10] upgrade | migrate MCP TypeScript SDK to v2

- Replaced `@modelcontextprotocol/sdk` v1 with the modular v2 server, Node, Express, and client packages while preserving stateless request transports and shared runtime state.
- Adopted v2 Standard Schema tool definitions, handler request context, `NodeStreamableHTTPServerTransport`, and `createMcpExpressApp` with the existing 1 MiB JSON limit.
- Preserved ngrok's ChatGPT source-IP trust boundary and Shelly's `X-OpenAI-Subject` owner binding unchanged; kept exact `/mcp` matching with an explicit regex route.
- Updated v2 client regression expectations for trailing-slash routing and unknown-tool protocol errors.

## [2026-08-10] tooling | restore ESLint after MCP v2 install

- Restored the ESLint 10 + typescript-eslint toolchain required by `eslint.config.js` and pinned TypeScript to `6.0.3`, the newest compatible compiler line.
- Cleared the existing 11-rule baseline without changing runtime behavior; `npm ci`, lint, type-check, tests, and build pass.

## [2026-08-10] document | refresh wiki after MCP v2 migration

- Updated startup and build documentation for `pm2:restart`, MCP v2 packages, ESLint, Prettier, clean `npm ci`, and the current 97-test baseline.
- Recast the browser-subagent page from proposal notes to implemented architecture, removed an informal scratch note, and documented the detached-turn polling risk plus the current 60s-schema/10s-runtime wait mismatch.
- Marked README auth/tunnel/MCP-package guidance as stale, advanced the source-manifest implementation tripwire to `55ad62e`, and removed the obsolete Possible Features page now that browser subagents are implemented.

## [2026-08-10] fix | align subagent poll wait with schema

- Raised `ChatGptSubagentModule.poll()`'s maximum long-poll wait from 10 seconds to 60 seconds to match the published `chatgpt_subagent_poll.wait_ms` schema.
- Removed the resolved wait-limit mismatch from current browser-subagent and risk documentation.

## [2026-08-10] document | rewrite README for public repository

- Replaced the stale implementation-heavy README with a concise public setup and architecture guide covering current MCP v2 tools, remote ngrok + OpenAI-subject authentication, local access, PM2, Computer Use, browser subagents, configuration, and validation.
- Removed the maintainer-specific ngrok domain from the README, npm tunnel command, and PM2 config; ngrok now assigns a user URL by default and optional `NGROK_URL` supplies the user's own fixed domain.
- Updated the source manifest and startup wiki so maintained documentation matches the public tunnel configuration.

## [2026-08-10] refactor | organize source by capability

- Reorganized `src/` around `server/`, `auth/`, and `tools/`, keeping `src/index.ts` as the process composition root.
- Moved tool schemas, handlers, result shaping, and capability-specific errors out of the monolithic MCP server into the tool modules that own them.
- Kept complex capabilities grouped with their runtime adapters while leaving small tools such as skills and feedback as single files.
- Removed the `apply_patch` runtime's dependency on shell-specific error types and updated tests, package scripts, README references, and maintained wiki paths.

## [2026-08-10] simplify | make feedback free-form Markdown

- Replaced the structured feedback type, summary, details, and related-tool fields with one free-form Markdown `feedback` string.
- Simplified stored feedback records to `id`, `created_at`, and `feedback` so agents can choose the structure that best communicates their feedback.

## [2026-08-10] refactor | centralize static MCP configuration

- Added `src/config.ts` as the single static configuration surface for MCP server identity, version, icon, and shared tool metadata.
- Replaced seven duplicated tool metadata declarations with the shared `MCP_TOOL_META` configuration.
- Kept workspace-dependent instructions and runtime environment parsing in the server composition and process-entry layers.

## [2026-08-10] extend | centralize runtime defaults and instructions

- Consolidated MCP server identity, shared tool metadata, host, port, workspace, and command-log defaults under `MCP_CONFIG`.
- Moved the global instruction builder into `src/config.ts` and made its coding-instructions path follow the active workspace as `<workspace>/AGENTS.md`.
- Reused the central host and port defaults in both production startup and the injectable HTTP server while leaving capability-specific limits with their implementations.

## [2026-08-10] refactor | make MCP audit log human-readable

- Replaced the tab-separated `agent-commands.log` stream with compact Markdown entries in `agent-commands.md`, one entry per completed tool call.
- Added syntax-highlighted bounded shell command blocks, bounded ordinary arguments, and compact `apply_patch` metadata without patch bodies.
- Removed MCP response-body capture and the redundant `MCP_LOG_COMMANDS` shell-console logger.

## [2026-08-10] simplify | execute vendored apply_patch directly

- Removed the workspace `bin/apply_patch` symlink, runtime `MCP_CODEX_BIN` override, setup module, and shell `PATH` injection.
- Made the first-class `apply_patch` tool execute `vendor/apply-patch/apply_patch` directly while retaining an internal executable injection for deterministic integration tests.
- Removed the obsolete apply-patch setup tests and shell path-prepend feature; the build script remains the only mechanism that replaces the vendored binary.

## [2026-08-10] refactor | group apply-patch capability

- Moved workspace path resolution into `src/config.ts` and grouped apply-patch registration and startup setup under `src/tools/apply-patch/`.
- Consolidated the vendored binary, provenance, license, and notice under `vendor/apply-patch/` and updated the build script to write that layout directly.
- Split the old workspace-tools tests into focused config and apply-patch setup coverage and removed the obsolete `src/workspace-tools.ts` concept.

## [2026-08-10] refine | use YAML for MCP audit log

- Changed the active audit file from `agent-commands.md` to `agent-commands.yaml` for native VS Code syntax highlighting without a Markdown preview.
- Kept each completed tool call compact as one YAML document; shell commands use block scalars, ordinary arguments stay bounded, and patch bodies remain omitted.

## [2026-08-10] refine | reserve audit tags for noteworthy calls

- Removed the normal `^` audit tag so ordinary YAML entries stay visually neutral.
- Kept `?` for large responses, `~` for slow calls, and `!` for HTTP/connection failures.

## [2026-08-10] refine | highlight notable MCP audit calls

- Added Better Comments tags to YAML audit headers: `^` normal, `?` responses at least 8 KiB, `~` calls at least 5 seconds, and `!` HTTP/connection failures.
- Count response bytes in-flight without retaining response bodies and show the size only when the large-response threshold is crossed.

## [2026-08-10] extend | print public MCP URL

- Added `npm run print-url` to print the ChatGPT-ready `/mcp` URL from `NGROK_URL` or ngrok's active local tunnel metadata.
- Made `pm2:start` and `pm2:restart` print the URL automatically and made `npm start` perform a non-fatal lookup before starting the local server.
- Updated `pm2:restart` to clear the current `agent-commands.yaml` audit file instead of the obsolete `.log` path.

## [2026-08-10] release | simplify public Mac onboarding

- Added a Mac-first preflight and `npm run setup`, made PM2 a repository dependency, and removed the maintainer-specific ngrok executable path by resolving ngrok from the user's `PATH`.
- Made `npm start` own the production flow: build, start/reload MCP + ngrok, optionally launch the configured ChatGPT browser, wait for local health, and print the public `/mcp` URL.
- Added `npm run setup:chatgpt` and `npm run chatgpt` for a dedicated `~/.shelly/chatgpt-chrome` profile with loopback CDP, while keeping the MCP subagent module itself attach-only.
- Folded best-effort ChatGPT browser initialization into `npm run setup`, leaving `setup:chatgpt` as the strict retry path so first-time onboarding can be two npm commands.
- Replaced the public PM2-prefixed command surface with `start`, `restart`, `status`, `logs`, and `stop`, and rewrote README onboarding around one-time ngrok/ChatGPT sign-in followed by normal `npm start` usage.

## [2026-08-10] simplify | shorten subagent turn ids and expire idle agents

- Replaced random UUID turn IDs with per-agent IDs such as `agent_id_turn_1` and `agent_id_turn_2`.
- Added a 30-minute idle sweeper that closes owned ChatGPT tabs and removes local agent/turn state without deleting ChatGPT conversations.

## [2026-08-10] refine | prioritize coding tools in MCP order

- Reordered `tools/list` around the primary coding workflow: `shell_run`, `shell_poll`, `apply_patch`, shell management, subagents, web, skills, Computer Use, then feedback.
- Split shell registration into execution and management groups only so `apply_patch` can sit between polling and shell reset without changing tool behavior.

## [2026-08-10] research | compare real-work coding evals

- Added `pages/Possible Evals.md` comparing SWE-Lancer IC and SWE-Together for a ChatGPT Web + Shelly versus Codex benchmark.
- Recommended SWE-Lancer IC for the first single-turn comparison while retaining SWE-Together as the stronger future multi-turn candidate.
- Recorded SWE-Lancer's canonical Linux/offline runtime constraint and SWE-Together's state-conditional user-simulator dependency so benchmark adaptations are not mistaken for official runs.

## [2026-08-10] research | investigate bare-macOS SWE-Lancer

- Inspected all 198 current IC tasks and confirmed every grader uses Playwright plus a recorded mitmproxy flow; there is no unit-test-only subset suitable for simple native copying.
- Traced the shared grader through the Expensify dev server, flow replay, Pusher-Fake/nginx, certificate and host setup, and Linux-specific runtime paths.
- Recorded that repository snapshots are portable but the official grader runtime is not; a native macOS port is possible but conflicts with the goal of a simple no-container head-to-head benchmark.

## [2026-08-11] design | Document proposed parallel shell command envelope

- Documented a possible `shell_run` extension that mirrors `apply_patch`'s free-form envelope style: agents may submit multiple `*** Command` blocks in one call, the MCP runs independent child processes with a process-wide maximum concurrency of four, preserves per-command output/exit status, inherits a snapshot of the persistent shell context, and avoids array schemas or workflow-engine semantics (`pages/Persistent Shell Runtime.md`).

## [2026-08-11] refine | keep managed ChatGPT Chrome hidden during normal use

- Normal startup now hides the dedicated headed Chrome process while setup remains visible for sign-in.
- Subagent page creation triggers a best-effort re-hide because Chromium can reveal the app when CDP opens a new tab; hide failures never affect subagent execution.

## [2026-08-11] refine | define parallel shell polling and failure semantics

- Expanded the proposed parallel `shell_run` envelope design to stay entirely within the existing `shell_run` / `shell_poll` identity model, with one outer `shell_id` and `request_id` and no child shell IDs.
- Defined grouped per-child states/results, nonzero exits as normal command outcomes, independent output buffers, a proposed 10-minute child timeout, process-wide concurrency of four, and reset/abort behavior that preserves completed child results while killing running and queued work (`pages/Persistent Shell Runtime.md`).

## [2026-08-11] implement | add parallel shell command batches

- Added `shell_run` batch syntax using `*** Begin Commands`, repeated `*** Run` / `*** Run: relative/path` sections, and `*** End Commands` while leaving normal commands unchanged.
- Added process-wide four-child scheduling, persistent-shell exported-environment capture, relative batch directories, per-child bounded output and exit state, 10-minute child timeouts, grouped polling, and reset cleanup (`src/tools/shell/parallel-runner.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`).
- Added focused and MCP integration coverage for batching, queueing, cwd/environment inheritance, nonzero exits, timeout, malformed syntax, and reset behavior (`test/shell-session.test.ts`, `test/mcp-integration.test.ts`).

## [2026-08-11] verify | probe vendored apply_patch semantics

- Exercised the first-class MCP `apply_patch` tool against the checked-in Codex binary for add, update, delete, move, multi-file, multi-hunk, context-anchor, end-of-file, and malformed-patch behavior.
- Confirmed actionable failure diagnostics are returned through bounded `output`, while successful calls remain compact.
- Recorded three real-binary quirks: consecutive `@@` anchors are rejected, absolute patch file paths can escape `cwd`, and `Add File` overwrites existing paths. Documented that current integration tests use a fake patch executable and do not cover these parser semantics (`pages/Workspace Tooling.md`, `pages/Build and Test.md`, `pages/Open Questions and Risks.md`).

## [2026-08-11] refine | surface apply_patch failure diagnostics in text

- Kept the structured failure contract unchanged while also appending the bounded native stdout/stderr diagnostic to the MCP text response on failed `apply_patch` calls.
- Added integration coverage that verifies text-only clients receive both the failed exit summary and diagnostic output; successful responses remain compact (`src/tools/apply-patch/apply-patch.ts`, `test/mcp-integration.test.ts`, `pages/Workspace Tooling.md`).

## [2026-08-11] refine | make truncation semantics consistent

- Replaced shell `has_more` with `output_truncated` so completed commands no longer look like they require polling; `next_cursor` remains only the continuation token.
- Renamed permanent output loss to `output_dropped` plus `dropped_output_bytes` for shell and `apply_patch`, including parallel child results.
- Applied the same convention to `fetch_website`: recoverable response pagination uses `output_truncated`, while cache-ceiling source loss uses `source_dropped` plus `dropped_source_bytes` (`src/tools/shell/`, `src/tools/apply-patch/apply-patch.ts`, `src/tools/web/`, `test/`).

## [2026-08-11] refine | log apply_patch failure messages

- Added a bounded `message:` field to failed `apply_patch` entries in `agent-commands.yaml`, sourced from the tool's structured native diagnostic.
- Kept successful patch audit entries unchanged and retained the existing failed-patch body for debugging (`src/server/audit-log.ts`, `test/mcp-audit-log.test.ts`).

## [2026-08-11] refine | separate type-check and build TypeScript scopes

- Kept `src/**/*.ts` and `test/**/*.ts` in the shared `tsconfig.json` so `npm run type-check` validates both production and test code.
- Added `tsconfig.build.json` for `npm run build`, limiting emitted output to `src/**/*.ts` and restoring the expected `dist/index.js` layout without `dist/test` (`package.json`, `tsconfig.json`, `tsconfig.build.json`, `pages/Build and Test.md`).

## [2026-08-11] refine | raise default shell response limit

- Raised the default `shell_run` / `shell_poll` response cap from 2048 to 4096 UTF-8 bytes while retaining the 65536-byte maximum override.
- Updated the production `MCP_DEFAULT_OUTPUT_BYTES` fallback, session fallback, published schema assertion, and configuration wiki (`src/index.ts`, `src/tools/shell/session.ts`, `test/mcp-integration.test.ts`, `pages/Configuration and Startup.md`).

## [2026-08-11] refine | simplify parallel shell batch syntax

- Removed the `*** Begin Commands` / `*** End Commands` wrapper; a command beginning with repeated `*** Run` or `*** Run: relative/path` sections now selects batch mode directly.
- Kept `cwd` as the batch anchor rather than a sandbox: normal relative paths including `../` and `../../` are supported, while absolute run paths remain rejected.

## [2026-08-11] refine | require explicit parallel run directories

- Simplified parallel batch grammar to one marker only: every section begins `*** Run: <directory-or-relative-path>` followed by its zsh body; root runs use `.` or `./`.
- Allowed absolute run directories such as `/tmp` in addition to relative paths. Relative values still resolve from the batch `cwd` anchor, while absolute values are passed directly as the child process working directory (`src/tools/shell/parallel-runner.ts`, `src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`).

## [2026-08-11] fix | reject malformed later parallel markers

- Reserved any line beginning with `*** Run` as a batch directive so malformed later markers such as `*** Run:./wiki` or `*** Run:` reject the entire batch instead of executing inside the previous child (`src/tools/shell/parallel-runner.ts`, `test/shell-session.test.ts`).

## [2026-08-11] refine | make shell-limit recovery actionable

- Replaced the stale MCP-restart guidance for `shell_limit_reached` with instructions to reuse a shell or free an unused named shell through `shell_list` and `shell_close` (`src/tools/shell/session-manager.ts`, `test/shell-session-manager.test.ts`).

## [2026-08-11] docs | note ChatGPT MCP metadata refresh

- Noted that ChatGPT may keep previously imported MCP schemas/descriptions/instructions until the user updates the MCP app on the ChatGPT website; a local rebuild/restart updates runtime behavior but does not guarantee this client has refreshed tool metadata (`wiki/AGENTS.md`).

## [2026-08-11] refine | clarify parallel polling and audit failures

- Clarified that a parallel batch is polled only through its outer `(shell_id, request_id, next_cursor)`; child runs remain status entries in `commands` and are never polled independently (`src/tools/shell/shell-tools.ts`, `pages/MCP Tool Surface.md`).
- Audit logging now captures `shell_run` and `shell_poll` MCP error responses, parses JSON or Streamable HTTP SSE frames, records their bounded returned failure reason, and keeps child nonzero exits as normal tool results. `apply_patch` audit failures also fall back to returned text errors when no structured native diagnostic exists (`src/server/audit-log.ts`, `test/mcp-audit-log.test.ts`, `pages/Workspace Tooling.md`).

## [2026-08-12] document | record iOS shell architecture

- Added the concise `shell_iOS` architecture, bridge startup, macOS `nc` transport discovery, proven end-to-end behavior, and current limitations (`pages/iOS Shell.md`).

## [2026-08-12] defer | disable experimental iOS shell

- Commented out `shell_iOS` MCP registration while retaining its implementation, and recorded the `ios_system`, native-command, and Shortcut handoff findings (`src/server/mcp-server.ts`, `pages/iOS Shell.md`).

## [2026-08-12] configuration | centralize shell defaults

- Moved shared shell defaults and limits into `src/config.ts`; startup, direct shell sessions, and shell schemas now share one source of truth. Corrected the documented default maximum response cap to the implemented 32 KiB.

## [2026-08-12] configuration | raise shell response ceiling

- Raised the default `MCP_MAX_OUTPUT_BYTES` ceiling from 32 KiB to 64 KiB while keeping the default response size at 4 KiB.

## [2026-08-12] configuration | narrow public env surface

- Kept transcript retention, per-command capture, and record limits config-only; documented the smaller supported override surface in a commented `.env.example`.

## [2026-08-12] configuration | add environment template

- Added committed `.env.example` covering runtime and optional integration settings, and ignored local `.env*` files while preserving the template.

## [2026-08-12] configuration | centralize environment parsing

- Made `src/config.ts` the single environment-variable parsing boundary, removed scattered runtime config reads from startup and the disabled iOS shell, and changed schema tests to assert shared config/constants instead of duplicated numeric literals.

## [2026-08-12] output | use token-based response limits

- Switched shell, webpage, and `apply_patch` model-facing text caps from UTF-8 bytes to `o200k_base` tokens while leaving transcript, cache, and process-safety limits byte-based. Renamed public output settings and schema inputs to `*_TOKENS` / `max_output_tokens` and added shared tokenizer coverage (`src/tokenizer.ts`, `src/config.ts`, `src/tools/shell/`, `src/tools/web/`, `src/tools/apply-patch/apply-patch.ts`, `test/`).

## [2026-08-12] output | remove arbitrary token minimum

- Removed the arbitrary 64-token floor; shell and webpage response limits now accept any positive integer from 1 through their configured maximum.

## [2026-08-12] schema | canonicalize advertised JSON Schema order

- Added one registration-boundary transform that recursively orders JSON Schema keywords before `tools/list` while preserving tool parameter order and validation semantics (`src/server/tool-schema-order.ts`, `src/server/mcp-server.ts`).
- Prioritized the advertised order for LLM use: `description` first, then type/reference, default before exact choices, structure, and validation constraints.
- Removed redundant `$schema` metadata and Zod's artificial JavaScript safe-integer bounds from advertised integer schemas while preserving meaningful domain constraints and runtime validation.

## [2026-08-12] simplify | reduce configuration and composition plumbing

- Made public Node entry scripts load optional `.env` configuration before preflight or runtime imports, and fixed the production HTTP/tunnel port at 3333 instead of exposing a partial `PORT` override.
- Reused strict shared integer validation for environment parsing and rejected partial or fractional numeric strings.
- Kept process lifecycle, HTTP transport, and MCP tool registration separate while removing redundant default pass-through, request-scoped adapter fallbacks, unused runtime return fields, and unused transcript-limit accessors.
- Consolidated common JSON guards and remaining UTF-8 byte-boundary helpers in `src/utils.ts`; model-facing response pagination remains token-based in `src/tokenizer.ts`.
- Retained the deferred iOS implementation and corrected the wiki index to describe its disabled status.

## [2026-08-12] tooling | expose generated MCP schemas

- Added `npm run schemas` to print the actual `tools/list` definitions returned by the MCP, with optional tool-name filtering (`scripts/tool-schemas.ts`, `package.json`).

## [2026-08-12] simplify | clarify HTTP dependency ownership

- Let the HTTP boundary construct and close the default Peekaboo client instead of creating it in `src/index.ts` only to pass it through.
- Removed the ambiguous single-shell startup option; callers now inject a `ShellSessionManager` when they need a custom shell workspace.

## [2026-08-12] harden | prepare production launch

- Fixed production HTTP binding to loopback, raised the supported Node minimum to 22.13.0, and gave PM2 ten seconds for MCP shutdown cleanup.
- Created and repaired the repository audit log with owner-only `0600` permissions.

## [2026-08-12] simplify | flatten shell output-token configuration

- Renamed the shell default to `defaultOutputTokens`, removed `defaultReadTokens` / `maximumReadTokens` pass-through getters from shell sessions and the manager, and made `shell_run` / `shell_poll` advertise limits directly from `MCP_CONFIG.shell.defaultOutputTokens` and `maxOutputTokens`.

## [2026-08-12] tooling | expose runtime preflight

- Added `npm run preflight` as a read-only prerequisite check and made its version regression test resolve the checked module relative to the test file rather than the caller's working directory.

## [2026-08-12] simplify | compact parallel shell results

- Kept the parallel `*** Run:` input and durable outer polling contract while replacing the duplicated public `commands` array with labeled per-run blocks in the shared paged output.
- Omitted shell exit codes until available and collapsed permanent-output-loss signaling into `dropped_output_bytes`.

## [2026-08-12] rename | simplify subagent tool names

- Renamed the published `chatgpt_subagent` / `chatgpt_subagent_poll` tools to `subagent_start` / `subagent_poll` while keeping the ChatGPT-specific browser implementation internal (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`).

## [2026-08-12] simplify | compact subagent results

- Made structured content the sole subagent result channel, keeping completed answers only in `turns[].response` instead of duplicating them in text content.
- Removed conversation and message identifiers, collapsed failure code/message pairs into one `error` string, and retained only the identities and lifecycle fields needed for batched starts and polls.

## [2026-08-12] optimize | reduce derivable tool metadata

- Removed echoed format and boolean pagination/loss flags from `fetch_website`, removed the echoed skill name from `skill_load`, and omitted MCP annotation values that match protocol defaults or do not apply to read-only tools. Kept the `shell_list` result unchanged.

## [2026-08-12] optimize | compact shell polling results

- Split `shell_poll` from the catch-all `shell_run` result schema. Polling now returns only status, output, optional exit code, continuation cursor, and permanent dropped-byte count; expired cursors are tool errors instead of success flags.

## [2026-08-13] document | refresh complete subagent architecture

- Rewrote `pages/Browser ChatGPT Subagents.md` against current source: three-agent staggered starts, concurrent per-turn polling, poll-time page reconciliation, activity-based 30-minute cleanup, in-process conversation recovery, deleted-conversation failure semantics, and process-restart limits.
- Added a maintainer code map covering the subagent service, tracker, MCP wrapper, process composition, browser helpers, and focused tests; refreshed the wiki index and README summary to point to the page.
- Synchronized the architecture map, MCP tool-surface contract, and test-coverage summary with the same subagent lifecycle so the dedicated page is not contradicted elsewhere in the maintained wiki.
