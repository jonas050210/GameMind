const HOSTILE_EXACT_NAMES = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
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
