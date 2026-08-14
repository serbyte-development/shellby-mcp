# Build Plan

## Goal

Simplify Shelly's model-facing MCP output, make structured output configurable, notify parent agents when delegated work finishes, and make MCP token cost easy to measure.

Keep implementation centralized and adaptable. Prefer simple shared boundaries over per-tool behavior.

## 1. Add global tool-output modes - [x]

- Add `toolOutputStructured: "always" | "optional" | "never"` to config.ts
- Implement mode behavior in the global tool-registration layer.
- Preserve current behavior in `always` mode.
- In `optional` mode, expose one global `structured:<boolean>` input and default to false
- In `never` mode, expose compact model-facing output only.
- Leave Computer Use tools unchanged for this pass.

## 2. Add compact model-facing output - [x]

- Keep existing typed tool results as the internal source of truth.
- Add one shared transformation from structured results to compact Markdown at the MCP boundary.
- Follow `wiki/pages/Tool Output Markdown Build Plan.md` for formatting direction, but improve on it if needed.
- Preserve only useful existing `content`, non-text blocks, and all meaningful result values.
- Prefer a generic transform; add tool-specific behavior only if testing proves it necessary.

## 3. Add subagent completion notifications - [x]

- Use passive ChatGPT `src/tools/subagent/chatgpt-subagent.ts#L191: page?.on("response")` observation to detect definitive subagent completion without adding background DOM polling.
- Complete the local turn and release its generation slot when completion is known.
- Queue `agent_finished:<agent_id>:<turn_id>` events.
- Append pending events to the next model-facing tool response through the same global response boundary.
- Keep the actual subagent answer behind the explicit result tool.
- Rename `subagent_poll` to `subagent_result`; it may still report `running` if checked early.

## 4. Add MCP input/output token logging - [x]

- Log model-facing MCP input and output token counts after final response transformation.
- Treat these as MCP I/O metrics, not exact model inference usage.
- Keep accounting generic and centralized.
- If reliable accounting for a tool requires special-case complexity, skip it rather than complicating the system.

## 5. Validate and simplify - [x]

- Verify all three output modes against representative non-Computer-Use tools.
- Verify compact output preserves meaningful data while reducing token cost.
- Verify completion events are delivered once and do not replace explicit subagent result retrieval.
- Verify token logging reflects the actual model-facing payload.
- Confirm no obsolete background response-polling path remains. Keep typed structured results/output schemas internally because `always` mode still uses them.
- Published tool-definition benchmark (`o200k_base`): `always` 5,850 tokens, default `optional` 4,879, `never` 4,582.

## 6. Refactor after behavior is stable (Optional) - [x]

- Split the former subagent monolith by reason to change: lifecycle/orchestration remains in `chatgpt-subagent.ts`, volatile ChatGPT Web/CDP behavior lives in `chatgpt-subagent-browser.ts`, and shared contracts live in `chatgpt-subagent-contracts.ts`.
- Split subagent tests to match those production boundaries without introducing manager/service abstractions for tightly coupled lifecycle state.
- Clean up the broader test suite with responsibility-based shell test files, deterministic synchronization for expensive parallel-shell cases, small shared shell/temp helpers, direct script-function tests, and reduced audit-log boilerplate.
