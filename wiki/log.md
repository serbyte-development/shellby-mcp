# Wiki Maintenance Log

## [2026-07-19] initialize | create maintainer architecture vault

- Scope: build and implementation architecture only; end-user agent usage is intentionally excluded.
- Ingested `README.md` as a potentially stale raw source and verified claims against `src/`, `test/`, `package.json`, `tsconfig.json`, `ngrok-traffic-policy.yml`, and recent Git history.
- Created nine maintained pages covering transport, tools, shell lifecycle, transcript semantics, workspace integration, configuration, testing, and risks.
- Recorded README drift around generated-tool provisioning, transcript units, best-effort process cleanup, coupled tunnel ports, and external ChatGPT instructions.
- Assumed no feature is deliberately parked; disconnected or unenforced behavior is listed in [Open Questions and Risks](./pages/Open%20Questions%20and%20Risks.md).
- Validated all wiki links and index entries, verified the private-notes ignore rule, scanned for common secret patterns, and passed the repository test suite and TypeScript check.

## [2026-07-19] reconcile | update README from verified architecture

- Added a prominent maintainer link to [index](./index.md).
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

- Added `pages/Possible Features.md` as a noncommittal feature backlog for usability, output efficiency, process management, portability, optional security controls, and related improvements.
- Included lightweight AI-agent delegation as a possible future primitive without expanding it into an orchestration design.

## [2026-08-01] ops | run the stateful MCP in PM2 fork mode

- Changed the single MCP process from PM2 cluster mode to fork mode.
- Kept the ngrok process in fork mode and preserved one instance of each app.
- Verified local health and the public MCP handshake after recreating and saving the PM2 process list.

## [2026-08-01] ops | keep the ngrok tunnel alive with PM2

- Added `shellby-terminal-ngrok` to the PM2 ecosystem using the existing fixed domain and traffic policy.
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

- Added [Browser ChatGPT Subagents](./pages/Browser%20ChatGPT%20Subagents.md) with the proposed CDP/Playwright architecture, process-level agent-to-page registry, same-tab continuation, stale-target recovery, and per-agent concurrency rules.
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

- Added [Tool Naming and Schema Design](./pages/Tool%20Naming%20and%20Schema%20Design.md) as the reusable ChatGPT-focused standard for tool names, descriptions, input schemas, parameter descriptions, and output schemas.
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

- Added durable `~/.shellby/auth.json` state with a random private MCP capability and one bound `X-OpenAI-Subject`; first valid remote tool call claims an unbound installation.
- Kept local `/mcp` agent-neutral while remote ChatGPT uses `/mcp/:capability`; reset is a local confirmed command that rotates the capability and clears ownership.
- Restricted the checked-in ngrok policy to ChatGPT source IP categories and private MCP paths so plain remote `/mcp` cannot bypass shellby-mcp authentication.
- Added focused auth tests plus remote MCP integration coverage; full tests and TypeScript type-check pass without restarting PM2.

## [2026-08-09] document | record ChatGPT MCP identity metadata

- Documented OpenAI's `subject`, `session`, and optional `organization` metadata semantics and the live HTTP/header placement observed from ChatGPT.
- Recorded that subject remained stable across sampled conversations while session changed, without storing any actual opaque identifier values.

## [2026-08-09] simplify | remove capability URL authentication

- Removed capability generation, private `/mcp/:capability` routing, URL rotation, response buffering, and the cross-process lock dependency.
- Remote ChatGPT now uses exact `/mcp`; ngrok verifies ChatGPT origin and adds `X-shellby-mcp-Remote: 1`, while shellby-mcp binds the first marked `tools/call` to `X-OpenAI-Subject` before dispatch even when the tool call is invalid.
- Kept direct localhost `/mcp` unauthenticated and simplified reset to clearing only the bound subject.

## [2026-08-10] upgrade | migrate MCP TypeScript SDK to v2

- Replaced `@modelcontextprotocol/sdk` v1 with the modular v2 server, Node, Express, and client packages while preserving stateless request transports and shared runtime state.
- Adopted v2 Standard Schema tool definitions, handler request context, `NodeStreamableHTTPServerTransport`, and `createMcpExpressApp` with the existing 1 MiB JSON limit.
- Preserved ngrok's ChatGPT source-IP trust boundary and shellby-mcp's `X-OpenAI-Subject` owner binding unchanged; kept exact `/mcp` matching with an explicit regex route.
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
- Added `npm run setup:chatgpt` and `npm run chatgpt` for a dedicated `~/.shellby/chatgpt-chrome` profile with loopback CDP, while keeping the MCP subagent module itself attach-only.
- Folded best-effort ChatGPT browser initialization into `npm run setup`, leaving `setup:chatgpt` as the strict retry path so first-time onboarding can be two npm commands.
- Replaced the public PM2-prefixed command surface with `start`, `restart`, `status`, `logs`, and `stop`, and rewrote README onboarding around one-time ngrok/ChatGPT sign-in followed by normal `npm start` usage.

## [2026-08-10] simplify | shorten subagent turn ids and expire idle agents

- Replaced random UUID turn IDs with per-agent IDs such as `agent_id_turn_1` and `agent_id_turn_2`.
- Added a 30-minute idle sweeper that closes owned ChatGPT tabs and removes local agent/turn state without deleting ChatGPT conversations.

## [2026-08-10] refine | prioritize coding tools in MCP order

- Reordered `tools/list` around the primary coding workflow: `shell_run`, `shell_poll`, `apply_patch`, shell management, subagents, web, skills, Computer Use, then feedback.
- Split shell registration into execution and management groups only so `apply_patch` can sit between polling and shell reset without changing tool behavior.

## [2026-08-10] research | compare real-work coding evals

- Added `pages/Possible Evals.md` comparing SWE-Lancer IC and SWE-Together for a ChatGPT Web + shellby-mcp versus Codex benchmark.
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

## [2026-08-13] code | Add one-shot submitted-turn recovery before terminal subagent failure

- Added one shared conversation-based recovery attempt before a successfully submitted turn becomes terminal after browser observation failure.
- Recovery can complete from saved conversation state or leave the turn running; a later independent observation failure becomes terminal.

## [2026-08-13] simplify | Make subagent_poll the sole active turn reconciler

- Removed the legacy 250 ms background DOM watcher, `waitForResponse()`, `trackTurn()`, and their abort/completion plumbing.
- Kept the event-driven ChatGPT network listener only for cached response evidence and coarse activity heartbeat; it never resolves turn status itself.
- `subagent_poll` now owns response reconciliation and terminal generation-slot release, with idle cleanup retained as the emergency reclamation path.

## [2026-08-13] document | Record compact model-facing output direction

- Added a roadmap item to evaluate internal typed result schemas plus a shared MCP-boundary transform that emits compact, purpose-built model content, reserving advertised structured output for consumers that actually need a machine-readable contract.

## [2026-08-14] simplify | Add configurable compact MCP output and subagent completion events

- Added `always` / `optional` / `never` model-facing output modes. `optional` is the default and exposes compact Markdown unless a non-Computer tool explicitly requests `structured: true`; Computer Use remains unchanged.
- Added one generic lossless structured-result-to-Markdown transform at the registration boundary and retained each tool's typed structured result internally.
- Passive ChatGPT network completion now finishes the local turn, releases generation capacity, queues `agent_finished:<agent_id>:<turn_id>`, and delivers that event once on the next MCP tool response. Renamed the public retrieval tool to `subagent_result`.
- Audit logging now records serialized MCP input tokens and final model-facing output tokens when the complete ordinary-tool response is available; incomplete/Computer outputs omit the `out` count instead of adding special-case accounting.

## [2026-08-14] fix | Tighten compact output, subagent matching, and audit accounting

- Preserve scalar string semantics in compact Markdown by quoting strings such as `"false"`, `"null"`, and numeric-looking values instead of rendering them identically to booleans, null, or numbers.
- Require the submitted prompt to be present before network-tracked assistant output can complete that turn, preventing an unrelated conversation response from being bound to the active subagent.
- Remove queued `agent_finished` events when their local turn state expires so the parent is never notified about a result that `subagent_result` can no longer retrieve.
- Match JSON-RPC batch responses by request ID before computing output tokens or failure state in the audit logger.

## [2026-08-14] harden | Recover from blocking ChatGPT composer modal

- Dismiss ChatGPT's known `#modal-beacon` overlay with `Escape` before prompt entry and retry a blocked composer/send interaction once if that same overlay races back into view.
- Keep retry scope to the atomic click or keypress that failed, so overlay recovery cannot duplicate an already-submitted turn.

## [2026-08-14] simplify | Reduce test-suite duplication and fixed waits

- Split parallel shell coverage into `test/shell-parallel.test.ts` and moved shared shell polling/completion helpers into `test/helpers/shell.ts`.
- Replaced fixed parallel-test delays with release/PID synchronization, centralized temporary-directory cleanup in `test/helpers/temp.ts`, and removed redundant script subprocesses and brittle model-facing prose assertions.
- Reduced repeated MCP audit-log setup while preserving behavioral assertions.

## [2026-08-14] probe | Add temporary native MCP Tasks compatibility probe

- Added `temporary_native_task_probe`, a side-effect-free MCP 2025-11-25 task probe with an unmistakable `MCP_NATIVE_TASK_PROBE_OK` result.
- Kept task state in memory and isolated raw task lifecycle handling to the probe while preserving ordinary tool dispatch.
- Documented that MCP SDK 2.0 has legacy task wire vocabulary but no task runtime and strips task fields on the 2026-07-28 protocol path.

## [2026-08-14] probe | Isolate MCP 2026 Tasks compatibility experiment

- Removed the temporary Tasks probe from shellby-mcp's production MCP registration, HTTP path, integration surface, and maintained tool documentation.
- Rebuilt it under `temporary/mcp-2026-tasks-probe/` as a standalone modern-only MCP 2026-07-28 server using the current `io.modelcontextprotocol/tasks` extension and `tasks/get` lifecycle.

## [2026-08-14] simplify | Split subagent implementation and matching tests by ownership

- Kept subagent lifecycle/state-machine behavior in `src/tools/subagent/chatgpt-subagent.ts`, moved ChatGPT Web/CDP mechanics into `src/tools/subagent/chatgpt-subagent-browser.ts`, and moved shared contracts into `src/tools/subagent/chatgpt-subagent-contracts.ts`.
- Split browser-adapter coverage into `test/chatgpt-subagent-browser.test.ts` while keeping lifecycle coverage in `test/chatgpt-subagent.test.ts`; preserved the existing behavioral coverage without adding manager/service abstractions.

## [2026-08-14] defer | Preserve MCP 2026 Tasks probe for future evaluation

- Deferred MCP `2026-07-28` / `io.modelcontextprotocol/tasks` adoption because the current shellby-mcp MCP is working well and there is no concrete migration need.
- Kept `temporary/mcp-2026-tasks-probe/` isolated for a future manual compatibility check; production `/mcp` remains unchanged by the experiment.

## [2026-08-14] optimize | Bound shell and web output hot paths

- Added one shared local-window token chunker for shell transcript reads and `fetch_website` pagination so large retained outputs no longer re-tokenize the entire remaining string on every page.
- Replaced per-code-point substring allocation in UTF-8 capture limiting with direct UTF-8 width calculation, and made parallel-batch completion O(n) overall instead of rescanning every run after each child finishes.
- Local micro-benchmarks dropped 12 bounded reads over a 1.1 MB source from about 1.53 s to 17 ms and 50 UTF-8 bounds over a 300 KB source from about 181 ms to 25 ms; these are hot-path measurements, not end-to-end MCP latency.

## [2026-08-14] release | Prepare public OSS surface

- Standardized the public identity around `chatgpt-local-shell-mcp` / shellby-mcp, added MIT licensing, concise contribution/security guidance, arm64 macOS CI, and a gitleaks allowlist for one historical fake integration-test token.
- Added a simple README architecture diagram under `docs/assets/`, moved the deferred MCP Tasks probe from `temporary/` to `experiments/`, and removed repository-local personal paths from the current tree.
- Re-ran diagram validation, gitleaks history scanning, dependency audit, lint, type-check, focused integration validation, and build as part of the public-release audit.

## [2026-08-14] identity | Rename product to Shellby MCP

- Repositioned the project as **Shellby MCP**, a context-optimized agent harness for ChatGPT Web, with the public tagline centered on full computer access, persistent tools, and multi-agent capabilities.
- Renamed the repository/package/runtime identity, trusted remote marker, PM2 processes, managed state paths, architecture assets, and maintained documentation; new installs default to `~/Desktop/agent-workspace` while the maintainer's broader existing workspace remains explicitly configured locally.
- Added a 1280×640 social-preview asset and recorded broader host portability as future work while keeping Apple Silicon macOS explicit as the current release target.

## [2026-08-14] test | Stabilize expired-cursor integration coverage

- Replaced the expired `shell_poll` integration test's fixed completion delay with direct shell activity synchronization so slow CI runners cannot poll before transcript rollover has actually occurred.

## [2026-08-14] ci | Update GitHub Actions runtimes

- Updated `actions/checkout` and `actions/setup-node` from v4 to their current v7 majors after GitHub flagged the older Node 20 action runtimes as deprecated.

## [2026-08-14] rename | Standardize local workspace identity

- Renamed Austin's broader local agent workspace from `~/Desktop/chatgpt-workspace` to `~/Desktop/agent-workspace` and updated the local `MCP_CWD` override to match the public default.
- Scanned current repo/workspace/user configuration and symlink targets for shellby-mcp, `chatgpt-local-shell-mcp`, and old workspace-path references; repointed live `git-init-org` and `diagram-design` symlinks and retained dated raw/history or editor-cache artifacts rather than rewriting history.

## [2026-08-14] optimize | Avoid duplicate completed shell poll reads

- Skip the preliminary transcript tokenization for already-completed normal and parallel `shell_poll` records; running polls retain the existing read-before-wait behavior.

## [2026-08-14] fix | Restore first-turn ChatGPT URL binding

- Reconciliation now captures a newly submitted agent's stable `/c/<conversation-id>` URL before page recovery validation can reject the natural new-chat navigation; documented the `/` -> transient `/c/WEB:...` -> stable `/c/<id>` lifecycle and added regression coverage.

## [2026-08-14] simplify | remove duplicate subagent network-final scan

- Removed the second synchronous `findFinalResponse()` call from `reconcileRunningTurn()`; `attachTurnListeners()` already installs the update listener and immediately checks the same tracker state before reconciliation reaches any `await`.
- Updated subagent lifecycle documentation to reflect the single passive-tracker check plus DOM fallback (`src/tools/subagent/chatgpt-subagent.ts`, `pages/Browser ChatGPT Subagents.md`).

## [2026-08-14] simplify | remove unused subagent metadata

- Removed write-only agent message state and turn-level conversation/message metadata that never reached the MCP tool contract.
- Shrunk internal start/poll result types to fields consumed by `subagent-tools.ts`, while preserving agent-level conversation ID/URL state used for recovery.
- Removed unused `read()`/`closeAgent()` lifecycle methods, their `UNKNOWN_AGENT` path, and visible-conversation reader; recovery conversation messages now retain only role/text because message IDs had no consumer.

## [2026-08-14] optimize | Skip webpage media downloads

- `fetch_website` now aborts Chromium image, media, and font requests before navigation while preserving their DOM references for HTML/Markdown extraction (`src/tools/web/web-open.ts`, `pages/MCP Tool Surface.md`).

## [2026-08-14] roadmap | note functional subagent refactor

- Added a future roadmap item to replace the class-based subagent state container with a functional factory/closure design when that subsystem is next substantially changed; this is an architectural consistency goal, not a repo-wide class-removal mandate (`pages/ROADMAP.md`).

## [2026-08-14] optimization | Lazy shell transcript compaction

- Changed rolling shell transcript eviction to advance a logical head and compact discarded backing text in batches, avoiding repeated large string slicing after the transcript fills (`src/tools/shell/session.ts`).
- Added repeated-overflow cursor regression coverage (`test/shell-session.test.ts`).

## [2026-08-14] simplify | Remove development feedback tool

- Removed `feedback_submit`, its repository-local feedback store/inbox, server dependency injection, published instructions, tests, and current documentation because it existed only for development-time feedback collection.

## [2026-08-14] setup | Delegate Computer Use permissions to Peekaboo

- Added `setup:computer` as a thin wrapper around Peekaboo's built-in `permissions grant` workflow and made normal `setup` show `permissions status --all-sources` when Peekaboo is installed; missing optional Computer Use dependencies do not block core setup.

## [2026-08-14] setup | Add guided terminal setup UI

- Wrapped `npm run setup` in a zero-dependency terminal UI with prerequisite, workspace, build, Computer Use, and multi-agent Chrome steps while preserving the existing setup helpers as the source of behavior.

## [2026-08-14] release | Restore gitleaks false-positive allowlist

- Restored the narrow `.gitleaks.toml` allowlist for the historical fake integration-test authentication token so full-history release scans remain clean without suppressing real secret findings.

## [2026-08-14] release | Fix public setup and wiki navigation

- Clarified that local execution means tool execution/runtime state and documented OpenAI's current full-MCP plan requirement for write-capable shell, patch, and Computer Use actions in `README.md`.
- Replaced Obsidian-style navigation in `wiki/index.md` with standard Markdown links so the tracked maintainer wiki is navigable on GitHub.

## [2026-08-14] release | Remove local build paths from vendored apply_patch

- Changed `scripts/build-apply-patch.sh` to build in a fresh temporary Cargo target with Rust path-prefix remapping and fail if the stripped binary still contains a macOS `/Users/<name>/` path.
- Rebuilt the vendored `apply_patch` from the same pinned OpenAI Codex commit and recorded the path-remapped build environment in provenance.

## [2026-08-14] docs | Rename README positioning

- Changed the README H1 to `Shellby MCP - Coding Harness for ChatGPT Web`.

## [2026-08-14] release | Correct ChatGPT plan requirement and gitleaks handling

- Updated `README.md` to state the observed requirement as ChatGPT Plus or higher with Developer Mode/custom MCP app access.
- Removed the restored `.gitleaks.toml`; the historical test value is intentionally fake and does not require a repository allowlist.

## [2026-08-14] release | Add focused GitHub contribution templates

- Added a structured bug report form for the current macOS/Node/ChatGPT setup surface and a concise pull request checklist without adding broader community-process boilerplate.

## [2026-08-14] test | Make named-shell concurrency integration deterministic

- Replaced a fixed 300 ms sleep in the named-shell busy/concurrency integration test with an explicit release-file signal so slower full-suite runs cannot let the command finish before the busy assertion.

## [2026-08-14] fix | Reconcile stale ChatGPT streaming tabs

- Added server `stream_status` reconciliation so a completed conversation is not left running when its original ChatGPT tab keeps a stale stop button after the final answer rendered; follow-up submission reloads that stale page before typing the next turn.

## [2026-08-14] docs | Make subagent completion notification a first-class contract

- Promoted autonomous turn-completion detection and `agent_finished:<agent_id>:<turn_id>` delivery on the next MCP tool response into a dedicated top-level contract in `pages/Browser ChatGPT Subagents.md`.
- Clarified that `subagent_result` is answer retrieval/reconciliation, not the only acceptable way to discover that a detached turn finished.

## [2026-08-14] harden | Restore autonomous subagent completion detection with server state

- Added a one-second detached completion watcher that checks both ChatGPT `stream_status` and the managed tab's generation control while keeping structured `page.on("response")` finals as the fastest path.
- Treats server `COMPLETE` as authoritative, waits up to five seconds for the final DOM message at one-second intervals, then reuses the existing one-shot conversation recovery path if the page still has not rendered the answer.
- Moved `agent_finished` queueing into the guarded `completeTurn()` transition so network, watcher, and explicit reconciliation paths cannot emit duplicate completion events.
- Added best-effort first-turn stable-URL binding from `subagent_start` so the completion watcher consumes conversation identity instead of owning its discovery.

## [2026-08-14] docs | Rewrite Browser ChatGPT Subagents as an end-to-end maintainer guide

- Rewrote `pages/Browser ChatGPT Subagents.md` around the core autonomous-completion/notification contract, with a complete start-to-notification-to-result lifecycle.
- Documented first-turn URL ownership, prompt submission safety, network/server/UI completion authority, the five-second DOM grace window, single-gate `completeTurn()` semantics, event injection, result reconciliation, one-shot recovery, capacity, cleanup, and historical failure modes.
- Added explicit maintainer invariants and an updated code map so future changes preserve notification reliability instead of treating `subagent_result` polling as the primary lifecycle mechanism.

## [2026-08-14] repair | Align Computer Use wrappers with Peekaboo v4

- Replaced removed Peekaboo CLI forms used by screen listing, coordinate click/drag, hotkeys, app launch, and AX inspection; made pointer scrolling explicitly foreground and retained screen indexes for snapshot-target reuse.
- Updated focused MCP integration coverage and Computer Use architecture/tool-surface documentation.

## [2026-08-14] portability | Add Intel Mac support

- Expanded the current macOS release target from arm64-only to arm64 and x64, with a Universal 2 vendored `apply_patch` binary and matching package/preflight/documentation support.
- Changed GitHub CI to validate the full suite on both macOS arm64 and Intel x64 runners, including direct execution of the vendored patch binary.

## [2026-08-15] docs | Clarify dual-architecture macOS support

- Updated public and maintainer documentation to state that arm64 and Intel x64 both run the full CI suite and to document the Universal 2 `apply_patch` build/verification flow.

## [2026-08-15] test | Remove shell background timing race

- Replaced a fixed sleep in the redirected background-output shell test with a bounded readiness check so CI validates the behavior without depending on runner scheduling speed.

## [2026-08-15] wiki maintenance | Restore source manifest scope

- Removed the duplicated implementation-evidence inventory and stale commit tripwire from `raw/source-manifest.md`.
- Kept the manifest focused on supporting sources, their reliability, downstream pages, and known conflicts.

## [2026-08-15] tool output | Render record results as Markdown instead of JSON

- Changed compact tool-output rendering so ordinary nested records and record arrays recurse into readable Markdown-style blocks instead of becoming minified JSON when one field is long or multiline.
- Added exact compact-output fixtures for every registered non-Computer tool family and an MCP integration regression covering multiple multiline subagent answers with Markdown/code.

## [2026-08-15] subagent output | Emphasize completion notifications

- Kept internal queued completion events compact, but render them in model-facing tool output as `**agent_finished:** agent_id=<agent_id> turn_id=<turn_id>` so asynchronous completions are easy to notice and directly actionable with `subagent_result`.
- Preserved one-shot delivery and locked the exact rendered event shape in MCP integration coverage.

## [2026-08-15] tools | Align subagent execution with shell_run

- Renamed the public `subagent_start` tool to `subagent_run` so first and follow-up turns share the same persistent-resource mental model as `shell_run`.
- Mirrored the shell tool's ID language: `agent_id` retains conversation context, while returned `turn_id` values identify exact submitted operations for `subagent_result`; integration tests lock the routing and ID descriptions.

## [2026-08-15] wiki maintenance | Reconcile vault structure and repository coverage

- Added `pages/Project Overview.md`, made it the first index entry, indexed roadmap and active-plan pages, restored the required maintainer workflows, refreshed the page template, and added a maintained-page wikilink graph.
- Removed deleted feedback and obsolete schema-order references, removed the resolved no-CI risk, and reconciled failed-patch audit retention across architecture, transport, testing, risk, workspace, and secret-handling documentation.
- Documented first-time workspace instruction creation, normal PM2/browser restart scope, health-check diagnosis, exceptional daemon recovery, and current citation paths while preserving the active tool-output work.

## [2026-08-15] test | Add manual live subagent compatibility canary

- Added `npm run test:live:subagent` backed by `test/live/subagent-live.test.ts`, kept outside the normal test glob and explicitly disabled in CI.
- The live canary consumes one real persistent subagent across two sequential turns and checks server/network response authority, raw conversation `content.parts`, rendered DOM evidence, compact MCP output, exactly-once completion events, turn numbering, and conversation-context reuse.
- Last-run evidence is sanitized into ignored `test/live/artifacts/` so real-browser observations can be inspected without committing authenticated conversation payloads.

## [2026-08-15] subagents | Make network response authoritative after completion detection

- Separated completion detection from answer extraction: passive network conversation content now always wins over rendered DOM text, with one one-second passive retry followed by an authenticated active fetch of `/backend-api/conversation/<conversation_id>` before DOM fallback.
- Added regressions proving fenced Markdown survives server `content.parts` extraction exactly, that a delayed passive network answer beats mangled rendered DOM text, and that the active conversation fetch wins when the passive tracker misses both reads.

## [2026-08-15] test | Add permanent read-only ChatGPT compatibility fixture

- Added a sanitized frozen copy of the existing `Live Fixture Response` conversation and normal parser coverage for its exact Markdown/code response shape.
- Added `npm run test:live:fixture`, a manual non-generative compatibility test that opens that permanent conversation in a temporary Chrome CDP target, captures the real conversation JSON response, compares it with the frozen fixture, validates `content.parts`, inspects rendered DOM structure, and closes only the temporary tab.
- Kept the expensive generated-turn lifecycle canary separate as `npm run test:live:subagent`; neither live test is part of normal CI.

## [2026-08-15] subagents | Bound active conversation recovery fetches

- Added a 10-second timeout to the authenticated active `/backend-api/conversation/<conversation_id>` fetch used after passive completion-response capture misses.
- Added regression coverage proving a stalled active fetch aborts and returns control so completion can continue to the final DOM recovery path instead of hanging indefinitely.

## [2026-08-15] test | Treat DOM fallback as semantic text

- Kept server/network response assertions strict about exact Markdown source while changing DOM-fallback coverage to assert preserved fixture words and meaning instead of Markdown markers that disappear when ChatGPT renders headings, lists, code, and tables as HTML.

## [2026-08-15] subagents | Replace direct recovery fetch with reload capture

- Replaced the direct page-context conversation fetch, which ChatGPT returned as `conversation_inaccessible`, with the already-proven reload-and-capture path that observes ChatGPT's own successful `/backend-api/conversation/<conversation_id>` request.
- Kept the recovery window at 10 seconds, bounded both the response wait and reload, and preserved rendered DOM text as the final fallback only after passive network capture and reload-based server recovery miss.
- Updated regressions so a mangled DOM answer loses to the exact fenced Markdown returned by the reload-captured conversation payload.

## [2026-08-15] subagents | Keep normal generation passive until proven complete

- Removed the completion path that treated unknown stream status plus non-generating-looking DOM text as a finished turn; unknown state now waits for the next one-second poll and never triggers reload recovery by itself.
- Tightened tracked final-answer detection to require `end_turn: true`, preventing completed intermediate reasoning/`Thinking` nodes from being mistaken for the final assistant answer.
- Bound conversation-wide `COMPLETE` to current-turn progress: a follow-up must first be observed streaming, or visibly generating and later stopped, before server `COMPLETE` may trigger recovery. This prevents the previous turn's stale `COMPLETE` from completing a new turn as `Thinking`.
- Removed deliberate conversation reloads from the two-turn generative live canary so it now exercises the same persistent-tab lifecycle as ordinary `subagent_run`; deliberate reload/recovery validation remains in the permanent read-only fixture.

## [2026-08-15] subagents | Remove stale inter-turn reload

- Removed the remaining normal-path reload before follow-up submission: if the prior turn is server-complete but ChatGPT still renders a stale generating control, `subagent_run` now continues on the same managed page instead of refreshing it.
- Added a regression proving stale prior-turn `COMPLETE` plus stale generating UI causes zero reloads before the next turn; full deterministic validation now passes 176 tests plus type-check, lint, and diff-check.
- This supersedes the 2026-08-14 stale-UI note that prescribed reloading before a follow-up; reload remains recovery-only after current-turn completion is positively established.

## [2026-08-15] subagents | Make live canary black-box and stop reloading managed tabs

- Reworked `test:live:subagent` to start the normal MCP server and interact only through public `subagent_run` / `subagent_result`; it no longer inspects module maps, tracker state, DOM, Page identity, or conversation IDs.
- Replaced managed-page reload recovery with a temporary read-only ChatGPT recovery page that captures `/backend-api/conversation/<id>` and closes immediately, preserving the persistent agent tab across submission, polling, recovery, and follow-up turns.
- Production source now contains no `page.reload()` call. Deliberate reload testing remains isolated to the disposable saved-fixture compatibility test.

## [2026-08-15] subagents | Simplify answer recovery around passive network authority

- Removed active conversation-payload recovery from production, including the temporary recovery page introduced during live-test hardening.
- Kept passive structured network capture as the authoritative answer source, including one one-second retry so exact Markdown/code fences win whenever the final network node arrives slightly late.
- After current-turn completion is positively established, fall back directly to rendered DOM only when both passive network reads miss; production no longer reloads, navigates, or opens another page merely to recover answer formatting.
- Kept the generative live canary black-box over the public MCP surface; the separate disposable saved-fixture test remains the place that directly validates ChatGPT conversation JSON and reload compatibility.

## [2026-08-15] subagents | Restore network-first completion polling

- Restored the original response-waiting semantics at a 1,000 ms cadence: every completion tick checks the passive network tracker before server/UI/DOM state instead of depending on repeated `page.on("response")` events from a streaming response.
- Kept the newer current-turn protections: unknown state and `IS_STREAMING` continue polling, and conversation-wide `COMPLETE` is ignored until this turn has its own generation evidence.
- When the current turn is positively complete but the expected final network node never appeared, one recovery reload captures `/backend-api/conversation/<conversation_id>` and resolves the exact server `content.parts` response before DOM fallback.
- Removed the temporary pending-`response.text()` bookkeeping; the listener remains an opportunistic fast path, while the 1-second loop and canonical reload are the reliable completion path.

## [2026-08-15] subagents | Keep one catastrophic browser recovery

- Preserved a single destructive recovery attempt for genuine browser/page observation failures only; ordinary passive-network misses never trigger it.
- If the managed conversation page is still valid, catastrophic recovery reloads it once. If that page is closed or lost, the existing saved-conversation recovery opens a replacement page once instead.
- Reattaches the passive tracker after recovery so an exact network final still wins over DOM; the submitted prompt is never retried.
- Added regressions proving ordinary DOM fallback does not arm recovery while catastrophic recovery performs one reload and prefers recovered network output.

## [2026-08-15] wiki maintenance | Reconcile final subagent polling and live-test contract

- Updated `pages/Browser ChatGPT Subagents.md` to match the final network-first 1,000 ms polling behavior: passive `page.on("response")` is a fast path, current-turn completion requires generation evidence, one shared recovery may reload/open the saved conversation once to capture canonical JSON, and DOM is the final answer fallback.
- Clarified that normal follow-up submission does not reload, prompts are never resubmitted, and the old 250 ms loop contributed the network-first polling principle rather than a required polling frequency.
- Updated `pages/Build and Test.md` to separate the two live-test responsibilities: the permanent saved-conversation fixture owns strict network/Markdown/reload compatibility, while the generative canary only proves public-MCP startup, Turn 1, Turn 2, and cross-turn context reuse, with diagnostics and a five-minute process hard cap.
- Current deterministic validation before this documentation pass was 177/177 non-live tests plus type-check, lint, and diff-check; the simplified two-turn live canary also passed once against real ChatGPT.

## [2026-08-16] shells | Add LRU live-shell hibernation and cached restoration

- Capped the live shell working set at 16 including protected `default`, added LRU pressure eviction for non-busy named shells, and kept creation blocked when every eligible slot is busy or protected.
- Reduced normal named-shell idle lifetime to five minutes and retained only cwd plus exported environment for 24 hours since last use; cached IDs transparently recreate fresh shell processes when reused.
- Kept automatic idle/LRU hibernation responsible for caching cwd/exported environment, while `shell_close` is deliberately destructive and discards both live and cached state; `shell_reset` also starts clean.
- Added shared cache sweeping without one timer per cached shell, public cache-TTL configuration/schema reporting, focused lifecycle/failure tests, and MCP integration coverage for close-and-restore behavior.
- Final validation passed 191/191 deterministic tests, TypeScript checking, ESLint, production build, and `git diff --check`.

## [2026-08-16] audit log | Remove response-size logging

- Removed response-byte counting, B/KB header suffixes, the 8 KiB large-response threshold, and the `?` Better Comments tag from MCP audit logging; `in / out` token counts remain the output-volume signal.
- Kept bounded response-body capture only for deriving model-facing output token counts. If the body exceeds the capture ceiling, the audit entry simply omits the output-token count instead of parsing a partial response.
- Retained `~` for calls lasting at least five seconds and `!` for tool/HTTP/connection failures.

## [2026-08-16] subagents | Allow longer result waits

- Raised `subagent_result.wait_ms` from a 60-second maximum to 270 seconds (4.5 minutes) so callers can wait through longer subagent runs without issuing a result request every minute.
- Kept the subagent lifecycle timeout unchanged; this only changes how long one result-retrieval call may wait.

## [2026-08-16] shells | Keep lifecycle details out of tool language

- Restored the shell tools' caller-facing descriptions so they explain how to use shell IDs, reset, list, and close without exposing cache/hibernation implementation details.
- Removed `cache_ttl_ms` from the public `shell_list` result; cached state behavior remains unchanged internally.

## [2026-08-18] shells | Simplify batch cwd inheritance

- Made bare `*** Run:` inherit the batch cwd, matching normal persistent-shell cwd behavior; relative and absolute directory overrides remain supported.
- Reworked `shell_run` and `shell_poll` descriptions around how to use the tools, including cwd inheritance, stateful shell reuse, polling, and output continuation.
- Updated focused tests and shell documentation for the simpler batch grammar.
- Exposed compact per-command status and exit codes in batch `shell_run` and `shell_poll` results; inherited cwd is omitted while explicit directory overrides remain visible.

## [2026-08-18] wiki | Centralize apply_patch tool semantics

- Established `tools/` for canonical per-tool references and added `tools/apply_patch.md` covering grammar, native execution order, update atomicity, partial failures, changed/failed reporting, parser quirks, runtime limits, audit behavior, provenance, and tests.
- Replaced duplicated `apply_patch` detail in maintained workspace/test/risk/tool-surface pages with focused links to the tool reference.
- Corrected stale test notes: real-binary MCP integration now covers partial application, failed-hunk reporting, and move+edit alongside fake-executable cap/abort tests.

## [2026-08-18] wiki | Canonicalize shell tool docs

- Added `tools/shell_run.md` as the compact canonical caller contract for `shell_run`/`shell_poll`: persistent state, batches, per-command results, polling, output loss, limits, and shell lifetime.
- Removed duplicated caller-facing shell syntax/result detail from `Persistent Shell Runtime` and `MCP Tool Surface`; those pages now retain implementation/inventory context and link to the tool page.

## [2026-08-18] wiki | Normalize vault structure and links

- Moved canonical tool references from `tools/` to `pages/tools/` and moved `ops/Secret Handling.md` into `pages/Secret Handling.md`, leaving maintained synthesis under `pages/`.
- Converted Obsidian wikilinks throughout the vault to standard relative Markdown links and updated the maintainer schema/template to require that style.
- Removed the completed `Tool Output Markdown Build Plan`; its implemented output-mode behavior and validation already live in `pages/MCP Tool Surface.md` and `pages/Build and Test.md`.
- Reduced repeated shell, patch, skill, and browser-subagent contract detail so inventory pages route to canonical subsystem/tool pages instead of restating them.

## [2026-08-18] wiki | Apply duplication audit

- Replaced the template's fake `Related Page` destination with instructional text and strengthened `AGENTS.md` around tiny cohesive pages, one natural home per fact, and links over repetition.
- Added `pages/Audit Logging.md` as the canonical home for `agent-commands.yaml` retention, truncation, token accounting, status markers, and sensitivity; transport, configuration, risk, secret, and patch pages now keep only topic-specific consequences.
- Shortened `Project Overview.md` to orientation and `Architecture Map.md` to component boundaries plus a coarse request lifecycle, routing subsystem details to dedicated pages.
- Split browser delegation into `pages/tools/subagent.md` for the caller contract, `pages/Browser ChatGPT Subagents.md` for browser ownership/orchestration, and `pages/Subagent Completion and Recovery.md` for completion authority, events, reconciliation, and recovery.
- Kept shell configuration values in `Configuration and Startup`, caller consequences in `pages/tools/shell_run.md`, and implementation mechanics in `Persistent Shell Runtime.md`; removed repeated numeric limits from risk/runtime summaries.

## [2026-08-18] shells | Remove reset request IDs

- Removed `request_id` from `shell_reset` input/output and deleted reset-specific retry records/deduplication from the shell runtime.
- Kept optional `reason`, default `shell_id`, destructive reset behavior, and concurrent-reset rejection; reset is now explicitly non-idempotent.
- Updated shell schema, compact-output, runtime, integration, and maintainer documentation coverage.

## [2026-08-18] shells | Allow long shell polls

- Kept `shell_run.wait_ms` capped at 10 seconds while raising only `shell_poll.wait_ms` to 270 seconds for deliberate long-polling of slow commands.
- Added separate poll wait defaults and limits in `config.ts`; the published schemas consume those values directly.

## [2026-08-18] shells | Remove wait normalization

- Removed the shell runtime's duplicate `wait_ms` defaulting, integer coercion, and max clamping.
- Made `waitMs` required for internal run/poll calls so validated MCP arguments flow directly from the tool schema into the session runtime.

## [2026-08-18] tools | Make Zod the tool input boundary

- Removed duplicate MCP-input defaulting, normalization, clamping, and shape validation from shell, subagent, web, skill, and Computer Use runtime paths; internal services now consume required typed values produced by their Zod schemas.
- Moved shell input contracts into `src/tools/shell/shell-contracts.ts` and infer the session input types directly from those Zod schemas, eliminating the parallel hand-written run/poll/reset interfaces and field-name translation layer.
- Centralized shell, subagent, and webpage caller defaults/limits in `config.ts`; schema tests compare published defaults and limits to `MCP_CONFIG` rather than duplicating policy literals.
- Kept runtime validation only for facts discovered after parsing, including cwd/filesystem state, retained cursor semantics, browser/process state, webpage redirects, decoded cursors, and external tool responses.
- Added MCP integration coverage proving malformed shell, subagent, webpage, and skill inputs fail at the schema boundary before runtime work.
- Restored raw internal subagent completion events so model-facing event formatting remains owned by the shared output boundary, and removed stale exact-prose assertions from integration coverage.

## [2026-08-20] research | Document live ChatGPT CDP transport and rate-limit behavior

- Added `pages/ChatGPT CDP Transport.md` from one live authenticated CDP probe, documenting the HTTP-to-WebSocket generation handoff, exact assistant deltas, explicit WebSocket completion events, raw CDP streaming coverage, and working DOM MutationObserver signals.
- Recorded that the sampled `stream_status` requests stayed HTTP 200 while a post-completion recovery reload triggered `/backend-api/conversations` HTTP 429 responses and the conversation-history rate-limit modal.
- Kept the observed upstream behavior separate from the current production completion contract and documented WebSocket-driven completion as an implementation direction rather than an implemented change.
- Added index/backlinks and a sanitized source-manifest entry; no captured authentication tokens, conversation IDs, topic IDs, or account identifiers were retained in the wiki.

## [2026-08-20] subagents | Replace completion polling with event-driven response observation

- Replaced the Playwright-response plus one-second `stream_status` completion loop with one contained response observer: raw CDP WebSocket turn-topic parsing is primary and a page `MutationObserver` is the only normal secondary path.
- Bound WebSocket topics through the exact submitted prompt, reconstructed inherited v1 assistant delta patches, required a final assistant node plus an explicit completion signal, and retained short submission/response settle graces for both first and follow-up turns.
- Made `subagent_result` wait only on shared in-process turn settlement, retained the existing 30-minute no-progress cutoff, and removed normal completion refreshes and application-level `stream_status` requests.
- Reduced catastrophic recovery to one fresh-tab navigation to the saved conversation, preferring canonical conversation JSON captured during that navigation and never resubmitting the prompt.
- A live two-turn canary completed both new-agent and follow-up turns before disposal cleanup was tightened; a later Turn 1 also completed with the new path, while Turn 2 was correctly blocked after ChatGPT's own frontend history request hit HTTP 429. Passive CDP initiator evidence attributed the remaining `stream_status` and history calls to ChatGPT's frontend bundle rather than Shellby MCP.

## [2026-08-22] subagents | Make ChatGPT project routing optional

- Removed the repository-specific default ChatGPT Project URL. Unset or blank `MCP_CHATGPT_PROJECT_URL` now remains unconfigured, and the subagent runtime starts new conversations from normal `https://chatgpt.com/`.
- Kept explicit project URLs supported and updated configuration tests, the live project-fixture guard, `.env.example`, README, and startup documentation.

## [2026-08-22] configuration | Collapse runtime configuration to one object

- Replaced the defaults-plus-loader pipeline with one process-wide `MCP_CONFIG` object and removed numeric environment parsing and its standalone config test.
- Made shell output, capacity, hibernation, cache, and structured-output policy fixed source configuration while retaining environment inputs for machine paths and integrations.
- Updated `.env.example`, README, tool-surface, build/test, and startup documentation to match the reduced environment surface and production compact-output mode.

## [2026-08-22] subagents | Repair the live saved-conversation contract

- Updated catastrophic recovery for ChatGPT's current `/backend-api/conversations/<id>` response and flat `messages` payload instead of silently missing the obsolete singular endpoint.
- Reworked `test:live:fixture` to reuse the production background-page and navigation/capture helpers, then validate live payload parsing, exact source Markdown, conversation routing, and rendered DOM without generating a turn.
- Removed exact saved-conversation title coupling because titles are mutable and unused by production; retained exact conversation branch and fixture-content assertions.
- Made the fixture script load an optional repository `.env`; the project fixture is gated only by `MCP_CHATGPT_PROJECT_URL` and skips when it is unset.

## [2026-08-22] docs | Lint the wiki and streamline the public README

- Audited all 21 maintained wiki pages for required sections, index coverage, relative links, repository citations, Obsidian links, and committed private identifiers; the structural checks passed.
- Corrected stale subagent class/state names, background-page and observer ownership, recovery-history wording, and the completed functional-runtime roadmap item across the architecture, browser, testing, recovery, risk, and roadmap pages.
- Replaced the oversized root README with a public GitHub landing page using alerts, collapsible operational details, a Mermaid flow, focused setup/security guidance, and links into the maintainer wiki.

## [2026-08-23] subagents | Replace recovery state machine with one CDP turn path

- Rebuilt browser-backed subagents around one persistent ChatGPT page per `agent_id`: new agents start from the configured project URL, follow-up turns reuse the same page, and the existing interaction/inter-turn delays, submission grace, three-generation cap, and rate-limit cooldown remain.
- Made raw CDP turn data the sole normal completion authority: current project sessions complete from `/backend-api/f/conversation` SSE while other observed sessions can complete from `conversation-turn-*` WebSocket frames. Both feed one exact-prompt v1 tracker; removed DOM completion, URL binding, conversation-history recovery, saved-conversation state, idle reclamation, and catastrophic recovery.
- Removed the retired read-only saved-conversation live fixture and its package script; the two-turn public MCP live canary is now the single real-service compatibility test.
- Replaced recovery-heavy deterministic tests with focused project-start, same-page multi-turn, CDP protocol, pacing, capacity, and rate-limit coverage. Public subagent tool descriptions and the injected mini-prompt were not changed.

## [2026-08-23] subagents | Restore bounded conversation recovery

- Restored the 30-minute no-progress cutoff and one post-submit catastrophic recovery attempt without reintroducing prompt resubmission or DOM completion.
- Bound agents to one saved conversation URL, restore mismatched or closed managed pages before follow-up submission, and close only the background page after 30 idle minutes while retaining agent context.
- Restored the exact prior first-turn oververbosity prompt mapping and added deterministic coverage for URL restoration, idle reopening, timeout failure, one-shot history recovery, and the no-second-recovery boundary.

## [2026-08-23] shell | Redirect shell apply_patch mistakes to the native tool

- Added one output-level hint when normal, batch, or polled shell output reports `command not found: apply_patch`, preserving the shell's original output and exit status.
- Added integration coverage for normal and batch execution and documented the caller-visible behavior in `pages/tools/shell_run.md`.

## [2026-08-23] web | Harden fetch response and render semantics

- Made successful HTTP 204 and 205 navigations return normal empty `fetch_website` results instead of surfacing Chromium's `ERR_ABORTED` navigation behavior.
- Added final HTTP `status` and optional `content_type` metadata to fetched documents and preserved it across cursor reads.
- Replaced the fixed one-second render delay with a bounded DOM-settle window that waits at least two seconds, extends while mutations continue, and caps at five seconds.
- Stripped terminal control sequences from browser error messages before returning them to MCP clients.
- Added deterministic browser integration coverage for empty success responses, HTTP metadata, and client rendering delayed beyond one second.
