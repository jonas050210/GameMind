import type { MinecraftObservation } from "./observation.js";

/**
 * One definition of "what the agent holds". The inventory window and the equipment slots overlap in
 * Mineflayer (an equipped tool is also in the window), so each slot is counted once. Every component that
 * decides whether a milestone or a task target is met must read through here: a planner that counted only
 * the window once believed an equipped pickaxe was missing, regenerated the craft task, and completed it
 * with zero actions forever.
 */
export interface HeldItem {
  readonly name: string;
  readonly count: number;
}

export function heldItems(state: Pick<MinecraftObservation, "inventory" | "equipment">): HeldItem[] {
  const items: HeldItem[] = state.inventory.map((item) => ({ name: item.name, count: item.count }));
  const occupied = new Set(state.inventory.map((item) => item.slot));
  for (const item of Object.values(state.equipment)) {
    if (!item || occupied.has(item.slot)) continue;
    occupied.add(item.slot);
    items.push({ name: item.name, count: item.count });
  }
  return items;
}

export function heldCount(state: Pick<MinecraftObservation, "inventory" | "equipment">, names: readonly string[]): number {
  return heldItems(state)
    .filter((item) => names.includes(item.name))
    .reduce((sum, item) => sum + item.count, 0);
}

export function holds(state: Pick<MinecraftObservation, "inventory" | "equipment">, names: readonly string[]): boolean {
  return heldItems(state).some((item) => names.includes(item.name));
}
