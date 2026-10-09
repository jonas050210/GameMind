import { z } from "zod";
import { minecraftCraftTaskItemNames, minecraftLogNames } from "./capabilities.js";

const taskLimits = {
  schemaVersion: z.literal(1).default(1),
  maxActions: z.number().int().min(1).max(100).default(12),
  maxDurationMs: z.number().int().min(1_000).max(600_000).default(120_000),
  dangerRadius: z.number().finite().min(2).max(16).default(6),
  maxTargetDistance: z.number().finite().min(2).max(48).default(24),
  maxConsecutiveFailures: z.number().int().min(1).max(5).default(2),
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

export const minecraftTaskSchema = z.discriminatedUnion("kind", [
  gatherResourceTaskSchema,
  craftItemTaskSchema,
]);

export type GatherResourceTask = z.infer<typeof gatherResourceTaskSchema>;
export type CraftItemTask = z.infer<typeof craftItemTaskSchema>;
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
