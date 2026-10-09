import { createFakeMinecraftFixture } from "../../src/testing/fake-minecraft-adapter.js";
import type { MinecraftObservation } from "../../src/games/minecraft/observation.js";

type Overrides = Partial<MinecraftObservation>;

/** Builds a valid observation around the deterministic legacy fixture, then applies overrides. */
export function observationAt(
  position: { x: number; y: number; z: number },
  overrides: Overrides = {},
): MinecraftObservation {
  const base = createFakeMinecraftFixture(1337);
  const center = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  return {
    ...base,
    player: { ...base.player, position: { ...position } },
    nearbyBlocks: [],
    entities: [],
    resourceSightings: [],
    resourceScan: { ...base.resourceScan, center },
    itemDrops: [],
    sampledRegion: { ...base.sampledRegion, center },
    ...overrides,
  };
}

export function block(name: string, x: number, y: number, z: number) {
  return {
    position: { x, y, z },
    name,
    type: 1,
    boundingBox: name === "air" ? "empty" : "block",
  };
}
