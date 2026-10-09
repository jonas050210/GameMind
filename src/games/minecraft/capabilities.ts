import { z } from "zod";
import type { CapabilityDefinition } from "../../core/types.js";
import {
  minecraftDroppableJunkNames,
  minecraftMineableBlockNames,
  minecraftPlaceableBlockNames,
} from "./mining.js";

export const MINECRAFT_LOOK_CAPABILITY = "minecraft.look";
export const MINECRAFT_INSPECT_BLOCK_CAPABILITY = "minecraft.inspect_block";
export const MINECRAFT_NAVIGATE_CAPABILITY = "minecraft.navigate";
export const MINECRAFT_COLLECT_BLOCK_CAPABILITY = "minecraft.collect_block";
export const MINECRAFT_EQUIP_CAPABILITY = "minecraft.equip_item";
export const MINECRAFT_CRAFT_CAPABILITY = "minecraft.craft_item";
export const MINECRAFT_EAT_CAPABILITY = "minecraft.eat_food";
export const MINECRAFT_PLACE_TABLE_CAPABILITY = "minecraft.place_crafting_table";
export const MINECRAFT_PICKUP_ITEM_CAPABILITY = "minecraft.pickup_item";
export const MINECRAFT_HARVEST_BERRIES_CAPABILITY = "minecraft.harvest_berries";
export const MINECRAFT_REST_CAPABILITY = "minecraft.rest";
export const MINECRAFT_MINE_BLOCK_CAPABILITY = "minecraft.mine_block";
export const MINECRAFT_PLACE_BLOCK_CAPABILITY = "minecraft.place_block";
export const MINECRAFT_BUILD_SHELTER_CAPABILITY = "minecraft.build_shelter";
export const MINECRAFT_ATTACK_HOSTILE_CAPABILITY = "minecraft.attack_hostile";
export const MINECRAFT_DROP_ITEM_CAPABILITY = "minecraft.drop_item";

/**
 * Capabilities that exist but are denied by the default safety policy until an operator opts in.
 * Attack is the only high-risk capability in the system.
 */
export const MINECRAFT_OPT_IN_CAPABILITIES = [MINECRAFT_ATTACK_HOSTILE_CAPABILITY] as const;

/** Capability names of the original fixture-era surface, kept for legacy fixtures. */
export const LEGACY_MINECRAFT_CAPABILITY_NAMES = [
  MINECRAFT_LOOK_CAPABILITY,
  MINECRAFT_INSPECT_BLOCK_CAPABILITY,
  MINECRAFT_NAVIGATE_CAPABILITY,
  MINECRAFT_COLLECT_BLOCK_CAPABILITY,
  MINECRAFT_EQUIP_CAPABILITY,
  MINECRAFT_CRAFT_CAPABILITY,
  MINECRAFT_EAT_CAPABILITY,
  MINECRAFT_PLACE_TABLE_CAPABILITY,
] as const;

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

export const minecraftStoneToolNames = [
  "stone_pickaxe",
  "stone_axe",
  "stone_shovel",
  "stone_sword",
] as const;

export const minecraftCraftableItemNames = [
  ...minecraftPlankNames,
  "stick",
  "crafting_table",
  "wooden_pickaxe",
  "wooden_axe",
  "wooden_shovel",
  "wooden_sword",
  ...minecraftStoneToolNames,
] as const;

export const minecraftCraftTaskItemNames = [
  "oak_planks",
  "stick",
  "crafting_table",
  "wooden_pickaxe",
  "wooden_axe",
  "wooden_shovel",
  "wooden_sword",
  ...minecraftStoneToolNames,
] as const;

/** Items that count as a tool the agent can hold for mining or fighting. */
export const minecraftToolItemNames = [
  "wooden_pickaxe",
  "stone_pickaxe",
  "wooden_axe",
  "stone_axe",
  "wooden_sword",
  "stone_sword",
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

/** Items a pickup may target: allowlisted food drops and logs (never arbitrary items). */
export const minecraftPickupNames = [...minecraftFoodNames, ...minecraftLogNames] as const;

export const minecraftPickupItemInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
    itemName: z.enum(minecraftPickupNames),
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftHarvestBerriesInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftRestInputSchema = z
  .object({
    durationMs: z.number().int().min(1_000).max(30_000),
    targetHealth: z.number().int().min(1).max(20).default(16),
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftMineBlockInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
    blockName: z.enum(minecraftMineableBlockNames),
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftPlaceBlockInputSchema = z
  .object({
    x: xzCoordinate,
    y: yCoordinate,
    z: xzCoordinate,
    blockName: z.enum(minecraftPlaceableBlockNames),
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftBuildShelterInputSchema = z
  .object({
    mode: z.enum(["cardinal", "full"]).default("cardinal"),
    maxBlocks: z.number().int().min(1).max(16).default(4),
    dangerRadius: z.number().finite().min(2).max(16).default(6),
  })
  .strict();

export const minecraftAttackHostileInputSchema = z
  .object({
    entityId: z.string().min(1).max(48),
    maxHits: z.number().int().min(1).max(6).default(4),
    dangerRadius: z.number().finite().min(2).max(16).default(6),
    minHealth: z.number().finite().min(1).max(20).default(10),
    retreatHealth: z.number().finite().min(0.5).max(20).default(6),
    requiredDamage: z.number().finite().min(1).max(20).default(4),
  })
  .strict();

export const minecraftDropItemInputSchema = z
  .object({
    itemName: z.enum(minecraftDroppableJunkNames),
    count: z.number().int().min(1).max(64).default(1),
  })
  .strict();

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
export type MinecraftPickupItemInput = z.infer<typeof minecraftPickupItemInputSchema>;
export type MinecraftHarvestBerriesInput = z.infer<typeof minecraftHarvestBerriesInputSchema>;
export type MinecraftRestInput = z.infer<typeof minecraftRestInputSchema>;
export type MinecraftMineBlockInput = z.infer<typeof minecraftMineBlockInputSchema>;
export type MinecraftPlaceBlockInput = z.infer<typeof minecraftPlaceBlockInputSchema>;
export type MinecraftBuildShelterInput = z.infer<typeof minecraftBuildShelterInputSchema>;
export type MinecraftAttackHostileInput = z.infer<typeof minecraftAttackHostileInputSchema>;
export type MinecraftDropItemInput = z.infer<typeof minecraftDropItemInputSchema>;
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
  {
    name: MINECRAFT_PICKUP_ITEM_CAPABILITY,
    description:
      "Walk to one observed dropped food or log item and confirm that the matching item entered the inventory. Only allowlisted items are accepted; no entity is attacked.",
    inputSchema: minecraftPickupItemInputSchema,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 60_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_HARVEST_BERRIES_CAPABILITY,
    description:
      "Walk within reach of one observed sweet berry bush whose age is ripe (2 or 3), right-click it once, and confirm that sweet berries entered the inventory.",
    inputSchema: minecraftHarvestBerriesInputSchema,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 60_000,
    risk: "low",
  },
  {
    name: MINECRAFT_REST_CAPABILITY,
    description:
      "Stand still for a bounded time to let natural regeneration work. Stops early on a visible hostile within the danger radius or on any damage; confirms only a health increase.",
    inputSchema: minecraftRestInputSchema,
    defaultTimeoutMs: 20_000,
    maxTimeoutMs: 40_000,
    risk: "low",
  },
  {
    name: MINECRAFT_MINE_BLOCK_CAPABILITY,
    description:
      "Pathfind to one allowlisted stone-class or ore block, check the pickaxe tier the drop requires, dig it, and confirm the drop entered the inventory. Blocks outside the allowlist are refused.",
    inputSchema: minecraftMineBlockInputSchema,
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 120_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_PLACE_BLOCK_CAPABILITY,
    description:
      "Place one allowlisted block from inventory onto an observed solid support in an observed air cell, after rechecking reach, player collision and hostile proximity. Confirms by reading the block back.",
    inputSchema: minecraftPlaceBlockInputSchema,
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 30_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_BUILD_SHELTER_CAPABILITY,
    description:
      "Close the observed open sides around the player with allowlisted blocks from inventory, one placement at a time, stopping on any threat inside the danger radius. Confirms against the blocks observed afterwards.",
    inputSchema: minecraftBuildShelterInputSchema,
    defaultTimeoutMs: 90_000,
    maxTimeoutMs: 150_000,
    risk: "medium",
  },
  {
    name: MINECRAFT_ATTACK_HOSTILE_CAPABILITY,
    description:
      "Attack one specifically identified hostile entity for a bounded number of swings. Refused unless combat was enabled by the operator, health is above the floor, a weapon is held, and only one target is in range. Deny-by-default at the safety broker.",
    inputSchema: minecraftAttackHostileInputSchema,
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 30_000,
    risk: "high",
  },
  {
    name: MINECRAFT_DROP_ITEM_CAPABILITY,
    description:
      "Drop a small amount of allowlisted terrain (dirt, gravel, stone-family blocks) from inventory to free slots. Tools, resources and food are refused.",
    inputSchema: minecraftDropItemInputSchema,
    defaultTimeoutMs: 8_000,
    maxTimeoutMs: 15_000,
    risk: "low",
  },
];

export const legacyMinecraftCapabilities: readonly CapabilityDefinition[] = minecraftCapabilities.filter(
  (capability) => (LEGACY_MINECRAFT_CAPABILITY_NAMES as readonly string[]).includes(capability.name),
);
