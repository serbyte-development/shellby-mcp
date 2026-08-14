# Roadmap

Verified 2026-08-14

## Build order

- [x] Add global tool-output mode configuration at MCP registration.
  - Use `toolOutputStructured: "always" | "optional" | "never"`.
  - `always`: preserve current public `outputSchema` + `structuredContent`; do not add a `structured` input.
  - `optional`: add global `structured?: boolean` input, default `false`; compact `content` by default, full structured output only when requested.
  - `never`: do not advertise structured output or the `structured` input; return compact `content` only.
  - Put truly global tool input/output behavior in the registration wrapper rather than duplicating it across individual tools.

- [x] Add one shared compact `content` formatter at the MCP boundary while keeping existing structured results available for the configured modes.

- [x] Add global subagent completion events.
  - Passive `page?.on("response")` observation should recognize definitive subagent completion.
  - Mark the turn completed and release its generation slot when completion is definitively observed.
  - Enqueue `agent_finished:<agent_id>:<turn_id>` and append pending events to the next model-facing tool `content` through the global registration wrapper.
  - Do not inject the subagent response itself; the subagent result tool is the only path that returns the actual response to the parent.
  - Rename `subagent_poll` to `subagent_result` so the tool name reflects response retrieval rather than repeated polling; it may still return `running` when checked before completion.

- [x] Standardize MCP tool `in / out` token logging after final response transformation.
  - `in` = serialized tool arguments actually sent through the MCP tool call.
  - `out` = actual model-facing tool output after compact/structured selection and pending-event injection.
  - Treat these as MCP I/O token metrics, not exact model inference-token usage.
  - Keep this simple. If reliable accounting for `subagent_start`, `subagent_result`, or any other tool requires special-case complexity, omit token logging for that tool rather than complicating the architecture.

- [ ] Break `src/tools/subagent/chatgpt-subagent.ts` into smaller smart abstractions after the behavior above is stable.
