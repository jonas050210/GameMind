import { minecraftLogNames } from "./capabilities.js";
import { isMineableBlockName } from "./mining.js";

/** Block classes that the wide resource scan reports and that planning may target. */
export const minecraftResourceBlockNames = [
  ...minecraftLogNames,
  "crafting_table",
  "sweet_berry_bush",
] as const;

const resourceNames = new Set<string>(minecraftResourceBlockNames);

/** Blocks that are kept in the observation even when the local cube must be truncated. */
const hazardBlockNames = new Set<string>([
  "lava",
  "water",
  "fire",
  "soul_fire",
  "magma_block",
  "cactus",
]);

/** Terrain classes operators and navigation need to understand even when the local scan is capped. */
export function isRelevantTerrainBlockName(name: string): boolean {
  return name === "grass_block" ||
    name === "dirt" ||
    name === "coarse_dirt" ||
    name === "rooted_dirt" ||
    name === "stone" ||
    name === "cobblestone" ||
    name.endsWith("_leaves");
}

/** Sweet berry bushes yield berries only when their `age` reaches this value (Java 1.20). */
export const MINECRAFT_RIPE_BERRY_AGE = 2;

export function isResourceBlockName(name: string): boolean {
  return resourceNames.has(name);
}

export function isInterestingBlockName(name: string): boolean {
  return resourceNames.has(name) || hazardBlockNames.has(name);
}

/**
 * Ordering used when the local cube must be truncated. Planned-resource and hazard blocks outrank
 * everything (a dropped log must never be truncated away), mineable stone is kept ahead of plain
 * terrain, and ordinary ground is dropped first.
 */
export function blockObservationPriority(name: string): 2 | 1 | 0 {
  if (isInterestingBlockName(name)) return 2;
  if (isMineableBlockName(name) || isRelevantTerrainBlockName(name)) return 1;
  return 0;
}

export function isHazardBlockName(name: string): boolean {
  return hazardBlockNames.has(name);
}

/** Blocks in the local cube that can hurt the agent, with how close they are. */
export function observedHazards(
  blocks: readonly { name: string; position: { x: number; y: number; z: number } }[],
  player: { x: number; y: number; z: number },
): { name: string; position: { x: number; y: number; z: number }; distance: number }[] {
  return blocks
    .filter((block) => hazardBlockNames.has(block.name))
    .map((block) => ({
      name: block.name,
      position: block.position,
      distance: distanceBetween({ x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 }, player),
    }))
    .sort((left, right) => left.distance - right.distance);
}

export function isRipeBerryBush(name: string, properties: Readonly<Record<string, unknown>> | undefined): boolean {
  if (name !== "sweet_berry_bush" || !properties) return false;
  const age = Number(properties.age);
  return Number.isInteger(age) && age >= MINECRAFT_RIPE_BERRY_AGE;
}

export function distanceBetween(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/** Reads numeric/string block properties from Mineflayer blocks when the library exposes them. */
export function blockProperties(block: unknown): Record<string, string | number | boolean> {
  const candidate = block as { getProperties?: () => Record<string, unknown> } | null;
  if (!candidate || typeof candidate.getProperties !== "function") return {};
  let raw: Record<string, unknown>;
  try {
    raw = candidate.getProperties();
  } catch {
    // An unparsable block state must not fail a whole observation; the block is simply unknown.
    return {};
  }
  const properties: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      properties[key] = value;
    }
  }
  return properties;
}
