import { minecraftLogNames } from "./capabilities.js";

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

/** Sweet berry bushes yield berries only when their `age` reaches this value (Java 1.20). */
export const MINECRAFT_RIPE_BERRY_AGE = 2;

export function isResourceBlockName(name: string): boolean {
  return resourceNames.has(name);
}

export function isInterestingBlockName(name: string): boolean {
  return resourceNames.has(name) || hazardBlockNames.has(name);
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
