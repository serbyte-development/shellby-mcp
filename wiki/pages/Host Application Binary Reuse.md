# Host Application Binary Reuse

Verified 2026-08-01.

## What This Is

This page defines how maintainers should evaluate and expose useful command-line capabilities bundled inside installed macOS applications.

## Current Server Boundary

The server currently provisions only one app-bundle-derived executable: `prepareApplyPatch` creates or reuses `<workspace>/bin/apply_patch`, normally targeting `/Applications/ChatGPT.app/Contents/Resources/codex`, and prepends the workspace bin directory to the persistent shell's `PATH` (`src/workspace-tools.ts`, `src/index.ts`, `src/shell-session.ts`).

The first-class MCP `apply_patch` tool executes that prepared binary through the shared shell and therefore shares its foreground-command lock, retained environment, logging, and bounded-output behavior (`src/mcp-server.ts`, `src/http-server.ts`, `src/shell-session.ts`).

All other binaries in this page are host integration candidates. They remain ordinary `shell_run` commands unless a future source module deliberately provisions and registers them.

## Four Reuse Patterns

1. **Supported application CLI:** invoke an interface intentionally shipped for terminal use. Examples include LM Studio's `lms`, Screaming Frog's launcher, Docker, VS Code, Cursor, and BBEdit's `bbdiff`.
2. **Bundled third-party utility:** invoke a generally reusable executable packaged to support the GUI, such as Screen Studio's FFmpeg and Whisper, VS Code's `tgrep` and Ripgrep, or ChatGPT's Tectonic compiler.
3. **Multicall binary:** invoke one executable through a special filename or hidden argument so it dispatches to another entrypoint. The current `apply_patch` symlink uses this pattern through the ChatGPT-bundled Codex binary.
4. **Extracted internal client:** build a small client from an application's internal libraries and existing authentication. The workstation's standalone `web_search` wrapper uses Codex Rust crates to call the internal `alpha/search` endpoint without a full `codex exec` turn. This is the most powerful and least stable pattern.

Detailed workstation evidence and exact bundle locations are recorded in [[raw/Host App Binary Survey 2026-07-20]] and [[raw/ChatGPT and Local Capability Survey 2026-08-01]]. Structured child MCP and Codex protocol surfaces are covered separately in [[pages/Bundled MCP and Agent Surfaces]].

## High-Value Candidates

| Priority | Candidate                   | Potential MCP capability                                                                                                     |
| -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1        | ChatGPT child MCP bridge    | Computer Use, Messages, Record & Replay, and Computer History through their advertised MCP schemas.                          |
| 2        | Codex sandbox               | A constrained `sandbox_run` primitive before adding more privileged execution tools.                                         |
| 3        | Codex app-server            | Persistent threads, turns, reviews, streaming, model inspection, and narrowly allowlisted agent control.                     |
| 4        | Craft Agents document tools | PDF, DOCX, XLSX, PPTX, image, iCal, Markdown conversion, and document diffing after recreating Craft's required environment. |
| 5        | LM Studio `lms`             | Download, load, unload, inspect, and serve local models.                                                                     |
| 6        | Playwright and Pixelmatch   | Browser rendering, screenshots, PDFs, traces, and visual-regression comparison.                                              |
| 7        | Screen Studio utilities     | Local transcription, denoising, media conversion, face detection, window inspection, and experimental mask tracking.         |
| 8        | Screaming Frog CLI          | Controlled headless SEO crawls and exports.                                                                                  |
| 9        | VS Code `tgrep`             | Persistent indexed search for repeated work on large repositories.                                                           |
| 10       | macOS-native CLIs           | Shortcuts, Spotlight, Safari WebDriver, screenshots, conversion, previews, and framework-backed Swift tools.                 |

## macOS-Native Alternatives

Prefer stable operating-system interfaces when they can replace private app internals:

- `shortcuts` for listing and running synced Shortcuts.
- `mdfind` and `mdls` for Spotlight content and metadata search.
- `safaridriver` for Safari WebDriver and WebDriver BiDi.
- `sips`, `textutil`, and `qlmanage` for image, text/document, and preview conversion.
- `screencapture` for screen, display, window, and recording workflows.
- Small Swift adapters around Vision, PDFKit, ScreenCaptureKit, Accessibility, Speech, NaturalLanguage, AVFoundation, CoreImage, and CoreGraphics.

These still require narrow schemas and privacy controls, but they are generally less fragile than reverse-engineered application helpers.

## Adapter Architecture

Future integrations should use three explicit adapter types:

1. **Child MCP bridge:** initialize an installed stdio MCP server, discover its schema, allowlist tools, forward calls, bound output, and terminate cleanly.
2. **CLI adapter:** discover an installed command, validate inputs, reconstruct required environment, invoke it, and normalize bounded results.
3. **Protocol client:** implement a narrow client for a structured non-MCP service such as Codex app-server or the internal web-search endpoint.

Do not copy binaries into the repository. Discover installed paths at runtime, record versions, and fail with a clear unavailable-capability result.

## Integration Rules

- Prefer supported CLIs over internal helpers when both can provide the capability.
- Treat app-bundle paths as discoverable dependencies, not permanent constants. Validate existence, architecture, executability, and `--help` behavior at startup or first use.
- Put environment reconstruction and argument validation in a dedicated source module rather than embedding long commands in MCP handlers.
- Keep wrappers narrow. Return bounded structured output and use existing shell serialization unless the tool has a strong reason to own a separate process lifecycle.
- Add integration tests around discovery, missing binaries, changed paths, malformed arguments, exit codes, and output caps before registering a first-class MCP tool.
- Never print stored authentication material. Reusing an authenticated local client does not remove the need for secret-safe logs and responses.
- Do not describe a bundled binary as a supported public interface unless the application documents it as one.
- Do not redistribute application binaries without independently confirming the license permits it.

## Risks / Open Questions

- Application updates can move, replace, or remove bundled executables while preserving the GUI application's normal behavior.
- Internal clients can break when endpoint paths, request schemas, caller restrictions, model requirements, or authentication storage change.
- Some helpers depend on a running GUI, XPC service, Electron environment, code-signing relationship, or app-injected variables.
- Exposing media, browser, crawler, or model-management binaries increases the MCP's already broad arbitrary-execution surface. Each first-class tool needs explicit input validation and bounded output.
- Decide whether future integrations belong in the core server, generated workspace tools, or a separate optional tool pack before adding several app-specific dependencies.

## Related

- [[pages/Workspace Tooling]]
- [[pages/Bundled MCP and Agent Surfaces]]
- [[pages/MCP Tool Surface]]
- [[pages/Persistent Shell Runtime]]
- [[pages/Open Questions and Risks]]
- [[raw/Host App Binary Survey 2026-07-20]]
- [[raw/ChatGPT and Local Capability Survey 2026-08-01]]
