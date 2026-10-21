---
summary: "Canvas activity queues, visibility scheduling, immutable layout caching, editor migration, and Pixel Agents assets."
paths:
  - src/features/agent-room/AgentRoom.tsx
  - src/features/agent-room/engine.ts
  - src/features/agent-room/layout.ts
  - src/features/agent-room/renderer.ts
  - src/features/agent-room/room-layout-storage.ts
  - src/features/agent-room/editor/
  - public/pixel-agents/
  - THIRD_PARTY_NOTICES.md
---

# Agent Room

## Mental Model

The feature lives under `src/features/agent-room/`. `AgentRoom.tsx` renders room and sprites on Canvas. `engine.ts` owns movement, direction, tool station mapping, animation queue, and RAF update loop. Keep React out of per-frame state.

Static room composition lives in [layout.ts](../../src/features/agent-room/layout.ts); shared drawing lives in [renderer.ts](../../src/features/agent-room/renderer.ts). Objects/entities use an 8px logical grid, including fractional positions; terrain uses 32px cells. Keep those coordinate systems distinct. Layout stores terrain/carpet layers, objects, pets, station anchors and character appearance.

`/editor` uses the same layout model. [RoomEditor.tsx](../../src/features/agent-room/editor/RoomEditor.tsx) owns state, pointer orchestration and mutations; `EditorPanels.tsx` owns palettes, `editor-selection.ts` owns hit testing/selection, and `editor-canvas.ts` owns editor overlays. Saving writes a browser-local override through [room-layout-storage.ts](../../src/features/agent-room/room-layout-storage.ts). Migration preserves old furniture/station edits and normalizes saved `/ui/pixel-agents/` URLs to `/pixel-agents/` so selections match the current catalog. Same-tab events and cross-tab storage events refresh consumers.

Pixel Agents UI assets are vendored as a pinned snapshot under `public/pixel-agents/assets/`. `public/pixel-agents/UPSTREAM_COMMIT` records the exact upstream revision and `public/pixel-agents/catalog.json` normalizes the furniture manifests for the editor. Run root `npm run vendor:pixel-agents` to regenerate the snapshot and `npm run vendor:pixel-agents:check` to validate it without network access. `THIRD_PARTY_NOTICES.md` carries MIT attribution.

The editor builds its palette from the generated catalog instead of a hand-maintained asset list. Rotation/state groups become individual placeable variants, while animation groups expose one representative placement frame; every original PNG remains available in the vendored asset tree and `catalog.images`.

Floor sprites are 16×16 patterns rendered at 2×. Wall sheets use Pixel Agents' N/E/S/W bitmask autotiling (4×4 sheet of 16×32 pieces). Carpet sheets use Pixel Agents' junction-based marching-squares autotiling (4×4 sheet of 16×16 pieces). Pets render their idle-down frames from the vendored 96×96 sheets.

## Activity Queue

Room does not animate directly from `agent.current`. `syncAgentActivities` tracks call IDs and queues unseen calls so fast tools remain visible.

Important semantics:

- On first mount, existing `recent` IDs become seen and do not replay. Current call may enqueue.
- New calls enqueue oldest-first by `startedAt`.
- One activity animates at a time.
- Character walks to station, works there at least 3 seconds after arrival, then returns home.
- If real call still running after 3 seconds, character remains at station until server marks it finished.
- Next queued activity starts only after return home.

This queue is presentation state. Refresh may reset animation progress; server Recent list remains authoritative history.

## Rendering lifetime

`AgentRoom` previews bypass activity queues and render static rooms, repainting when images load. Selected workspaces use `startAgentRoomLoop`: visible active rooms animate, idle redraws are throttled, and hidden/offscreen rooms pause without accumulating elapsed time. Cleanup releases frames, timers, visibility listeners and intersection observers. Keep family-strip previews free of animation loops.

`drawRoomBackground` caches terrain, walls and wall decor by layout object identity plus image revision. Replace layout objects after edits; in-place mutations can leave cached backgrounds stale. Async image loads invalidate cached backgrounds and notify static previews.

## Tool Stations

| Tool family | Station | Visual metaphor |
| --- | --- | --- |
| `shell_*` and default tools | `terminal` | Desk + animated PC |
| `apply_patch` | `patch` | Whiteboard + work table |
| `fetch_url`, `web_*` | `web` | Reference/research corner |
| `image_view`, `image_*` | `image` | Wall art / visual inspection area |
| `subagent_*` | `agents` | Conversation nook with temporary second character and `...` bubble |

Idle home station uses side-facing seated character at compact side desk/PC. The temporary conversation character represents delegation activity; actual parent/child grouping belongs to [dashboard families](./architecture.md#family-and-dismissal-boundaries).

## Rendering Rules

Render order matters:

1. floor/VOID tiles, rugs, and carpet junctions;
2. autotiled walls;
3. wall decor;
4. station focus;
5. furniture and pets;
6. main character;
7. delegated subagent character when active;
8. station-specific foreground furniture;
9. speech bubble;
10. room border.

Use `imageSmoothingEnabled = false` and CSS `image-rendering: pixelated`. Preserve integer-ish sprite placement and asset-native orientation. Furniture that must occlude character belongs in foreground pass rather than adjusting character sprite to compensate.

## Pixel Agents Conventions Worth Preserving

- Character sheet: 16×32 frames, rows for down/up/right; left generated by horizontal mirror.
- Walk frames use first frames; typing/reading frames use later sheet frames.
- Furniture has orientation-specific assets and footprints. Choose correct orientation before tuning coordinates.
- Subagent metaphor is another character, matching Pixel Agents behavior better than invented phone/radio prop.

When room looks wrong, compare composition and layering against upstream Pixel Agents office before adding custom geometry.
