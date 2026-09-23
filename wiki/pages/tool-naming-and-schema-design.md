---
summary: "Tool metadata design and observed ChatGPT schema-projection pitfalls."
paths:
  - src/mcp/tool-schema-presentation.ts
  - src/mcp/tool-output.ts
  - src/tools/shell/shell-contracts.ts
---

# Tool Naming and Schema Design

Name identifies. Description routes. Schema constrains. Parameter descriptions disambiguate. Results enable the next decision. Wiki explains implementation.

- Prefer predictable domain/action families and concrete verbs. Preserve established public names unless changing them intentionally.
- Descriptions usually need one or two sentences: purpose, selection conditions, and any proven collision with adjacent tools. Keep cache/layout/implementation details in wiki or source.
- Encode mechanical constraints in schemas. Describe identity, continuation, or parameter relationships only when shape cannot convey them.
- Add negative routing instructions after observed misuse, not speculative concern.
- Return the smallest stable result that supports the next action. Preserve distinctions between running work, retained output, permanent loss, and failure.

## Advertised schema differs from validation

[tool-schema-presentation.ts](../../src/mcp/tool-schema-presentation.ts) projects Zod's JSON Schema output without weakening runtime validation. It removes noisy keywords and default annotations, orders schema keywords, and preserves parameter order. Inspect its constants for exact pruning rules; avoid duplicating that list here.

Historical ChatGPT observations showed TypeScript-like tool signatures with descriptions and retained constraints rendered as comments. Those observations explain the presentation policy; they do not guarantee current client rendering.

A concrete regression: adding model-facing `oneOf` metadata to `shell_run`'s `command`/`commands` exclusivity collapsed the visible arguments to `{ [key: string]: any }`. Removing that metadata restored the object shape. [shell-contracts.ts](../../src/tools/shell/shell-contracts.ts) retains semantic validation through refinement. Prefer directly representable shapes; verify actual client presentation before introducing composition solely to express a relationship.

Keep constraints that change planning visible. Avoid prose repeating defaults, types, or ranges already advertised. If pruning hides a rule callers need to construct valid values, describe that rule briefly.

Output mode and native-content exceptions belong to [Registration Boundary](./mcp-tool-registration-boundary.md). Check `npm run schemas -- <tool-name>` plus [schema tests](../../test/mcp/tool-schema-presentation.test.ts); schemas alone cannot prove ChatGPT rendering. Fix observed confusion in the smallest responsible layer: name, description, parameter semantics, validation, or result presentation.
