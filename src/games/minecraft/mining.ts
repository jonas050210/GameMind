/**
 * Mining knowledge: which blocks the agent may dig, what they drop, and which tool tier is required
 * for the drop to appear. These are Java Edition 1.20.4 values, deliberately limited to blocks the
 * agent can actually use; the list is the allowlist, so an unexpected block name is refused rather
 * than dug on speculation.
 */

export const minecraftMineableBlockNames = [
  "dirt",
  "grass_block",
  "sand",
  "gravel",
  "stone",
  "cobblestone",
  "granite",
  "andesite",
  "diorite",
  "deepslate",
  "cobbled_deepslate",
  "coal_ore",
  "deepslate_coal_ore",
  "copper_ore",
  "deepslate_copper_ore",
  "iron_ore",
  "deepslate_iron_ore",
] as const;

export type MineableMinecraftBlock = (typeof minecraftMineableBlockNames)[number];

export interface MinecraftMiningRequirement {
  readonly drop: string;
  /** 0 = any hand, 1 = wooden pickaxe or better, 2 = stone pickaxe or better. */
  readonly minPickaxeTier: 0 | 1 | 2;
  /** True when a pickaxe (not a hand) is needed at all, even for a soft drop. */
  readonly requiresPickaxe: boolean;
  /** Approximate seconds to dig with a correctly tiered wooden pickaxe. */
  readonly baseSeconds: number;
  readonly usefulFor: readonly string[];
}

export const minecraftMiningRequirements: Readonly<Record<MineableMinecraftBlock, MinecraftMiningRequirement>> = {
  dirt: { drop: "dirt", minPickaxeTier: 0, requiresPickaxe: false, baseSeconds: 0.75, usefulFor: ["shelter", "bridging"] },
  grass_block: { drop: "dirt", minPickaxeTier: 0, requiresPickaxe: false, baseSeconds: 0.9, usefulFor: ["shelter"] },
  sand: { drop: "sand", minPickaxeTier: 0, requiresPickaxe: false, baseSeconds: 0.75, usefulFor: ["shelter"] },
  gravel: { drop: "gravel", minPickaxeTier: 0, requiresPickaxe: false, baseSeconds: 0.9, usefulFor: ["shelter"] },
  stone: { drop: "cobblestone", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 7.5, usefulFor: ["stone_tools", "shelter"] },
  cobblestone: { drop: "cobblestone", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 8, usefulFor: ["stone_tools", "shelter"] },
  granite: { drop: "granite", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 7.5, usefulFor: ["shelter"] },
  andesite: { drop: "andesite", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 7.5, usefulFor: ["shelter"] },
  diorite: { drop: "diorite", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 7.5, usefulFor: ["shelter"] },
  deepslate: { drop: "cobbled_deepslate", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 9, usefulFor: ["stone_tools", "shelter"] },
  cobbled_deepslate: { drop: "cobbled_deepslate", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 9, usefulFor: ["stone_tools", "shelter"] },
  coal_ore: { drop: "coal", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 15, usefulFor: ["fuel", "torches"] },
  deepslate_coal_ore: { drop: "coal", minPickaxeTier: 1, requiresPickaxe: true, baseSeconds: 16, usefulFor: ["fuel", "torches"] },
  copper_ore: { drop: "raw_copper", minPickaxeTier: 2, requiresPickaxe: true, baseSeconds: 15, usefulFor: ["tools"] },
  deepslate_copper_ore: { drop: "raw_copper", minPickaxeTier: 2, requiresPickaxe: true, baseSeconds: 16, usefulFor: ["tools"] },
  iron_ore: { drop: "raw_iron", minPickaxeTier: 2, requiresPickaxe: true, baseSeconds: 15, usefulFor: ["tools", "armor"] },
  deepslate_iron_ore: { drop: "raw_iron", minPickaxeTier: 2, requiresPickaxe: true, baseSeconds: 16, usefulFor: ["tools", "armor"] },
};

/** Blocks that may be placed from inventory by the shelter skill. */
export const minecraftPlaceableBlockNames = [
  "dirt",
  "cobblestone",
  "granite",
  "andesite",
  "diorite",
  "cobbled_deepslate",
  "oak_planks",
  "birch_planks",
  "spruce_planks",
  "crafting_table",
] as const;

export type PlaceableMinecraftBlock = (typeof minecraftPlaceableBlockNames)[number];

/** Item names that a full inventory may safely discard: raw terrain, never tools or food. */
export const minecraftDroppableJunkNames = [
  "dirt",
  "sand",
  "gravel",
  "granite",
  "andesite",
  "diorite",
  "cobbled_deepslate",
] as const;

const pickaxeTiers: Readonly<Record<string, 0 | 1 | 2 | 3 | 4>> = {
  wooden_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  golden_pickaxe: 2,
  diamond_pickaxe: 4,
  netherite_pickaxe: 4,
};

export type MineabilityVerdict =
  | { readonly mineable: true; readonly reason: string }
  | { readonly mineable: false; readonly code: MinecraftMiningBlockCode; readonly reason: string };

export type MinecraftMiningBlockCode =
  | "BLOCK_NOT_MINEABLE_CLASS"
  | "TOOL_REQUIRED"
  | "TOOL_TIER_INSUFFICIENT";

export function pickaxeTier(name: string | null | undefined): 0 | 1 | 2 | 3 | 4 {
  if (!name) return 0;
  return pickaxeTiers[name] ?? 0;
}

/** Best pickaxe the agent owns across inventory and equipment slots. */
export function bestPickaxeTier(items: Iterable<{ readonly name: string }>): { tier: 0 | 1 | 2 | 3 | 4; name: string | null } {
  let best: { tier: 0 | 1 | 2 | 3 | 4; name: string | null } = { tier: 0, name: null };
  for (const item of items) {
    const tier = pickaxeTiers[item.name as keyof typeof pickaxeTiers];
    if (tier !== undefined && tier > best.tier) best = { tier, name: item.name };
  }
  return best;
}

export function isMineableBlockName(name: string): name is MineableMinecraftBlock {
  return Object.prototype.hasOwnProperty.call(minecraftMiningRequirements, name);
}

export function miningDropFor(name: string): string | null {
  return isMineableBlockName(name) ? minecraftMiningRequirements[name].drop : null;
}

/** Whether the given pickaxe tier can harvest this block at all (a wrong tool yields nothing). */
export function canMineWithTier(name: string, tier: number): MineabilityVerdict {
  if (!isMineableBlockName(name)) {
    return {
      mineable: false,
      code: "BLOCK_NOT_MINEABLE_CLASS",
      reason: `'${name}' is not on the mining allowlist.`,
    };
  }
  const requirement = minecraftMiningRequirements[name];
  if (requirement.requiresPickaxe && tier < 1) {
    return {
      mineable: false,
      code: "TOOL_REQUIRED",
      reason: `${name} needs a pickaxe (min tier ${requirement.minPickaxeTier}); the agent has none.`,
    };
  }
  if (tier < requirement.minPickaxeTier) {
    return {
      mineable: false,
      code: "TOOL_TIER_INSUFFICIENT",
      reason: `${name} needs a tier-${requirement.minPickaxeTier} pickaxe or better; the best available is tier ${tier}.`,
    };
  }
  return { mineable: true, reason: `${requirement.drop} drops with a tier-${tier} pickaxe.` };
}

/** Rough dig time scaling: better tools dig faster, and the estimate keeps action timeouts honest. */
export function estimatedDigSeconds(name: string, tier: number): number {
  if (!isMineableBlockName(name)) return Number.POSITIVE_INFINITY;
  const base = minecraftMiningRequirements[name].baseSeconds;
  const speed = tier <= 0 ? 1 : tier === 1 ? 1 : tier === 2 ? 1.6 : 2.4;
  return Math.max(0.5, Math.round((base / speed) * 10) / 10);
}
