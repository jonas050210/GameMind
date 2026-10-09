import { z } from "zod";
import type { CapabilityDefinition } from "../../core/types.js";

export const MINECRAFT_LOOK_CAPABILITY = "minecraft.look";
export const MINECRAFT_INSPECT_BLOCK_CAPABILITY = "minecraft.inspect_block";
export const MINECRAFT_NAVIGATE_CAPABILITY = "minecraft.navigate";
export const MINECRAFT_COLLECT_BLOCK_CAPABILITY = "minecraft.collect_block";
export const MINECRAFT_EQUIP_CAPABILITY = "minecraft.equip_item";
export const MINECRAFT_CRAFT_CAPABILITY = "minecraft.craft_item";
export const MINECRAFT_EAT_CAPABILITY = "minecraft.eat_food";
export const MINECRAFT_PLACE_TABLE_CAPABILITY = "minecraft.place_crafting_table";

const xzCoordinate = z.number().finite().int().min(-30_000_000).max(30_000_000);
const yCoordinate = z.number().finite().int().min(-64).max(512);

export const minecraftLookInputSchema = z
  .object({
    yaw: z.number().finite().min(-Math.PI).max(Math.PI),
    pitch: z.number().finite().min(-Math.PI / 2).max(Math.PI / 2),
  })
  .strict();

export const minecraftInspectBlockInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
  })
  .strict();

export const minecraftNavigateInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
    range: z.number().finite().min(1).max(3).default(1),
  })
  .strict();

export const minecraftLogNames = [
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "pale_oak_log",
] as const;

export const minecraftCollectBlockInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
    blockName: z.enum(minecraftLogNames),
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftEquipInputSchema = z
  .object({
    item: z.string().min(1).max(96).regex(/^[a-z0-9_.:-]+$/i),
    destination: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]),
  })
  .strict();

export const minecraftPlankNames = [
  "oak_planks",
  "birch_planks",
  "spruce_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "cherry_planks",
  "pale_oak_planks",
] as const;

export const minecraftCraftableItemNames = [
  ...minecraftPlankNames,
  "stick",
  "crafting_table",
  "wooden_pickaxe",
  "wooden_axe",
  "wooden_shovel",
  "wooden_sword",
] as const;

export const minecraftCraftTaskItemNames = [
  "oak_planks",
  "stick",
  "crafting_table",
  "wooden_pickaxe",
  "wooden_axe",
  "wooden_shovel",
  "wooden_sword",
] as const;

export const minecraftFoodNames = [
  "apple",
  "baked_potato",
  "bread",
  "carrot",
  "cooked_beef",
  "cooked_chicken",
  "cooked_cod",
  "cooked_mutton",
  "cooked_porkchop",
  "cooked_rabbit",
  "cooked_salmon",
  "cookie",
  "dried_kelp",
  "glow_berries",
  "golden_apple",
  "melon_slice",
  "mushroom_stew",
  "pumpkin_pie",
  "sweet_berries",
] as const;

export const minecraftCraftItemInputSchema = z
  .object({
    item: z.enum(minecraftCraftableItemNames),
    count: z.number().int().min(1).max(64),
    craftingTable: z
      .object({ x: xzCoordinate, y: yCoordinate, z: xzCoordinate })
      .strict()
      .optional(),
  })
  .strict();

export const minecraftPlaceTableInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftEatFoodInputSchema = z
  .object({ item: z.enum(minecraftFoodNames) })
  .strict();

export type MinecraftLookInput = z.infer<typeof minecraftLookInputSchema>;
export type MinecraftInspectBlockInput = z.infer<typeof minecraftInspectBlockInputSchema>;
export type MinecraftNavigateInput = z.infer<typeof minecraftNavigateInputSchema>;
export type MinecraftCollectBlockInput = z.infer<typeof minecraftCollectBlockInputSchema>;
export type MinecraftEquipInput = z.infer<typeof minecraftEquipInputSchema>;
export type MinecraftCraftItemInput = z.infer<typeof minecraftCraftItemInputSchema>;
export type MinecraftPlaceTableInput = z.infer<typeof minecraftPlaceTableInputSchema>;
export type MinecraftEatFoodInput = z.infer<typeof minecraftEatFoodInputSchema>;
export type MinecraftFoodName = (typeof minecraftFoodNames)[number];
export type MinecraftLogName = (typeof minecraftLogNames)[number];
export type MinecraftPlankName = (typeof minecraftPlankNames)[number];

export const minecraftCapabilities: readonly CapabilityDefinition[] = [
  {
    name: MINECRAFT_LOOK_CAPABILITY,
    description:
      "Set the player's view direction. This changes orientation only and does not move or interact with the world.",
    inputSchema: minecraftLookInputSchema,
    defaultTimeoutMs: 4_000,
    maxTimeoutMs: 10_000,
    risk: "low",
  },
  {
    name: MINECRAFT_INSPECT_BLOCK_CAPABILITY,
    description: "Read one locally loaded block without changing the world.",
    inputSchema: minecraftInspectBlockInputSchema,
    defaultTimeoutMs: 2_000,
    maxTimeoutMs: 5_000,
    risk: "low",
  },
  {
    name: MINECRAFT_NAVIGATE_CAPABILITY,
    description:
      "Navigate to a nearby coordinate using conservative pathfinding; pathfinding is configured not to dig, build, parkour, sprint, or drop more than one block.",
    inputSchema: minecraftNavigateInputSchema,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 60_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_COLLECT_BLOCK_CAPABILITY,
    description:
      "Pathfind to and collect one observed overworld log block after rechecking its identity, survival mode, range, harvestability, and fresh hostile proximity. Other block types are not permitted by this action.",
    inputSchema: minecraftCollectBlockInputSchema,
    defaultTimeoutMs: 45_000,
    maxTimeoutMs: 90_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_EQUIP_CAPABILITY,
    description: "Equip an item already in the inventory into a named equipment slot.",
    inputSchema: minecraftEquipInputSchema,
    defaultTimeoutMs: 8_000,
    maxTimeoutMs: 20_000,
    risk: "low",
  },
  {
    name: MINECRAFT_CRAFT_CAPABILITY,
    description: "Craft a small allowlisted set of wood/plank items using only available inventory and, when specified, a nearby observed crafting table.",
    inputSchema: minecraftCraftItemInputSchema,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 60_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_PLACE_TABLE_CAPABILITY,
    description: "Place exactly one crafting table on a validated visible solid support block in a nearby air cell after rechecking player/entity collisions and hostile proximity.",
    inputSchema: minecraftPlaceTableInputSchema,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 20_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_EAT_CAPABILITY,
    description: "Eat one allowlisted food already in inventory when hunger is not full; confirm hunger and inventory changes.",
    inputSchema: minecraftEatFoodInputSchema,
    defaultTimeoutMs: 20_000,
    maxTimeoutMs: 35_000,
    risk: "low",
  },
];
