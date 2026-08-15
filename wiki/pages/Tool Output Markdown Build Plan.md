# Tool Output Markdown Build Plan

Verified 2026-08-15.

Status: Active implementation plan. Remove this page after the final behavior and validation evidence are folded into [[pages/MCP Tool Surface]] and [[pages/Build and Test]].

## What This Is

This plan governs the in-progress compact Markdown projection for normal non-Computer MCP tool results.

## Goal

Convert existing structured tool results into compact, agent-optimized Markdown without losing meaningful data.

The output is for AI agents, not humans. Optimize for token density, scanability, and reliable retrieval of exact values.

## Core approach

- Keep each tool's existing typed internal result as the source of truth.
- Preserve existing model-facing `content` when it already provides useful context or a concise status summary.
- Add one shared transform at the MCP boundary that renders `structuredContent` as compact Markdown when structured output is disabled.
- Remove `structuredContent` from the model-facing result only after its information has been represented in Markdown.
- Do not make the transform tool-aware unless later evidence proves a specific tool needs special handling.

## Markdown shape

- Put short scalar metadata on compact lines: `status=completed exit_code=0 cwd=/workspace`.
- Put long or multiline strings under a named section and preserve their contents verbatim.
- Render arrays of simple objects as compact list rows.
- Recurse through ordinary nested objects and arrays of objects instead of switching to JSON because a field is long or multiline.
- Use indentation and list items to preserve record boundaries while keeping nested text readable as Markdown.
- Keep the short-string threshold only as an inline-vs-section presentation choice; it must not decide whether an object becomes JSON.
- Fall back to minified JSON only for unusual or ambiguous array shapes that do not map cleanly to scalar lists or record lists.
- Preserve non-text content such as images and resources unchanged.

## Output contract

- Compact mode must preserve every meaningful value available in the structured result.
- Formatting may change representation, never semantics.
- Existing summaries may remain as useful headers, but they must not replace the underlying result data.
- Pending global completion events are appended after the transformed tool result in a compact, prominent model-facing form such as `**agent_finished:** agent_id=<agent_id> turn_id=<turn_id>`.

## Scope

Apply the transform to the normal non-Computer-Use tool surface first, including shell, patch, web, skills, and subagent tools.

Leave Computer Use tools unchanged for this pass. Many already use unstructured `content`, image blocks, or specialized observations and do not need to be normalized yet.

## Validation

- Test representative scalar, multiline, array, nested-object, and fallback cases.
- Keep exact compact-output fixtures for every normal non-Computer tool family, including realistic long skill descriptions and multiline subagent Markdown/code.
- Verify no meaningful leaf values disappear during transformation.
- Compare token cost against the current structured representation.
- Prefer the generic transform unless testing shows a concrete quality problem that justifies a narrowly scoped exception.

## Success condition

Compact mode gives the agent all information it would have received from structured output, in a smaller and easier-to-scan Markdown representation, without creating a per-tool formatting system.

## Related

- [[pages/MCP Tool Surface]]
- [[pages/Tool Naming and Schema Design]]
- [[pages/Build and Test]]
