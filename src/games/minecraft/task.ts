import { z } from "zod";
import { minecraftCraftTaskItemNames, minecraftLogNames } from "./capabilities.js";
import { minecraftMineableBlockNames } from "./mining.js";

const taskLimits = {
  schemaVersion: z.literal(1).default(1),
  maxActions: z.number().int().min(1).max(100).default(12),
  maxDurationMs: z.number().int().min(1_000).max(600_000).default(120_000),
  dangerRadius: z.number().finite().min(2).max(16).default(6),
  maxTargetDistance: z.number().finite().min(2).max(48).default(24),
  maxConsecutiveFailures: z.number().int().min(1).max(5).default(2),
  /** Exploration legs (navigation to unexplored waypoints) allowed per task. Zero disables exploration. */
  maxExplorationLegs: z.number().int().min(0).max(30).default(8),
  /** Exploration never leaves this radius around the task's starting point. */
  explorationRadius: z.number().finite().min(8).max(96).default(48),
  /** Total virtual time that resting may consume during one task. */
  maxRestMs: z.number().int().min(0).max(300_000).default(60_000),
};

export const gatherResourceTaskSchema = z.object({
  ...taskLimits,
  id: z.string().min(1).max(96),
  kind: z.literal("gather_resource").default("gather_resource"),
  resourceName: z.enum(minecraftLogNames),
  targetCount: z.number().int().min(1).max(64).default(1),
});

export const craftItemTaskSchema = z.object({
  ...taskLimits,
  id: z.string().min(1).max(96),
  kind: z.literal("craft_item"),
  targetItem: z.enum(minecraftCraftTaskItemNames),
  targetCount: z.number().int().min(1).max(64).default(1),
});

/** Keeps the player fed: eats, picks up dropped food, harvests ripe berries, and explores for them. */
export const secureFoodTaskSchema = z.object({
  ...taskLimits,
  id: z.string().min(1).max(96),
  kind: z.literal("secure_food"),
  targetHunger: z.number().int().min(1).max(20).default(18),
});

/** Digs a specific stone-class or ore block; the tool requirement is derived, never requested. */
export const mineResourceTaskSchema = z.object({
  ...taskLimits,
  id: z.string().min(1).max(96),
  kind: z.literal("mine_resource").default("mine_resource"),
  resourceName: z.enum(minecraftMineableBlockNames),
  targetCount: z.number().int().min(1).max(64).default(4),
});

/** Closes the open sides around the player with blocks from inventory. */
export const buildShelterTaskSchema = z.object({
  ...taskLimits,
  id: z.string().min(1).max(96),
  kind: z.literal("build_shelter").default("build_shelter"),
  mode: z.enum(["cardinal", "full"]).default("cardinal"),
  maxBlocks: z.number().int().min(1).max(16).default(4),
});

export const minecraftTaskSchema = z.discriminatedUnion("kind", [
  gatherResourceTaskSchema,
  craftItemTaskSchema,
  secureFoodTaskSchema,
  mineResourceTaskSchema,
  buildShelterTaskSchema,
]);

export type GatherResourceTask = z.infer<typeof gatherResourceTaskSchema>;
export type CraftItemTask = z.infer<typeof craftItemTaskSchema>;
export type SecureFoodTask = z.infer<typeof secureFoodTaskSchema>;
export type MineResourceTask = z.infer<typeof mineResourceTaskSchema>;
export type BuildShelterTask = z.infer<typeof buildShelterTaskSchema>;
export type MinecraftTask = z.infer<typeof minecraftTaskSchema>;

export const DEFAULT_GATHER_LOG_TASK: GatherResourceTask = gatherResourceTaskSchema.parse({
  id: "collect-one-oak-log",
  resourceName: "oak_log",
  targetCount: 1,
});

export const DEFAULT_CRAFT_PICKAXE_TASK: CraftItemTask = craftItemTaskSchema.parse({
  id: "craft-one-wooden-pickaxe",
  kind: "craft_item",
  targetItem: "wooden_pickaxe",
  targetCount: 1,
});

export const DEFAULT_SECURE_FOOD_TASK: SecureFoodTask = secureFoodTaskSchema.parse({
  id: "secure-food",
  kind: "secure_food",
  targetHunger: 18,
});

export const DEFAULT_MINE_COBBLESTONE_TASK: MineResourceTask = mineResourceTaskSchema.parse({
  id: "mine-cobblestone",
  kind: "mine_resource",
  resourceName: "stone",
  targetCount: 4,
});

export const DEFAULT_BUILD_SHELTER_TASK: BuildShelterTask = buildShelterTaskSchema.parse({
  id: "build-shelter",
  kind: "build_shelter",
  mode: "cardinal",
  maxBlocks: 4,
});
