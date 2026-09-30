import assert from "node:assert/strict"
import test from "node:test"

import {
  cloneDefaultRoomLayout,
  migrateRoomLayout,
} from "../../ui/src/features/agent-room/layout.js"

test("saved room assets migrate to root URLs without changing the saved layout or unrelated paths", () => {
  const saved = cloneDefaultRoomLayout()
  saved.tiles[0] = { type: "floor", asset: "/ui/pixel-agents/assets/floors/floor_5.png" }
  saved.carpetTiles[0] = { asset: "/ui/pixel-agents/assets/carpets/carpet_0.png", order: 2 }
  saved.pets = [{ id: "cat", asset: "/ui/pixel-agents/assets/pets/cat/pet.png", x: 4, y: 5 }]
  saved.characterAsset = "/ui/pixel-agents/assets/characters/char_1.png"
  saved.wallDecor = [{ asset: "/ui/pixel-agents/assets/furniture/CLOCK/CLOCK.png", x: 1, y: 2 }]
  saved.furniture = [
    { asset: "/ui/pixel-agents/assets/furniture/SOFA/SOFA.png", x: 3, y: 4 },
    { asset: "plant", x: 5, y: 6 },
    { asset: "https://example.com/ui/pixel-agents/custom.png", x: 7, y: 8 },
    { asset: "/custom/ui/image.png", x: 9, y: 10 },
  ]
  const original = structuredClone(saved)
  const migrated = migrateRoomLayout(saved)
  assert.deepEqual(migrated.tiles[0], {
    type: "floor",
    asset: "/pixel-agents/assets/floors/floor_5.png",
    tint: "#b9784c",
  })
  assert.deepEqual(migrated.carpetTiles[0], {
    asset: "/pixel-agents/assets/carpets/carpet_0.png",
    order: 2,
  })
  assert.deepEqual(migrated.pets[0], {
    id: "cat",
    asset: "/pixel-agents/assets/pets/cat/pet.png",
    x: 4,
    y: 5,
  })
  assert.equal(migrated.characterAsset, "/pixel-agents/assets/characters/char_1.png")
  assert.equal(migrated.wallDecor[0]?.asset, "/pixel-agents/assets/furniture/CLOCK/CLOCK.png")
  assert.equal(migrated.furniture[0]?.asset, "/pixel-agents/assets/furniture/SOFA/SOFA.png")
  assert.deepEqual(migrated.furniture.slice(1), saved.furniture.slice(1))
  assert.deepEqual(saved, original)
  assert.deepEqual(migrateRoomLayout(migrated), migrated)
})
