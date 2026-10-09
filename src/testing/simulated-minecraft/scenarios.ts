import type { SimBlockPlacement, SimHostilePlacement, SimItemPlacement, SimScheduledEvent, SimWorldDefinition } from "./world.js";

/** Builds a complete world definition with the common defaults; callers override what they vary. */
export function simulatedWorld(
  options: Partial<Omit<SimWorldDefinition, "player">> & {
    readonly seed: number;
    readonly player?: Partial<SimWorldDefinition["player"]>;
  },
): SimWorldDefinition {
  const { player, ...rest } = options;
  return {
    loadedRadius: 64,
    groundY: 63,
    placements: [],
    hostiles: [],
    items: [],
    stallCells: [],
    schedule: [],
    navigationStuckTimeoutMs: 10_000,
    ...rest,
    player: {
      x: 0,
      z: 0,
      health: 20,
      food: 20,
      inventory: [],
      ...player,
    },
  };
}

/** A tree trunk: logs stacked from the first block above the grass. */
export function treeAt(x: number, z: number, height = 4): SimBlockPlacement[] {
  return Array.from({ length: height }, (_, index) => ({ x, y: 64 + index, z, name: "oak_log" }));
}

export function logAt(x: number, z: number, name = "oak_log"): SimBlockPlacement {
  return { x, y: 64, z, name };
}

export function berryBushAt(x: number, z: number, age: number): SimBlockPlacement {
  return { x, y: 64, z, name: "sweet_berry_bush", age };
}

export function hostileAt(id: string, x: number, z: number, name = "zombie"): SimHostilePlacement {
  return { id, name, x, z };
}

export function dropAt(name: string, count: number, x: number, z: number): SimItemPlacement {
  return { name, count, x, z };
}

export type { SimScheduledEvent };
