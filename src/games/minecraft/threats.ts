/**
 * Hostile entities, by name. This list answers *is it a threat* — flee, shelter, refuse to mine next to it.
 * It does **not** answer *may we fight it*: that is `minecraftCombatTargets` in `combat.ts`, which avoids a
 * creeper or an enderman even though both are hostile. Keeping the two apart is what lets the agent run from
 * something it would never swing at.
 *
 * Names matter more than `type` here: Mineflayer reports `entity.type` as a broad category (`mob`, `player`,
 * `object`), so a live run classifies almost everything through this set. `enderman` was missing from it while
 * already carrying 40 health in the combat table — an enderman was therefore neither fled from nor refused,
 * it was simply not seen as a threat at all.
 *
 * Deliberately *not* listed: neutral mobs that only turn hostile when provoked (bee, wolf, polar bear,
 * piglin, zombified piglin, iron golem). Treating them as threats would make the agent flee from animals;
 * provoking them is prevented by the engage/avoid table instead. Revisit with live evidence before changing.
 */
const HOSTILE_EXACT_NAMES = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
  "enderman",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
]);

export function isHostileMinecraftEntity(name: string, type: string): boolean {
  const normalized = name.toLowerCase().replaceAll(" ", "_");
  if (type.toLowerCase() === "hostile") return true;
  if (HOSTILE_EXACT_NAMES.has(normalized)) return true;
  return (
    normalized.startsWith("zombie_") ||
    normalized.startsWith("skeleton_") ||
    normalized.startsWith("wither_skeleton_") ||
    normalized.startsWith("hostile_")
  );
}
