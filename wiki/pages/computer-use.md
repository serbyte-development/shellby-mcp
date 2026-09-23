---
summary: "Peekaboo ownership, snapshot coordinates, background delivery, and permission debugging."
paths:
  - src/tools/computer/
  - src/tools/image/image-encoding.ts
  - src/index.ts
  - src/config.ts
  - vendor/peekaboo/
  - scripts/peekaboo-permissions.mjs
---

# Computer Use

[computer-tools.ts](../../src/tools/computer/computer-tools.ts) owns focused `computer_*` schemas and semantic validation. One serialized [PeekabooClient](../../src/tools/computer/peekaboo.ts) owns argv translation, bounded JSON, capture cleanup, and snapshot targets. Production invokes the bundled CLI directly, without a shell, using `--no-remote`. Raw Peekaboo commands through `shell_run` bypass this adapter.

## Snapshot invariants

- Observation retains resolved target metadata under its snapshot ID. Mappings are bounded and process-local; missing/evicted targets require re-observation.
- [Shared image encoding](./tools/files-and-images.md) preserves dimensions and orientation. Screen captures require display-origin translation; window actions use capture-relative coordinates. Adapter owns both interpretations.
- Explicit `PID:<pid>` selectors survive Peekaboo's normalized/omitted metadata so follow-up actions stay process-bound.
- `computer_inspect` creates a new snapshot and propagates the target. Its element IDs belong to that returned snapshot, not the earlier screenshot.
- Exact-window actions may require a fresh local Peekaboo snapshot receipt. Re-observe after ambiguous mutations; stateful actions are not automatically retried.

For targeting errors, inspect capture bounds and dimensions before adding coordinate transforms. Multi-display behavior needs real-CLI validation.

## Delivery and lifecycle

Schemas define which actions permit background delivery. Coordinate dragging requires one exact observed window; screen targets, element endpoints, and modifiers are rejected. App-only/targetless presses and hotkeys require foreground delivery; typing can target an app in the background. Pointer and smooth scrolling require foreground mode.

[cursor-host.ts](../../src/tools/computer/cursor-host.ts) owns the optional bundled companion child, relaunch after unexpected exit, and shutdown. Missing companion leaves Computer Use available. MCP composition owns it; it is not a separate PM2 app.

For TCC problems, inspect the responsible launching process and [runtime recovery](./operations/runtime-recovery.md). [peekaboo-permissions.mjs](../../scripts/peekaboo-permissions.mjs) delegates permission checks/grants to Peekaboo. Vendor rebuild/provenance: `scripts/vendor/build-peekaboo.sh`, `vendor/peekaboo/provenance.json`.

Tests: [adapter](../../test/peekaboo.test.ts), [MCP computer cases](../../test/integrations/computer.ts), [vendor smoke](../../test/peekaboo-vendor.test.ts), [image geometry](../../test/image-encoding.test.ts).
