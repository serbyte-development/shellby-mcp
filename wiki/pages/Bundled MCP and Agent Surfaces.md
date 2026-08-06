# Bundled MCP and Agent Surfaces

Verified 2026-08-05.

## What This Is

This is a short historical note about structured capabilities discovered in the installed ChatGPT/Codex application. None of those child MCP or app-server surfaces participate in the current runtime.

## Current Decision

- Computer Use calls the supported installed Peekaboo CLI directly through eleven focused tools (`src/peekaboo.ts`, `src/computer-use-tools.ts`, `src/mcp-server.ts`).
- File patching reuses the ChatGPT-bundled Codex binary only through the prepared `apply_patch` executable (`src/workspace-tools.ts`, `src/mcp-server.ts`).
- Agents may call an independently installed Codex CLI through `shell_run`, but the server does not expose a first-class Codex delegation tool.
- The server does not launch ChatGPT's bundled Computer Use, Messages, event-stream, computer-history, Codex MCP, or Codex app-server processes.

The repository is considered feature-complete. These surfaces should be reconsidered only after an explicit scope change, not because they happen to exist on the maintainer workstation.

## Evidence

The point-in-time commands, paths, schemas, and capability inventory are preserved in [[raw/ChatGPT and Local Capability Survey 2026-08-01]]. Application updates may invalidate those details without affecting this server.

## Related

- [[pages/Host Application Binary Reuse]]
- [[pages/MCP Tool Surface]]
- [[pages/Open Questions and Risks]]
- [[raw/ChatGPT and Local Capability Survey 2026-08-01]]
