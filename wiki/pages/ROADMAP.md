# Roadmap

Verified 2026-08-14

## Future experiments

- [ ] Broaden host portability beyond the current Apple Silicon macOS release without weakening the local-agent model or adding platform abstractions before they are needed.
- [ ] Revisit MCP `2026-07-28` and the current `io.modelcontextprotocol/tasks` extension only if they solve a concrete problem or materially simplify Unhinged Agent. A self-contained manual compatibility probe is preserved at `experiments/mcp-2026-tasks-probe/`; do not wire it into the production `/mcp` server unless this roadmap item is intentionally resumed.
- [ ] Refactor the subagent runtime toward the codebase's functional style. `ChatGptSubagentModule` is currently a class used mainly as a mutable state container with private lifecycle helpers, without inheritance or meaningful OO polymorphism. Prefer a functional factory/closure design with explicit state and functions when this area is next substantially changed. This is an architectural consistency cleanup, not a mandate to remove every class in the repository.
