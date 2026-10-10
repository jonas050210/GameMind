import { heldItems } from "./inventory-accounting.js";
import type { MinecraftObservation } from "./observation.js";
import { isMinecraftFoodName } from "./recipes.js";
import { bestWeapon } from "./combat.js";

/**
 * Tracks long-term progression milestones across task boundaries.
 * The autonomous loop queries this to decide what the next task should be,
 * and the Control Center displays the current milestone.
 *
 * Milestones are ordered by priority and the agent advances through them
 * as prerequisites are met. Once a milestone is complete, it stays complete.
 */

export type MilestoneId =
  | "food-security"
  | "wooden-tools"
  | "shelter"
  | "stone-age"
  | "iron-age"
  | "sustained-gathering";

export interface Milestone {
  readonly id: MilestoneId;
  readonly name: string;
  readonly description: string;
  readonly prerequisites: readonly string[];
  readonly completed: boolean;
}

export interface ProgressSnapshot {
  readonly currentMilestone: MilestoneId;
  readonly currentMilestoneName: string;
  readonly milestones: readonly Milestone[];
  readonly completedMilestones: readonly MilestoneId[];
  readonly inventory: {
    readonly logs: number;
    readonly planks: number;
    readonly sticks: number;
    readonly cobblestone: number;
    readonly stone: number;
    readonly coal: number;
    readonly ironOre: number;
    readonly ironIngot: number;
    readonly food: number;
    readonly hasWoodenPickaxe: boolean;
    readonly hasStonePickaxe: boolean;
    readonly hasIronPickaxe: boolean;
    readonly hasCraftingTable: boolean;
    readonly hasWeapon: boolean;
    readonly placeableBlocks: number;
  };
}

export class ProgressTracker {
  private completedMilestones = new Set<MilestoneId>();
  private lastInventory: ProgressSnapshot["inventory"] | null = null;

  getProgress(state: MinecraftObservation): ProgressSnapshot {
    const inv = this.countInventory(state);
    this.lastInventory = inv;

    // Evaluate milestone completion
    this.evaluateMilestones(inv, state);

    // Determine current milestone
    const currentId = this.getCurrentMilestone();
    const milestones = this.buildMilestoneList();

    return {
      currentMilestone: currentId,
      currentMilestoneName: this.getMilestoneName(currentId),
      milestones,
      completedMilestones: [...this.completedMilestones],
      inventory: inv,
    };
  }

  private countInventory(state: MinecraftObservation): ProgressSnapshot["inventory"] {
    // Equipped items count too: a pickaxe in the hand is still a pickaxe the agent holds.
    const items = heldItems(state);
    const count = (names: string[]) =>
      items.filter((i) => names.some((n) => i.name === n)).reduce((s, i) => s + i.count, 0);
    const has = (names: string[]) => items.some((i) => names.some((n) => i.name === n));

    return {
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
  }

  private evaluateMilestones(inv: ProgressSnapshot["inventory"], state: MinecraftObservation): void {
    // Food security: hunger bar is at least 14/20 — the agent has secured food.
    // Having food items in inventory is a prerequisite for securing food,
    // but the milestone is only complete when the hunger bar is actually full enough.
    const hungerOk = state.player.food === null || state.player.food >= 14;
    if (hungerOk) {
      this.completedMilestones.add("food-security");
    }

    // Wooden tools: have at least a wooden pickaxe
    if (inv.hasWoodenPickaxe) {
      this.completedMilestones.add("wooden-tools");
    }

    // Shelter: cardinal shelter check would require state analysis; for now mark if placeable blocks exist
    // In practice this is checked by the shelter skill postcondition

    // Stone age: have stone pickaxe
    if (inv.hasStonePickaxe) {
      this.completedMilestones.add("stone-age");
    }

    // Iron age: have iron pickaxe
    if (inv.hasIronPickaxe) {
      this.completedMilestones.add("iron-age");
    }
  }

  private getCurrentMilestone(): MilestoneId {
    const order: MilestoneId[] = [
      "food-security",
      "wooden-tools",
      "shelter",
      "stone-age",
      "iron-age",
      "sustained-gathering",
    ];

    for (const id of order) {
      if (!this.completedMilestones.has(id)) {
        return id;
      }
    }
    return "sustained-gathering";
  }

  private getMilestoneName(id: MilestoneId): string {
    const names: Record<MilestoneId, string> = {
      "food-security": "Secure Food",
      "wooden-tools": "Craft Wooden Tools",
      "shelter": "Build Shelter",
      "stone-age": "Advance to Stone Age",
      "iron-age": "Advance to Iron Age",
      "sustained-gathering": "Sustained Resource Gathering",
    };
    return names[id];
  }

  private buildMilestoneList(): Milestone[] {
    const definitions: { id: MilestoneId; name: string; description: string; prerequisites: string[] }[] = [
      {
        id: "food-security",
        name: "Secure Food",
        description: "Maintain hunger ≥ 14 with food in inventory",
        prerequisites: [],
      },
      {
        id: "wooden-tools",
        name: "Craft Wooden Tools",
        description: "Gather 4 logs → planks → sticks → crafting table → wooden pickaxe",
        prerequisites: ["4 logs", "crafting knowledge"],
      },
      {
        id: "shelter",
        name: "Build Shelter",
        description: "Build cardinal shelter when night approaches",
        prerequisites: ["4+ placeable blocks"],
      },
      {
        id: "stone-age",
        name: "Advance to Stone Age",
        description: "Mine 8 cobblestone → craft stone pickaxe",
        prerequisites: ["wooden pickaxe", "8 cobblestone"],
      },
      {
        id: "iron-age",
        name: "Advance to Iron Age",
        description: "Craft furnace → smelt iron → craft iron pickaxe",
        prerequisites: ["stone pickaxe", "furnace", "iron ore", "fuel"],
      },
      {
        id: "sustained-gathering",
        name: "Sustained Resource Gathering",
        description: "Continuous resource collection and crafting",
        prerequisites: ["stone-age"],
      },
    ];

    return definitions.map((def) => ({
      ...def,
      completed: this.completedMilestones.has(def.id),
    }));
  }

  /** Serialize for persistence */
  toJSON(): { completedMilestones: string[] } {
    return {
      completedMilestones: [...this.completedMilestones],
    };
  }

  /** Restore from persistence */
  static fromJSON(data: unknown): ProgressTracker {
    const tracker = new ProgressTracker();
    if (typeof data === "object" && data !== null && "completedMilestones" in data) {
      const raw = data as { completedMilestones: unknown };
      if (Array.isArray(raw.completedMilestones)) {
        for (const id of raw.completedMilestones) {
          if (typeof id === "string") {
            tracker.completedMilestones.add(id as MilestoneId);
          }
        }
      }
    }
    return tracker;
  }
}
