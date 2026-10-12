import { z } from "zod";
import { minecraftCraftTaskItemNames, minecraftLogNames, minecraftPlankNames } from "./capabilities.js";
import { minecraftMineableBlockNames } from "./mining.js";

const taskLimits = {
  schemaVersion: z.literal(1).default(1),
  // A runaway guard, not a budget: tasks end by completion, timeout, stuck detection or stop.
  maxActions: z.number().int().min(1).max(5000).default(12),
  maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(120_000),
  dangerRadius: z.number().finite().min(2).max(16).default(6),
  maxTargetDistance: z.number().finite().min(2).max(96).default(24),
  maxConsecutiveFailures: z.number().int().min(1).max(5).default(2),
  /** Exploration legs (navigation to unexplored waypoints) allowed per task. Zero disables exploration. */
  maxExplorationLegs: z.number().int().min(0).max(60).default(8),
  /** Exploration never leaves this radius around the task's starting point. */
  explorationRadius: z.number().finite().min(8).max(192).default(48),
  /** Total virtual time that resting may consume during one task. */
  maxRestMs: z.number().int().min(0).max(600_000).default(60_000),
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

const wheatFarmOriginSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-63).max(512),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();

/** Plant wheat into a bounded plot of already-hydrated farmland; soil and irrigation are never guessed or built. */
export const farmWheatTaskSchema = z.object({
  ...taskLimits,
  maxActions: z.number().int().min(1).max(5_000).default(5_000),
  maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(1_800_000),
  maxTargetDistance: z.number().finite().min(2).max(48).default(48),
  maxExplorationLegs: z.number().int().min(0).max(60).default(0),
  id: z.string().min(1).max(96),
  kind: z.literal("farm_wheat"),
  origin: wheatFarmOriginSchema,
  width: z.number().int().min(1).max(25),
  depth: z.number().int().min(1).max(50),
}).strict().refine((task) => task.width * task.depth <= 1_250, {
  message: "A wheat plot may contain at most 1,250 crop cells.",
  path: ["width"],
});

const houseOriginSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-63).max(509),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();

/** A fixed, small, roofed 5×5 starter house; its style and material budget cannot be expanded by chat. */
export const buildHouseTaskSchema = z.object({
  ...taskLimits,
  maxActions: z.number().int().min(1).max(5_000).default(1_000),
  maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(1_800_000),
  maxExplorationLegs: z.number().int().min(0).max(60).default(0),
  id: z.string().min(1).max(96),
  kind: z.literal("build_house"),
  origin: houseOriginSchema,
  materialName: z.enum(minecraftPlankNames).default("oak_planks"),
  /** Separate explicit operator permission is required before collecting any nearby logs. */
  allowMaterialGathering: z.boolean().default(false),
}).strict().refine((task) => task.origin.y + 3 <= 512, {
  message: "The house roof extends above the supported Minecraft build height.",
  path: ["origin", "y"],
});

const excavationOriginSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-64).max(512),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();

/** A bounded axis-aligned excavation cuboid, anchored to already-resolved world coordinates. */
export const excavateVolumeTaskSchema = z.object({
  ...taskLimits,
  maxActions: z.number().int().min(1).max(5000).default(5000),
  maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(1_800_000),
  maxExplorationLegs: z.number().int().min(0).max(60).default(0),
  id: z.string().min(1).max(96),
  kind: z.literal("excavate_volume"),
  origin: excavationOriginSchema,
  width: z.number().int().min(1).max(10),
  height: z.number().int().min(1).max(10),
  depth: z.number().int().min(1).max(10),
}).strict().refine((task) => task.width * task.height * task.depth <= 1_000, {
  message: "An excavation request may include at most 1,000 block cells.",
  path: ["width"],
}).refine((task) => task.origin.y + task.height - 1 <= 512, {
  message: "The excavation extends above the supported Minecraft build height.",
  path: ["height"],
});

export const minecraftTaskSchema = z.discriminatedUnion("kind", [
  gatherResourceTaskSchema,
  craftItemTaskSchema,
  secureFoodTaskSchema,
  mineResourceTaskSchema,
  buildShelterTaskSchema,
  buildHouseTaskSchema,
  farmWheatTaskSchema,
  excavateVolumeTaskSchema,
]);

export type GatherResourceTask = z.infer<typeof gatherResourceTaskSchema>;
export type CraftItemTask = z.infer<typeof craftItemTaskSchema>;
export type SecureFoodTask = z.infer<typeof secureFoodTaskSchema>;
export type MineResourceTask = z.infer<typeof mineResourceTaskSchema>;
export type BuildShelterTask = z.infer<typeof buildShelterTaskSchema>;
export type BuildHouseTask = z.infer<typeof buildHouseTaskSchema>;
export type FarmWheatTask = z.infer<typeof farmWheatTaskSchema>;
export type ExcavateVolumeTask = z.infer<typeof excavateVolumeTaskSchema>;
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
