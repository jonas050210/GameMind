import {
  minecraftFoodNames,
  minecraftLogNames,
  minecraftPlankNames,
  type MinecraftFoodName,
  type MinecraftLogName,
  type MinecraftPlankName,
} from "./capabilities.js";

export type CraftableMinecraftItem =
  | (typeof minecraftPlankNames)[number]
  | "stick"
  | "crafting_table"
  | "wooden_pickaxe"
  | "wooden_axe"
  | "wooden_shovel"
  | "wooden_sword"
  | "stone_pickaxe"
  | "stone_axe"
  | "stone_shovel"
  | "stone_sword";

export interface MinecraftRecipePlan {
  readonly outputCount: number;
  readonly ingredients: Readonly<Record<string, number>>;
  readonly requiresCraftingTable: boolean;
}

/**
 * Deliberately small recipe knowledge for offline planning. The live adapter
 * still asks Mineflayer's version-specific recipe registry before crafting.
 */
export const minecraftRecipePlans: Readonly<Partial<Record<CraftableMinecraftItem, MinecraftRecipePlan>>> = {
  oak_planks: { outputCount: 4, ingredients: { oak_log: 1 }, requiresCraftingTable: false },
  birch_planks: { outputCount: 4, ingredients: { birch_log: 1 }, requiresCraftingTable: false },
  spruce_planks: { outputCount: 4, ingredients: { spruce_log: 1 }, requiresCraftingTable: false },
  jungle_planks: { outputCount: 4, ingredients: { jungle_log: 1 }, requiresCraftingTable: false },
  acacia_planks: { outputCount: 4, ingredients: { acacia_log: 1 }, requiresCraftingTable: false },
  dark_oak_planks: { outputCount: 4, ingredients: { dark_oak_log: 1 }, requiresCraftingTable: false },
  mangrove_planks: { outputCount: 4, ingredients: { mangrove_log: 1 }, requiresCraftingTable: false },
  cherry_planks: { outputCount: 4, ingredients: { cherry_log: 1 }, requiresCraftingTable: false },
  pale_oak_planks: { outputCount: 4, ingredients: { pale_oak_log: 1 }, requiresCraftingTable: false },
  stick: { outputCount: 4, ingredients: { any_planks: 2 }, requiresCraftingTable: false },
  crafting_table: { outputCount: 1, ingredients: { any_planks: 4 }, requiresCraftingTable: false },
  wooden_pickaxe: {
    outputCount: 1,
    ingredients: { any_planks: 3, stick: 2 },
    requiresCraftingTable: true,
  },
  wooden_axe: {
    outputCount: 1,
    ingredients: { any_planks: 3, stick: 2 },
    requiresCraftingTable: true,
  },
  wooden_shovel: {
    outputCount: 1,
    ingredients: { any_planks: 1, stick: 2 },
    requiresCraftingTable: true,
  },
  wooden_sword: {
    outputCount: 1,
    ingredients: { any_planks: 2, stick: 1 },
    requiresCraftingTable: true,
  },
  stone_pickaxe: {
    outputCount: 1,
    ingredients: { cobblestone: 3, stick: 2 },
    requiresCraftingTable: true,
  },
  stone_axe: {
    outputCount: 1,
    ingredients: { cobblestone: 3, stick: 2 },
    requiresCraftingTable: true,
  },
  stone_shovel: {
    outputCount: 1,
    ingredients: { cobblestone: 1, stick: 2 },
    requiresCraftingTable: true,
  },
  stone_sword: {
    outputCount: 1,
    ingredients: { cobblestone: 2, stick: 1 },
    requiresCraftingTable: true,
  },
};

/** Kept as an alias: the plan table now covers stone tools as well as wood. */
export const minecraftWoodRecipePlans = minecraftRecipePlans;

/** Ingredients that are mined rather than crafted, and how many are needed per operation. */
export const minecraftMinedIngredientNames = ["cobblestone"] as const;

export function isMinedIngredient(name: string): boolean {
  return (minecraftMinedIngredientNames as readonly string[]).includes(name);
}

/** Blocks that yield a mined ingredient, so the planner knows what to dig for. */
export const minedIngredientSources: Readonly<Record<string, readonly string[]>> = {
  cobblestone: ["stone", "cobblestone", "deepslate", "cobbled_deepslate"],
};

const plankNames = new Set<string>(minecraftPlankNames);
const logNames = new Set<string>(minecraftLogNames);

export function isMinecraftPlankName(name: string): name is MinecraftPlankName {
  return plankNames.has(name);
}

export function isMinecraftLogName(name: string): name is MinecraftLogName {
  return logNames.has(name);
}

export function plankNameForLog(logName: MinecraftLogName): MinecraftPlankName {
  return `${logName.slice(0, -4)}_planks` as MinecraftPlankName;
}

export const minecraftFoodNutrition: Readonly<Record<MinecraftFoodName, number>> = {
  apple: 4,
  baked_potato: 5,
  bread: 5,
  carrot: 3,
  cooked_beef: 8,
  cooked_chicken: 6,
  cooked_cod: 5,
  cooked_mutton: 6,
  cooked_porkchop: 8,
  cooked_rabbit: 5,
  cooked_salmon: 6,
  cookie: 2,
  dried_kelp: 1,
  glow_berries: 2,
  golden_apple: 4,
  melon_slice: 2,
  mushroom_stew: 6,
  pumpkin_pie: 8,
  sweet_berries: 2,
};

export function isMinecraftFoodName(name: string): name is MinecraftFoodName {
  return (minecraftFoodNames as readonly string[]).includes(name);
}

/** Counts a target item in both the inventory and equipment slots. */
export function countItemAndEquipment(
  inventory: readonly { readonly slot: number; readonly name: string; readonly count: number }[],
  equipment: Readonly<Record<string, { readonly slot: number; readonly name: string; readonly count: number } | null>>,
  target: string,
): number {
  const inventorySlots = new Set(inventory.map((item) => item.slot));
  const inventoryCount = inventory.reduce(
    (sum, item) => sum + (item.name === target ? item.count : 0),
    0,
  );
  return inventoryCount + Object.values(equipment).reduce(
    (sum, item) => sum + (item?.name === target && !inventorySlots.has(item.slot) ? item.count : 0),
    0,
  );
}
