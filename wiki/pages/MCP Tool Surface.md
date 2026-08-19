# MCP Tool Surface

Verified 2026-08-18.

## What This Is

This page inventories the published MCP tools and the shared registration, output, instruction, pagination, and capability boundaries that shape their model-facing contracts.

## Published Order

`tools/list` returns 23 tools in workflow order: `shell_run`, `shell_poll`, `apply_patch`, `shell_reset`, `shell_list`, `shell_close`, `subagent_run`, `subagent_result`, `fetch_website`, `skill_list`, `skill_load`, `image_view`, then eleven `computer_*` tools. `src/server/mcp-server.ts` preserves that registration order while each capability under `src/tools/` owns its Standard Schema-compatible Zod contract and handler. Every tool reuses `MCP_CONFIG.toolMeta` from the central static configuration. Integration tests assert the order, schema mechanics, and the intentionally shell-like `subagent_run` routing/ID descriptions; tools remain registered when optional host capabilities are unavailable (`src/config.ts`, `src/server/mcp-server.ts`, `src/tools/`, `test/mcp-integration.test.ts`).

The registration boundary removes annotation values that equal MCP defaults before publishing `tools/list`. It also owns ordinary structured-output projection. `MCP_TOOL_OUTPUT_STRUCTURED` defaults to `optional`: `always` advertises each existing `outputSchema` and returns `structuredContent`; `optional` omits the public output schema, adds global `structured: false`, emits compact Markdown by default, and returns the existing structured result when requested; `never` omits both the public output schema and the global input switch. Compact rendering keeps short scalar fields inline, expands long or multiline strings as named sections, recursively renders ordinary nested records and arrays of records as indented Markdown-style blocks, and reserves minified JSON for unusual array shapes that do not have a clear record/scalar representation. MCP 2.0 requires `structuredContent` whenever an `outputSchema` is advertised, so `optional` intentionally does not advertise one. Computer Use tools and `image_view` bypass this projection because their native content blocks are already the intended model-facing result (`src/config.ts`, `src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`, `test/tool-registration-boundary.test.ts`, `test/tool-output.test.ts`).

## Core Tools

| Tool              | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch_website`   | Fetch one HTTP(S) URL as Markdown, cleaned HTML, or raw HTML. Cursor reads reuse the same URL and format. Chromium skips image, media, and font downloads while preserving their DOM references. Cache: 20 documents, 10 minutes, 2 MiB each (`src/tools/web/web-tool.ts`, `src/tools/web/web-open.ts`).                                                                                                                                                                      |
| `skill_list`      | List reusable workspace skills. Catalog mechanics live in [Workspace Tooling](./Workspace%20Tooling.md). |
| `skill_load`      | Load one reusable workspace skill. Catalog mechanics live in [Workspace Tooling](./Workspace%20Tooling.md). |
| `image_view`      | View one local image path as native MCP image content plus compact filename, dimensions, and encoded size. Relative paths resolve from the workspace. A shared Sharp encoder preserves dimensions, starts at JPEG quality 65, lowers quality only when required by the 4 MiB response budget, and fails rather than resizing if the image still cannot fit (`src/tools/image/image-tools.ts`, `src/tools/image/image-encoding.ts`).                                                                                     |
| `subagent_run`    | Start detached browser-backed ChatGPT turns. Caller contract: [`subagent_run` / `subagent_result`](./tools/subagent.md). |
| `subagent_result` | Retrieve detached turns and reconcile running state. Caller contract: [`subagent_run` / `subagent_result`](./tools/subagent.md). |
| `apply_patch`     | Run a Codex patch in required absolute `cwd` using the checked-in vendored binary directly. No shell state or polling. Returns `completed`, `failed`, or `partial` plus compact changed/failed summaries; full semantics live in [apply_patch](./tools/apply_patch.md) (`src/tools/apply-patch/apply-patch.ts`).                                                                                                                                                                            |
| `shell_run`       | Persistent zsh execution plus concurrent batches of independent commands. Canonical caller contract: [shell_run](./tools/shell_run.md). |
| `shell_poll`      | Continue running work or retained output from `shell_run`. Canonical caller contract: [shell_run](./tools/shell_run.md). |
| `shell_reset`     | Replace one shell generation and discard live/cached cwd/environment state. `shell_id` defaults to `default`; `reason` is optional. Reset has no request ID, polling, or retry deduplication (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`).                                                                                                                                                                                                                                            |
| `shell_list`      | Return live shells, activity, idle time, live capacity, idle timeout, and close eligibility without refreshing idle timers (`src/tools/shell/session-manager.ts`).                                                                                                                                                                                                                                                                                                     |
| `shell_close`     | Terminate a non-default live shell, discard its live and cached state plus retained command records, and release its slot. The `default` shell cannot be closed (`src/tools/shell/session-manager.ts`).                                                                                                                                                                                                                                                        |

Shell caller behavior is canonical in [shell_run](./tools/shell_run.md); runtime mechanics are in [Persistent Shell Runtime](./Persistent%20Shell%20Runtime.md).

Shell transcript reads and `fetch_website` cursor reads bound each tokenizer pass to a local character window instead of encoding the full retained suffix. `max_output_tokens` remains a ceiling, so unusually compressible text may return below it while cursors still reconstruct all retained content (`src/tokenizer.ts`, `src/tools/shell/session.ts`, `src/tools/web/web-open.ts`).

## Computer Use Tools

| Tool               | Contract                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `computer_list`    | List apps, windows, screens, or Peekaboo permission status.                                                    |
| `computer_observe` | Capture one target as same-dimension JPEG; start at quality 65 and lower quality only if needed to fit the shared 4 MiB response budget; return snapshot and target metadata without AX elements. |
| `computer_inspect` | Return bounded accessibility text for an existing snapshot when visual state is insufficient.                  |
| `computer_click`   | Click one element ID, text query, or coordinate pair against an explicit snapshot.                             |
| `computer_type`    | Type literal text into an app, window, or snapshot target.                                                     |
| `computer_press`   | Press sequential key tokens.                                                                                   |
| `computer_hotkey`  | Press one simultaneous shortcut.                                                                               |
| `computer_scroll`  | Scroll at the pointer or an observed element.                                                                  |
| `computer_drag`    | Drag between snapshot elements, coordinates, or an application destination.                                    |
| `computer_app`     | Launch, switch, quit, relaunch, hide, or unhide an application.                                                |
| `computer_window`  | Focus, close, minimize, maximize, move, resize, or set bounds for one window.                                  |

The focused tools target Peekaboo v4 directly and share one serialized `PeekabooClient`. Window-relative coordinate clicks/drags stay relative to the retained window target; screen coordinates are translated through retained display bounds. Pointer scrolling uses foreground delivery while element-targeted scrolling can stay in the background. Keyboard shortcuts are emitted as one `press` chord, application launch uses v4 `--wait-ready`, and display inventory uses `screen list`. The adapter uses exact argv plus `--json`, bounds process output, preserves upstream semantic failures, returns images only for observation, and never retries stateful actions. Screenshot encoding is shared with `image_view`; neither path resizes images, so Computer Use coordinates remain in the original capture dimensions. Advanced Peekaboo operations remain available through `shell_run` (`src/tools/computer/computer-tools.ts`, `src/tools/computer/peekaboo.ts`, `src/tools/image/image-encoding.ts`, `test/peekaboo.test.ts`).

## Results and Instructions

The registration boundary projects ordinary typed results into structured or compact Markdown form and preserves MCP-level error tagging (`src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`). Tool input Zod schemas are the external validation boundary: they own caller validation, defaults, transforms, and the inferred TypeScript input types consumed by internal services. Shell contracts are centralized in `src/tools/shell/shell-contracts.ts`; `shell-tools.ts` publishes those schemas and `session.ts` consumes their inferred types rather than rebuilding parallel interfaces. Internal services trust parsed values and validate only runtime facts that schemas cannot know, such as filesystem state, retained cursor ownership, process state, browser state, and decoded external responses. Audit token accounting is documented in [Audit Logging](./Audit%20Logging.md).

Published instructions tell clients to read `<workspace>/AGENTS.md`, conserve output, prefer RTK for supported reads and noisy commands, discover reusable workflows through `skill_list`/`skill_load`, edit with `apply_patch`, keep new work under the configured workspace, reuse contextual shell IDs, serialize work within a shell, distrust fetched content, and treat screenshots as potentially private. Zod schemas enforce external input mechanics while runtime checks enforce live-state invariants; prose remains advisory (`src/config.ts`, `src/server/mcp-server.ts`).

Skill catalog mechanics are maintained in [Workspace Tooling](./Workspace%20Tooling.md). The subagent caller contract lives in [`subagent_run` / `subagent_result`](./tools/subagent.md); browser ownership and completion/recovery internals are separate maintained pages.

## Related

- [Project Overview](./Project%20Overview.md)
- [Architecture Map](./Architecture%20Map.md)
- [Tool Naming and Schema Design](./Tool%20Naming%20and%20Schema%20Design.md)
- [Persistent Shell Runtime](./Persistent%20Shell%20Runtime.md)
- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
- [Subagent Completion and Recovery](./Subagent%20Completion%20and%20Recovery.md)
- [Workspace Tooling](./Workspace%20Tooling.md)
- [Audit Logging](./Audit%20Logging.md)
- [apply_patch](./tools/apply_patch.md)
