import { heldItems } from "./inventory-accounting.js";
import type { MinecraftObservation } from "./observation.js";
import { isMinecraftFoodName } from "./recipes.js";
import { bestWeapon } from "./combat.js";
import {
  craftItemTaskSchema,
  gatherResourceTaskSchema,
  mineResourceTaskSchema,
  secureFoodTaskSchema,
  buildShelterTaskSchema,
  type MinecraftTask,
} from "./task.js";
import { ProgressTracker, type MilestoneId, type ProgressSnapshot } from "./progress-tracker.js";

/**
 * Autonomous task generation with persistent multi-task progression.
 *
 * Uses a ProgressTracker to maintain long-term milestones across task boundaries.
 * Each task the agent undertakes advances toward the current milestone. When a
 * milestone is complete, the agent moves to the next one automatically.
 *
 * Progression chain:
 *   food-security → wooden-tools → shelter → stone-age → iron-age → sustained-gathering
 *
 * The autonomous action limit is higher than before (300) because multi-step tasks
 * like crafting a stone pickaxe require many actions (gather wood → craft planks →
 * craft sticks → craft table → craft pickaxe → mine cobblestone → craft stone pickaxe).
 * Progress-based continuation: if the agent is making progress, the task continues.
 */

// This is a runaway guard, not a progress budget: the Control Center has no action cap. Stuck detection,
// per-subgoal cooldowns and the per-action timeouts stop unproductive work long before it is reached.
// A full stone-age progression (wood → planks → sticks → table → pickaxe → mine → stone pickaxe)
// requires about 40-60 actions; the guard is far above that so it only ends a task that is genuinely runaway.
export const MAX_AUTONOMOUS_ACTIONS = 5_000;

// 5 minutes (at 20 TPS) to allow long progression chains to complete
export const MAX_AUTONOMOUS_DURATION = 300_000;

/**
 * Generate the next autonomous task based on persistent milestone progression.
 * Returns null if the agent appears stable with no immediate needs.
 *
 * @param state Current observation state
 * @param tracker Optional progress tracker for cross-task persistence.
 *   When provided, milestones are tracked and the agent advances through them.
 *   When absent (e.g., in tests), falls back to simple inventory-based priority.
 */
export function generateAutonomousTask(
  state: MinecraftObservation,
  tracker?: ProgressTracker,
): MinecraftTask | null {
  const progress = tracker?.getProgress(state) ?? buildFallbackProgress(state);
  return taskForMilestone(progress.currentMilestone, progress, state);
}

/** Build a progress snapshot without a tracker (for backward compatibility). */
function buildFallbackProgress(state: MinecraftObservation): ProgressSnapshot {
  const items = heldItems(state);
  const count = (names: string[]) =>
    items.filter((i) => names.some((n) => i.name === n)).reduce((s, i) => s + i.count, 0);
  const has = (names: string[]) => items.some((i) => names.some((n) => i.name === n));

  const inv: ProgressSnapshot["inventory"] = {
    logs: count(["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"]),
    planks: count(["oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks"]),
    sticks: count(["stick"]),
    cobblestone: count(["cobblestone"]),
    stone: count(["stone"]),
    coal: count(["coal", "charcoal"]),
    ironOre: count(["raw_iron", "iron_ore"]),
    ironIngot: count(["iron_ingot"]),
    food: items.filter((i) => isMinecraftFoodName(i.name)).reduce((s, i) => s + i.count, 0),
    hasWoodenPickaxe: has(["wooden_pickaxe"]),
    hasStonePickaxe: has(["stone_pickaxe"]),
    hasIronPickaxe: has(["iron_pickaxe"]),
    hasCraftingTable: has(["crafting_table"]),
    hasWeapon: bestWeapon([...items.map((i) => ({ name: i.name }))]) !== null,
    placeableBlocks: items
      .filter((i) => ["cobblestone", "dirt", "oak_planks", "birch_planks", "spruce_planks", "oak_log", "birch_log"].includes(i.name))
      .reduce((s, i) => s + i.count, 0),
  };

  return {
    currentMilestone: determineInitialMilestone(inv, state.player.food),
    currentMilestoneName: "",
    milestones: [],
    completedMilestones: [],
    inventory: inv,
  };
}

function determineInitialMilestone(inv: ProgressSnapshot["inventory"], hungerBar: number | null = null): MilestoneId {
  // Food security: hunger < 14 OR no food reserve (when tools are available)
  const hungerLow = hungerBar !== null && hungerBar < 14;
  if (hungerLow || (inv.food === 0 && (inv.hasWoodenPickaxe || inv.hasStonePickaxe || inv.hasIronPickaxe))) {
    return "food-security";
  }
  if (!inv.hasWoodenPickaxe && !inv.hasStonePickaxe && !inv.hasIronPickaxe) return "wooden-tools";
  if (!inv.hasStonePickaxe && !inv.hasIronPickaxe) return "stone-age";
  return "sustained-gathering";
}

/**
 * Select a task based on the current milestone.
 * Returns null if the milestone has no actionable need.
 */
function taskForMilestone(
  milestone: MilestoneId,
  progress: ProgressSnapshot,
  state: MinecraftObservation,
): MinecraftTask | null {
  const inv = progress.inventory;

  switch (milestone) {
    case "food-security": {
      const hungerOk = state.player.food === null || state.player.food >= 14;
      if (!hungerOk) {
        // Hunger is low — eat immediately, regardless of reserve
        return secureFoodTaskSchema.parse({
          id: "autonomous:find-food",
          kind: "secure_food",
          targetHunger: 16,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 16,
        });
      }
      // Hunger is ok — move on to tool/milestone progression.
      // Food stockpiling is handled as a sub-check in sustained-gathering.
      return taskForMilestone("wooden-tools", progress, state);
    }

    case "wooden-tools": {
      // At night with enough blocks, build shelter first (safety priority)
      const isNightNow = state.time?.isNight ?? false;
      if (isNightNow && inv.placeableBlocks >= 4) {
        return buildShelterTaskSchema.parse({
          id: "autonomous:build-shelter-night",
          kind: "build_shelter",
          targetStyle: "cardinal",
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxRestMs: 0,
          maxExplorationLegs: 10,
        });
      }
      if (inv.hasWoodenPickaxe || inv.hasStonePickaxe || inv.hasIronPickaxe) {
        return taskForMilestone("shelter", progress, state);
      }

      // Total available planks = current + what we can get from logs (4 planks per log)
      const totalPlanksAvailable = inv.planks + inv.logs * 4;

      // Need at least 3 planks for pickaxe + 2 for stick = ~3 planks minimum
      // (the crafting skill handles intermediate planks/sticks from logs)
      if (totalPlanksAvailable >= 3) {
        return craftItemTaskSchema.parse({
          id: "autonomous:craft-wooden-pickaxe",
          kind: "craft_item",
          targetItem: "wooden_pickaxe",
          targetCount: 1,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 8,
        });
      }

      // Not enough logs → gather more
      return gatherResourceTaskSchema.parse({
        id: "autonomous:gather-logs",
        kind: "gather_resource",
        resourceName: "oak_log",
        targetCount: Math.max(1, Math.ceil((3 - totalPlanksAvailable) / 4)),
        maxActions: MAX_AUTONOMOUS_ACTIONS,
        maxDurationMs: MAX_AUTONOMOUS_DURATION,
        maxExplorationLegs: 12,
      });
    }

    case "shelter": {
      // Build shelter at night if we have enough blocks
      const isNight = state.time?.isNight ?? false;
      if (isNight && inv.placeableBlocks >= 4) {
        return buildShelterTaskSchema.parse({
          id: "autonomous:build-shelter",
          kind: "build_shelter",
          targetStyle: "cardinal",
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxRestMs: 0,
          maxExplorationLegs: 10,
        });
      }
      // Shelter milestone is contextual — move to stone-age
      return taskForMilestone("stone-age", progress, state);
    }

    case "stone-age": {
      if (inv.hasStonePickaxe) {
        return taskForMilestone("iron-age", progress, state);
      }

      // Step 1: Need a wooden pickaxe first
      if (!inv.hasWoodenPickaxe) {
        return taskForMilestone("wooden-tools", progress, state);
      }

      // Step 2: Mine stone (drops cobblestone) to accumulate for stone pickaxe
      if (inv.cobblestone < 8) {
        return mineResourceTaskSchema.parse({
          id: "autonomous:mine-cobblestone",
          kind: "mine_resource",
          resourceName: "stone",
          targetCount: Math.max(8, 8 - inv.cobblestone),
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 20,
        });
      }

      // Step 3: Craft stone pickaxe (need cobblestone for pickaxe + planks/sticks for handle)
      if (inv.cobblestone >= 3 && inv.planks >= 2 && inv.sticks >= 2) {
        return craftItemTaskSchema.parse({
          id: "autonomous:craft-stone-pickaxe",
          kind: "craft_item",
          targetItem: "stone_pickaxe",
          targetCount: 1,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 8,
        });
      }

      // Need more planks/sticks
      if (inv.sticks < 2 && inv.planks >= 2) {
        return craftItemTaskSchema.parse({
          id: "autonomous:craft-sticks",
          kind: "craft_item",
          targetItem: "stick",
          targetCount: 4,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 4,
        });
      }

      if (inv.planks < 2 && inv.logs >= 1) {
        return craftItemTaskSchema.parse({
          id: "autonomous:craft-planks-stone",
          kind: "craft_item",
          targetItem: "oak_planks",
          targetCount: 4,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 4,
        });
      }

      if (inv.logs < 1) {
        return gatherResourceTaskSchema.parse({
          id: "autonomous:gather-logs-stone",
          kind: "gather_resource",
          resourceName: "oak_log",
          targetCount: 2,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 12,
        });
      }

      // Fallback: mine more stone
      return mineResourceTaskSchema.parse({
        id: "autonomous:mine-stone-fallback",
        kind: "mine_resource",
        resourceName: "stone",
        targetCount: 8,
        maxActions: MAX_AUTONOMOUS_ACTIONS,
        maxDurationMs: MAX_AUTONOMOUS_DURATION,
        maxExplorationLegs: 20,
      });
    }

    case "iron-age": {
      if (inv.hasIronPickaxe) {
        return taskForMilestone("sustained-gathering", progress, state);
      }

      // Need stone pickaxe to mine iron
      if (!inv.hasStonePickaxe) {
        return taskForMilestone("stone-age", progress, state);
      }

      // Mine iron ore
      if (inv.ironOre < 3) {
        return mineResourceTaskSchema.parse({
          id: "autonomous:mine-iron-ore",
          kind: "mine_resource",
          resourceName: "iron_ore",
          targetCount: 3,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 30,
        });
      }

      // Need coal for fuel
      if (inv.coal < 3) {
        return mineResourceTaskSchema.parse({
          id: "autonomous:mine-coal",
          kind: "mine_resource",
          resourceName: "coal_ore",
          targetCount: 3,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 30,
        });
      }

      // Fallback: mine stone
      return mineResourceTaskSchema.parse({
        id: "autonomous:mine-stone-iron",
        kind: "mine_resource",
        resourceName: "stone",
        targetCount: 16,
        maxActions: MAX_AUTONOMOUS_ACTIONS,
        maxDurationMs: MAX_AUTONOMOUS_DURATION,
        maxExplorationLegs: 20,
      });
    }

    case "sustained-gathering": {
      // Maintain resource levels and continue gathering.
      // Food is handled by the food-security milestone when hunger drops.
      // Don't preempt gathering to stockpile food when hunger is fine.

      if (inv.cobblestone < 16) {
        return mineResourceTaskSchema.parse({
          id: "autonomous:sustain-stone",
          kind: "mine_resource",
          resourceName: "stone",
          targetCount: 16,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 20,
        });
      }

      if (inv.logs < 8) {
        return gatherResourceTaskSchema.parse({
          id: "autonomous:restock-logs",
          kind: "gather_resource",
          resourceName: "oak_log",
          targetCount: 8,
          maxActions: MAX_AUTONOMOUS_ACTIONS,
          maxDurationMs: MAX_AUTONOMOUS_DURATION,
          maxExplorationLegs: 16,
        });
      }

      // Default: mine stone
      return mineResourceTaskSchema.parse({
        id: "autonomous:mine-stone-default",
        kind: "mine_resource",
        resourceName: "stone",
        targetCount: 16,
        maxActions: MAX_AUTONOMOUS_ACTIONS,
        maxDurationMs: MAX_AUTONOMOUS_DURATION,
        maxExplorationLegs: 20,
      });
    }
  }
}
