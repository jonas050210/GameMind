/**
 * Extended episode features for richer learning. V2 adds continuous distances, inventory state,
 * equipment tier, and reward fields. These coexist with the v1 schema — existing episodes remain
 * valid, and new episodes populate both v1 and v2 fields.
 *
 * The v2 fields are additive: they never remove information that v1 provided. The context key
 * generator is extended but backward-compatible.
 */

import { z } from "zod";

/**
 * Equipment tiers for the agent's best tool/weapon. Used as a learning feature:
 * gathering logs with a wooden pickaxe vs. no tool at all are very different situations.
 */
export const equipmentTiers = ["none", "wooden", "stone", "iron", "diamond"] as const;
export type EquipmentTier = (typeof equipmentTiers)[number];

export function equipmentTierOf(heldItem: string | null | undefined): EquipmentTier {
  if (!heldItem) return "none";
  const lower = heldItem.toLowerCase();
  if (lower.includes("diamond")) return "diamond";
  if (lower.includes("iron")) return "iron";
  if (lower.includes("stone")) return "stone";
  if (lower.includes("wooden") || lower.includes("wood")) return "wooden";
  return "none";
}

export function equipmentTierRank(tier: EquipmentTier): number {
  const ranks: Record<EquipmentTier, number> = {
    none: 0,
    wooden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
  };
  return ranks[tier];
}

/**
 * Extended features added to episodes. These are all optional in the sense that
 * existing v1 episodes won't have them, but new episodes should populate them.
 */
export const extendedFeaturesSchema = z.object({
  /** Exact Euclidean distance to the target (not banded). */
  exactDistance: z.number().finite().min(0).max(1e6).optional(),
  /** Number of distinct resource types visible in scan range. */
  visibleResourceTypes: z.number().int().min(0).max(64).optional(),
  /** Number of hostile entities visible. */
  visibleHostileCount: z.number().int().min(0).max(32).optional(),
  /** Total inventory item count (stacks). */
  inventoryCount: z.number().int().min(0).max(256).optional(),
  /** Distinct item types in inventory. */
  inventoryDiversity: z.number().int().min(0).max(64).optional(),
  /** Best held equipment tier. */
  equipmentTier: z.enum(equipmentTiers).optional(),
  /** Whether the agent has a crafting table available (in inventory or nearby). */
  hasCraftingTable: z.boolean().optional(),
  /** Time of day as continuous value [0, 1] where 0 = dawn, 0.5 = dusk. */
  dayPhase: z.number().finite().min(0).max(1).optional(),
  /** Whether the agent is indoors/under cover (reduced exposure). */
  isSheltered: z.boolean().optional(),
  /** Reward breakdown for this episode. */
  reward: z.object({
    survival: z.number().finite(),
    progress: z.number().finite(),
    efficiency: z.number().finite(),
    safety: z.number().finite(),
    exploration: z.number().finite(),
    total: z.number().finite(),
  }).optional(),
  /** Number of times the agent has been stuck (consecutive identical actions). */
  stuckCount: z.number().int().min(0).max(100).optional(),
  /** Whether this is a replan (the agent changed its goal mid-task). */
  isReplan: z.boolean().optional(),
}).partial().optional();

export type ExtendedFeatures = z.infer<typeof extendedFeaturesSchema>;

/**
 * Context key v2: adds time-of-day and equipment tier to the base key, but only when they have
 * enough evidence. To prevent context fragmentation, we merge low-evidence sub-contexts.
 *
 * The key is designed so that the same (skill, goal, distance, threat, vitality) combination
 * always maps to the same base key, and the v2 extensions are additive refinements.
 */
export interface ExtendedContextOptions {
  readonly timeOfDay?: "day" | "night" | "unknown";
  readonly equipmentTier?: EquipmentTier;
  readonly hasCraftingTable?: boolean;
}

/**
 * Extended context key that incorporates v2 features without fragmenting too aggressively.
 * Only adds dimensions that have enough distinct values to matter.
 */
export function extendedContextKey(
  baseKey: string,
  extended: ExtendedContextOptions,
): string {
  const parts: string[] = [baseKey];

  // Time of day: day vs night matters for exploration and survival
  if (extended.timeOfDay && extended.timeOfDay !== "unknown") {
    parts.push(extended.timeOfDay);
  }

  // Equipment tier: only include when it's not "none" (most common)
  if (extended.equipmentTier && extended.equipmentTier !== "none") {
    parts.push(`eq:${extended.equipmentTier}`);
  }

  // Crafting table availability matters for craft goals
  if (extended.hasCraftingTable === true) {
    parts.push("table");
  }

  return parts.join("|");
}

/**
 * Reward-conditioned weight: combines success rate with reward signal.
 * A context that succeeds often AND gets high reward should be weighted more positively
 * than one that succeeds often but gets low reward (e.g. slow, inefficient successes).
 */
export function rewardConditionedWeight(
  successRate: number,
  meanReward: number,
  rewardCount: number,
  minRewardSamples: number,
  prior: number,
  gain: number,
  shrinkToNeutral: number,
  minWeight: number,
  maxWeight: number,
): number {
  // If not enough reward data, fall back to success-rate-only weight
  if (rewardCount < minRewardSamples) {
    const blend = Math.min(1, rewardCount / shrinkToNeutral);
    const raw = 1 + blend * gain * (successRate - prior) / Math.max(0.05, 1 - prior);
    return Math.round(clamp(raw, minWeight, maxWeight) * 1000) / 1000;
  }

  // Blend success rate with reward signal
  // reward > 0 → boost, reward < 0 → penalty
  // Normalise reward to roughly [0, 1] range (typical rewards are -1 to +3)
  const rewardSignal = clamp((meanReward + 1) / 4, 0, 1);

  // Combined evidence: 70% success rate, 30% reward quality
  const combinedEvidence = 0.7 * successRate + 0.3 * rewardSignal;

  const totalSamples = rewardCount;
  const blend = totalSamples / (totalSamples + shrinkToNeutral);
  const raw = 1 + blend * gain * (combinedEvidence - prior) / Math.max(0.05, 1 - prior);
  return Math.round(clamp(raw, minWeight, maxWeight) * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
