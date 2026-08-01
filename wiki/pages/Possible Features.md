# Possible Features

This page collects plausible additions for Unhinged Terminal MCP. These are ideas, not commitments. The core should remain a small, direct MCP surface for high-fidelity access to the local machine.

## Agent Usability

- Optional server-generated `request_id` values while preserving retry safety.
- A compact command-history tool for finding recent request IDs, statuses, and working directories.
- Explicit command timeouts and cancellation without resetting the entire shell.
- Optional working-directory input on `shell_run` for isolated one-off commands.

## Output and Context Efficiency

- Configurable response presets such as compact, normal, and verbose.
- Optional plain-output mode for programs that emit unnecessary terminal formatting.
- Better summaries for test, build, Git, JSON, and log output through RTK integrations.
- Output-to-file helpers for commands expected to produce large artifacts.
- Small telemetry counters for bytes returned, bytes retained, and estimated context saved.

## File and Artifact Workflows

- First-class file download and upload helpers for MCP clients that support file references.
- A bounded file-read tool for binary detection, line ranges, and UTF-8-safe reads.
- Native helpers for creating archives and returning generated artifacts.
- Patch previews and optional dry-run validation before applying source changes.

## Process Management

- List processes started through the MCP server.
- Start, inspect, and stop named background processes without parsing shell job output.
- Health checks for local development servers.
- Bounded log streaming for named processes.

## Delegation

- A lightweight `summon_agent` capability that launches an installed non-interactive AI agent, gives it a prompt and working directory, and returns its final response. This should remain a small delegation primitive rather than becoming a full orchestration framework.
- A narrow Codex MCP or app-server adapter for persistent thread start/resume, streamed turns, interruption, reviews, and model inspection without exposing the complete protocol.

## Optional Local Capability Adapters

- A generic child-MCP bridge with executable discovery, schema allowlists, bounded output, lifecycle management, and explicit read/write annotations.
- ChatGPT Computer Use read-state tools, with click/type/keypress/value actions separately gated.
- Messages search/read tools, with `send_message` isolated as an explicit external side effect.
- Record & Replay and Computer History only after visible recording state, short retention, pause, and deletion behavior are designed.
- `sandbox_run` backed by `codex sandbox` and explicit permission profiles.
- Craft document operations, Playwright browser capture, Pixelmatch visual diffs, local OCR/PDF extraction, and Tectonic PDF compilation.
- LM Studio model management, Screen Studio media utilities, Screaming Frog crawling, and VS Code indexed repository search.
- macOS Shortcuts, Spotlight, Safari WebDriver, screenshots, conversion tools, and narrowly scoped Swift framework adapters.

See [[pages/Bundled MCP and Agent Surfaces]] and [[pages/Host Application Binary Reuse]].

## Portability and Setup

- Linux support with the same shell and output guarantees.
- Automated installation and upgrade scripts.
- Optional macOS `launchd` setup for automatic startup and a one-command build-and-restart flow. ngrok would remain a separate process forwarding the fixed endpoint to the restarted local server.
- Runtime discovery of supported local agent and developer CLIs.
- Runtime discovery and compatibility checks for bundled child MCP servers and protocol versions.
- A diagnostic command that checks authentication, executable paths, tunnel configuration, and MCP connectivity.
- Example configurations for ChatGPT, Claude, Cursor, and other MCP clients.

## Security Options

Unrestricted access is intentional, but optional deployment controls could make accidental exposure less likely without changing the default identity of the project.

- Bearer-token authentication for remote tunnels.
- Clear startup warnings when binding beyond localhost.
- Optional IP or Host allowlists.
- Disposable-user and isolated-machine setup guidance.
- An audit log mode that records commands without recording command output.

## Design Filter

A feature should generally be rejected when it:

- Duplicates reliable shell functionality without materially improving agent usability.
- Adds a large permanent MCP schema for a narrow workflow.
- Summarizes or transforms output in a way that can reduce accuracy.
- Turns the repository into a general agent framework instead of an unrestricted machine-access primitive.
