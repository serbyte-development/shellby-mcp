# Roadmap

Verified 2026-08-15.

## What This Is

This page records uncommitted experiments and deferred architectural work; none of these items is approved or implemented merely because it appears here.

## Future experiments

- [ ] Broaden host portability beyond the current macOS release without weakening the local-agent model or adding platform abstractions before they are needed.
- [ ] Revisit MCP `2026-07-28` and the current `io.modelcontextprotocol/tasks` extension only if they solve a concrete problem or materially simplify Unhinged Agent. A self-contained manual compatibility probe is preserved at `experiments/mcp-2026-tasks-probe/`; do not wire it into the production `/mcp` server unless this roadmap item is intentionally resumed.
- [ ] Refactor the subagent runtime toward the codebase's functional style. `ChatGptSubagentModule` is currently a class used mainly as a mutable state container with private lifecycle helpers, without inheritance or meaningful OO polymorphism. Prefer a functional factory/closure design with explicit state and functions when this area is next substantially changed. This is an architectural consistency cleanup, not a mandate to remove every class in the repository.
- [ ] Consider adding `CTRL_C` support to `shell_run` so an agent can interrupt a stuck foreground command without resetting the persistent shell and losing cwd/environment state. The current non-interactive shell has no terminal job-control foreground process group, so a safe implementation would need to signal only the process tree created by the active command rather than the shell's whole process group; true terminal-equivalent Ctrl+C semantics would require a larger PTY/job-control redesign.

## Related

- [Project Overview](./Project%20Overview.md)
- [Open Questions and Risks](./Open%20Questions%20and%20Risks.md)
- [iOS Shell](./iOS%20Shell.md)
- [Possible Evals](./Possible%20Evals.md)
- [Browser ChatGPT Subagents](./Browser%20ChatGPT%20Subagents.md)
