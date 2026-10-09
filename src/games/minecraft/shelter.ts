import type { MinecraftObservation } from "./observation.js";
import { minecraftPlaceableBlockNames, type PlaceableMinecraftBlock } from "./mining.js";
import { blockKey } from "./world-memory.js";

/**
 * Shelter planning is pure geometry over the observed local cube, so the decision model, the live
 * adapter and the simulator all agree on which cells a shelter consists of and on what counts as
 * "sheltered". A cell is only ever chosen when it is *observed* to be air and has an *observed*
 * solid support below: an unobserved cell is never treated as empty.
 */

export const SHELTER_DIRECTIONS = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

/** The four directions that must be closed for the agent to consider itself sheltered. */
export const SHELTER_CARDINAL_DIRECTIONS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

export interface ShelterCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly support: { readonly x: number; readonly y: number; readonly z: number };
  readonly direction: readonly [number, number];
  readonly cardinal: boolean;
  readonly distance: number;
}

export interface ShelterSkip {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly reason: "occupied" | "unknown" | "no-support" | "unsafe-support" | "outside-scan";
}

export interface ShelterPlan {
  readonly cells: readonly ShelterCell[];
  readonly skipped: readonly ShelterSkip[];
  readonly solidCardinalCells: number;
  readonly sheltered: boolean;
  readonly blocksNeeded: number;
}

const UNSAFE_SUPPORT_NAMES = new Set([
  "lava",
  "water",
  "fire",
  "soul_fire",
  "magma_block",
  "cactus",
  "sweet_berry_bush",
]);

function centerOf(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
}

/** Places a block name from inventory onto a support block; the item name is the block name. */
export function placeableBlockCounts(
  state: MinecraftObservation,
  allowed: readonly string[] = minecraftPlaceableBlockNames,
): Map<PlaceableMinecraftBlock, number> {
  const counts = new Map<PlaceableMinecraftBlock, number>();
  for (const item of state.inventory) {
    if (!(allowed as readonly string[]).includes(item.name)) continue;
    const name = item.name as PlaceableMinecraftBlock;
    counts.set(name, (counts.get(name) ?? 0) + item.count);
  }
  return counts;
}

export function planShelter(
  state: MinecraftObservation,
  options: {
    /** Fill only the cells needed to close the four cardinal sides, or all eight. */
    readonly mode?: "cardinal" | "full";
    readonly maxBlocks?: number;
    readonly hostiles?: readonly { x: number; y: number; z: number }[];
    readonly dangerRadius?: number;
  } = {},
): ShelterPlan {
  const mode = options.mode ?? "cardinal";
  const maxBlocks = options.maxBlocks ?? 8;
  const directions =
    mode === "cardinal" ? SHELTER_CARDINAL_DIRECTIONS : SHELTER_DIRECTIONS;
  const player = state.player.position;
  const feetX = Math.floor(player.x);
  const feetY = Math.floor(player.y);
  const feetZ = Math.floor(player.z);
  const solid = new Map<string, { name: string; boundingBox: string }>();
  for (const block of state.nearbyBlocks) {
    solid.set(blockKey(block.position), { name: block.name, boundingBox: block.boundingBox });
  }
  const center = { x: feetX, y: feetY, z: feetZ };
  const scanRadius = state.sampledRegion.radius;
  const scanVertical = state.sampledRegion.verticalRadius;

  const cells: ShelterCell[] = [];
  const skipped: ShelterSkip[] = [];
  let solidCardinalCells = 0;
  for (const [dx, dz] of SHELTER_CARDINAL_DIRECTIONS) {
    const key = blockKey({ x: feetX + dx, y: feetY, z: feetZ + dz });
    if (solid.get(key)?.boundingBox === "block") solidCardinalCells += 1;
  }

  for (const [dx, dz] of directions) {
    const x = feetX + dx;
    const z = feetZ + dz;
    const y = feetY;
    const position = { x, y, z };
    const cardinal = dx === 0 || dz === 0;
    const distance = Math.hypot(player.x - (x + 0.5), player.z - (z + 0.5));
    if (Math.abs(x - center.x) > scanRadius || Math.abs(z - center.z) > scanRadius) {
      skipped.push({ ...position, reason: "outside-scan" });
      continue;
    }
    const observed = solid.get(blockKey(position));
    if (observed && observed.boundingBox === "block") {
      skipped.push({ ...position, reason: "occupied" });
      continue;
    }
    if (!observed && state.sampledRegion.unknownCells > 0) {
      // Absence of a record inside a partially unknown cube is not evidence of air.
      skipped.push({ ...position, reason: "unknown" });
      continue;
    }
    const supportPosition = { x, y: y - 1, z };
    const support = solid.get(blockKey(supportPosition));
    if (!support) {
      skipped.push({ ...position, reason: "unknown" });
      continue;
    }
    if (support.boundingBox !== "block") {
      skipped.push({ ...position, reason: "no-support" });
      continue;
    }
    if (UNSAFE_SUPPORT_NAMES.has(support.name)) {
      skipped.push({ ...position, reason: "unsafe-support" });
      continue;
    }
    if (Math.abs(supportPosition.y - center.y) > scanVertical + 1) {
      skipped.push({ ...position, reason: "outside-scan" });
      continue;
    }
    const hostiles = options.hostiles ?? [];
    const dangerRadius = options.dangerRadius;
    const threatened =
      dangerRadius !== undefined &&
      hostiles.some(
        (hostile) => Math.hypot(hostile.x - (x + 0.5), hostile.y - y, hostile.z - (z + 0.5)) <= dangerRadius,
      );
    if (threatened) {
      skipped.push({ ...position, reason: "unknown" });
      continue;
    }
    cells.push({ ...position, support: supportPosition, direction: [dx, dz], cardinal, distance });
  }

  const chosen = cells
    .sort((left, right) => Number(right.cardinal) - Number(left.cardinal) || left.distance - right.distance)
    .slice(0, Math.max(0, maxBlocks));
  return {
    cells: chosen,
    skipped,
    solidCardinalCells,
    sheltered: solidCardinalCells >= SHELTER_CARDINAL_DIRECTIONS.length,
    blocksNeeded: chosen.length,
  };
}

export { centerOf };
