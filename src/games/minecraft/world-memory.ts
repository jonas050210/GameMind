import type { MinecraftBlockPosition, MinecraftObservation, MinecraftVector } from "./observation.js";
import { distanceBetween, isResourceBlockName, isRipeBerryBush } from "./block-classes.js";
import { isMineableBlockName } from "./mining.js";
import { isMinecraftFoodName } from "./recipes.js";
import { isHostileMinecraftEntity } from "./threats.js";

/** Side length of a coverage cell in blocks. Coverage is tracked on a coarse grid, not per block. */
export const EXPLORATION_CELL_SIZE = 8;

/** Items closer than this are expected to be inside every observation's entity scan. */
const CERTAIN_ITEM_RADIUS = 12;
/** Hostiles stay in memory for this many observations after their last sighting. */
const HOSTILE_MEMORY_OBSERVATIONS = 6;

export interface BlockSighting {
  readonly key: string;
  readonly name: string;
  readonly position: MinecraftBlockPosition;
  /** `true`/`false` for sweet berry bushes when the observation reported their age; otherwise `null`. */
  readonly ripe: boolean | null;
  readonly lastSeenSequence: number;
}

export interface ItemSighting {
  readonly key: string;
  readonly name: string;
  readonly count: number;
  readonly position: MinecraftVector;
  readonly blockPosition: MinecraftBlockPosition;
  readonly lastSeenSequence: number;
}

export interface HostileSighting {
  readonly id: string;
  readonly name: string;
  readonly position: MinecraftVector;
  readonly distance: number;
  /** True when the entity came closer since the previous observation. */
  readonly approaching: boolean;
  readonly lastSeenObservation: number;
}

export interface MemoryUpdate {
  readonly added: number;
  readonly removed: number;
}

export interface MemorySummary {
  readonly observations: number;
  readonly resourceBlocks: Readonly<Record<string, number>>;
  /** Remembered mineable blocks. Optional so summaries from before mining support stay valid. */
  readonly minableBlocks?: number;
  readonly ripeBerryBushes: number;
  readonly foodItems: number;
  readonly exploredCells: number;
  readonly trackedHostiles: number;
}

export function blockKey(position: MinecraftBlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

export function coverageCellOf(value: number): number {
  return Math.floor(value / EXPLORATION_CELL_SIZE);
}

export function coverageCellKey(cellX: number, cellZ: number): string {
  return `${cellX},${cellZ}`;
}

export function coverageCellCenter(cellX: number, cellZ: number): { x: number; z: number } {
  return {
    x: cellX * EXPLORATION_CELL_SIZE + EXPLORATION_CELL_SIZE / 2,
    z: cellZ * EXPLORATION_CELL_SIZE + EXPLORATION_CELL_SIZE / 2,
  };
}

/** Half of a cell's diagonal: the largest distance from a cell center to any point in the cell. */
const CELL_HALF_DIAGONAL = (EXPLORATION_CELL_SIZE / 2) * Math.SQRT2;

/**
 * Marks every coverage cell that lies entirely inside a scan disk as explored. Testing only the cell
 * center would mark cells whose far corners were never within scan range.
 */
export function markCoverage(
  explored: Set<string>,
  center: { readonly x: number; readonly z: number },
  radius: number,
): void {
  const minCell = coverageCellOf(center.x - radius) - 1;
  const maxCell = coverageCellOf(center.x + radius) + 1;
  const minCellZ = coverageCellOf(center.z - radius) - 1;
  const maxCellZ = coverageCellOf(center.z + radius) + 1;
  for (let cellX = minCell; cellX <= maxCell; cellX += 1) {
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      const cell = coverageCellCenter(cellX, cellZ);
      if (Math.hypot(cell.x - center.x, cell.z - center.z) + CELL_HALF_DIAGONAL <= radius) {
        explored.add(coverageCellKey(cellX, cellZ));
      }
    }
  }
}

/**
 * Short-term belief about the world, built from successive observations.
 *
 * Sightings are only removed when the observation proves they are gone: a block inside a fully
 * known, non-truncated scan volume that is no longer reported. Unknown or truncated regions never
 * invalidate anything, so memory errs on the side of remembering a resource.
 */
export class WorldMemory {
  private readonly blocks = new Map<string, BlockSighting>();
  /**
   * Mineable stone and ore blocks are kept apart from resource blocks: they come from a different
   * scan with its own truncation, so "not seen again" means something different for each group.
   */
  private readonly mined = new Map<string, BlockSighting>();
  private readonly items = new Map<string, ItemSighting>();
  private readonly hostiles = new Map<string, HostileSighting>();
  private readonly explored = new Set<string>();
  private observationCount = 0;
  private lastSequence = Number.NEGATIVE_INFINITY;

  static fromObservation(state: MinecraftObservation, sequence = 0): WorldMemory {
    const memory = new WorldMemory();
    memory.observe(state, sequence);
    return memory;
  }

  get observations(): number {
    return this.observationCount;
  }

  /** Applies one observation. Repeated or older sequence numbers are ignored. */
  observe(state: MinecraftObservation, sequence: number): MemoryUpdate {
    if (sequence <= this.lastSequence) return { added: 0, removed: 0 };
    this.lastSequence = sequence;
    this.observationCount += 1;

    const player = state.player.position;
    markCoverage(this.explored, player, state.resourceScan.radius);

    let added = 0;
    let removed = 0;

    const presentBlocks = new Map<string, { name: string; position: MinecraftBlockPosition; ripe: boolean | null }>();
    for (const block of state.nearbyBlocks) {
      if (!isResourceBlockName(block.name)) continue;
      presentBlocks.set(blockKey(block.position), { name: block.name, position: block.position, ripe: null });
    }
    for (const sighting of state.resourceSightings) {
      const ripe = sighting.name === "sweet_berry_bush" && sighting.properties
        ? isRipeBerryBush(sighting.name, sighting.properties)
        : null;
      presentBlocks.set(blockKey(sighting.position), {
        name: sighting.name,
        position: sighting.position,
        ripe,
      });
    }
    for (const [key, present] of presentBlocks) {
      const previous = this.blocks.get(key);
      if (!previous) added += 1;
      this.blocks.set(key, {
        key,
        name: present.name,
        position: present.position,
        ripe: present.ripe ?? previous?.ripe ?? null,
        lastSeenSequence: sequence,
      });
    }
    for (const [key, sighting] of this.blocks) {
      if (sighting.lastSeenSequence === sequence) continue;
      if (this.provablyAbsent(sighting.position, state, "resource")) {
        this.blocks.delete(key);
        removed += 1;
      }
    }

    const presentMined = new Map<string, { name: string; position: MinecraftBlockPosition }>();
    for (const block of state.nearbyBlocks) {
      if (!isMineableBlockName(block.name)) continue;
      presentMined.set(blockKey(block.position), { name: block.name, position: block.position });
    }
    for (const sighting of state.minableSightings ?? []) {
      presentMined.set(blockKey(sighting.position), { name: sighting.name, position: sighting.position });
    }
    for (const [key, present] of presentMined) {
      if (!this.mined.has(key)) added += 1;
      this.mined.set(key, {
        key,
        name: present.name,
        position: present.position,
        ripe: null,
        lastSeenSequence: sequence,
      });
    }
    for (const [key, sighting] of this.mined) {
      if (sighting.lastSeenSequence === sequence) continue;
      if (this.provablyAbsent(sighting.position, state, "minable")) {
        this.mined.delete(key);
        removed += 1;
      }
    }

    const presentItems = new Map<string, Omit<ItemSighting, "lastSeenSequence">>();
    for (const drop of state.itemDrops) {
      const blockPosition = {
        x: Math.floor(drop.position.x),
        y: Math.floor(drop.position.y),
        z: Math.floor(drop.position.z),
      };
      const key = `${drop.name}@${blockKey(blockPosition)}`;
      presentItems.set(key, {
        key,
        name: drop.name,
        count: drop.count,
        position: drop.position,
        blockPosition,
      });
    }
    for (const [key, present] of presentItems) {
      if (!this.items.has(key)) added += 1;
      this.items.set(key, { ...present, lastSeenSequence: sequence });
    }
    for (const [key, item] of this.items) {
      if (item.lastSeenSequence === sequence) continue;
      if (distanceBetween(item.position, player) <= CERTAIN_ITEM_RADIUS) {
        this.items.delete(key);
        removed += 1;
      }
    }

    for (const entity of state.entities) {
      if (!isHostileMinecraftEntity(entity.name, entity.type)) continue;
      const previous = this.hostiles.get(entity.id);
      this.hostiles.set(entity.id, {
        id: entity.id,
        name: entity.name,
        position: entity.position,
        distance: entity.distance,
        approaching: previous !== undefined && entity.distance < previous.distance - 0.25,
        lastSeenObservation: this.observationCount,
      });
    }
    for (const [id, hostile] of this.hostiles) {
      if (this.observationCount - hostile.lastSeenObservation > HOSTILE_MEMORY_OBSERVATIONS) {
        this.hostiles.delete(id);
      }
    }

    return { added, removed };
  }

  /**
   * Blocks whose absence is proven by the most recent observation's complete scan volumes. The wide
   * scan has to be the one that actually looks for this class of block: a stone block missing from a
   * resource scan proves nothing, because that scan never searched for stone.
   */
  private provablyAbsent(
    position: MinecraftBlockPosition,
    state: MinecraftObservation,
    kind: "resource" | "minable",
  ): boolean {
    const region = state.sampledRegion;
    const inLocalCube =
      region.unknownCells === 0 &&
      !region.truncated &&
      Math.abs(position.x - region.center.x) <= region.radius &&
      Math.abs(position.z - region.center.z) <= region.radius &&
      Math.abs(position.y - region.center.y) <= region.verticalRadius;
    if (inLocalCube) return true;
    const scan = kind === "resource" ? state.resourceScan : state.minableScan;
    if (!scan) return false;
    return !scan.truncated && distanceBetween(position, scan.center) <= scan.radius;
  }

  /** Resource and table blocks, optionally restricted to block names. */
  blockSightings(names?: ReadonlySet<string>): BlockSighting[] {
    return [...this.blocks.values()].filter((sighting) => !names || names.has(sighting.name));
  }

  /** Remembered mineable blocks (stone, ore, terrain), optionally filtered by block name. */
  minableSightings(names?: ReadonlySet<string>): BlockSighting[] {
    return [...this.mined.values()].filter((sighting) => !names || names.has(sighting.name));
  }

  itemSightings(names?: ReadonlySet<string>): ItemSighting[] {
    return [...this.items.values()].filter((item) => !names || names.has(item.name));
  }

  foodItemSightings(): ItemSighting[] {
    return this.itemSightings().filter((item) => isMinecraftFoodName(item.name));
  }

  hostileSightings(): HostileSighting[] {
    return [...this.hostiles.values()];
  }

  isCellExplored(cellX: number, cellZ: number): boolean {
    return this.explored.has(coverageCellKey(cellX, cellZ));
  }

  isPointExplored(point: { readonly x: number; readonly z: number }): boolean {
    return this.isCellExplored(coverageCellOf(point.x), coverageCellOf(point.z));
  }

  get exploredCellCount(): number {
    return this.explored.size;
  }

  forgetBlock(key: string): boolean {
    return this.blocks.delete(key);
  }

  forgetItem(key: string): boolean {
    return this.items.delete(key);
  }

  /** Drops a remembered mineable block, e.g. after a dig proved it is gone. */
  forgetMinable(key: string): boolean {
    return this.mined.delete(key);
  }

  summary(): MemorySummary {
    const resourceBlocks: Record<string, number> = {};
    for (const sighting of this.blocks.values()) {
      resourceBlocks[sighting.name] = (resourceBlocks[sighting.name] ?? 0) + 1;
    }
    return {
      observations: this.observationCount,
      resourceBlocks,
      ripeBerryBushes: this.blockSightings(new Set(["sweet_berry_bush"])).filter((sighting) => sighting.ripe === true).length,
      foodItems: this.foodItemSightings().length,
      exploredCells: this.explored.size,
      trackedHostiles: this.hostiles.size,
      minableBlocks: this.mined.size,
    };
  }
}
