/**
 * A deterministic, offline Minecraft-like world used to exercise planning, exploration, food
 * seeking, stuck recovery and verification without a server. It models the properties that
 * matter to GameMind's control logic: a loaded-chunk boundary, bounded line-of-sight-free scans,
 * walking time, hostile pursuit, hunger and regeneration, dropped items and ripening berries.
 *
 * It is NOT a Minecraft implementation. Physics, mob AI, lighting, crafting grids and protocol
 * behaviour are simplified. Results from this world validate control logic only.
 */

import type { MinecraftObservation } from "../../games/minecraft/observation.js";
import { isResourceBlockName } from "../../games/minecraft/block-classes.js";
import { isMineableBlockName } from "../../games/minecraft/mining.js";

export const SIM_TICK_MS = 250;
/** Walking speed in blocks per second (close to vanilla walking). */
const WALK_BLOCKS_PER_SECOND = 4;
const HOSTILE_SPEED_BLOCKS_PER_SECOND = 2.6;
const HOSTILE_AGGRO_RADIUS = 8;
const HOSTILE_ATTACK_RANGE = 1.6;
const HOSTILE_DAMAGE = 2;
const HOSTILE_ATTACK_COOLDOWN_MS = 1_000;
const IDLE_HUNGER_PER_MS = 1 / 90_000;
const WALK_HUNGER_PER_BLOCK = 1 / 300;
const REGEN_INTERVAL_MS = 4_000;
const BERRY_GROWTH_INTERVAL_MS = 60_000;
const PICKUP_RADIUS = 1.2;
const LOCAL_RADIUS = 3;
const LOCAL_VERTICAL_RADIUS = 2;
const RESOURCE_SCAN_RADIUS = 24;
const ENTITY_RADIUS = 16;

export interface SimBlockPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly name: string;
  readonly age?: number;
}

export interface SimHostilePlacement {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

export interface SimItemPlacement {
  readonly name: string;
  readonly count: number;
  readonly x: number;
  readonly z: number;
}

export type SimScheduledEvent =
  | { readonly atMs: number; readonly type: "remove_block"; readonly x: number; readonly y: number; readonly z: number }
  | { readonly atMs: number; readonly type: "place_block"; readonly x: number; readonly y: number; readonly z: number; readonly name: string }
  | { readonly atMs: number; readonly type: "spawn_hostile"; readonly hostile: SimHostilePlacement }
  | { readonly atMs: number; readonly type: "spawn_item"; readonly item: SimItemPlacement };

export interface SimWorldDefinition {
  readonly seed: number;
  /** Blocks outside this square around the origin are unknown (not loaded). */
  readonly loadedRadius: number;
  /** y of the grass surface. The player stands one block above it. */
  readonly groundY: number;
  readonly placements: readonly SimBlockPlacement[];
  readonly hostiles: readonly SimHostilePlacement[];
  readonly items: readonly SimItemPlacement[];
  /** Cells where movement silently stalls; the adapter reports NAVIGATION_STUCK. */
  readonly stallCells: readonly { readonly x: number; readonly z: number }[];
  readonly player: {
    readonly x: number;
    readonly z: number;
    readonly health: number;
    readonly food: number;
    readonly inventory: readonly { readonly name: string; readonly count: number }[];
  };
  readonly schedule: readonly SimScheduledEvent[];
  readonly navigationStuckTimeoutMs: number;
  /** Ticks into the day cycle at the start of the run (Java Edition: night is 13000..22999). */
  readonly dayTicks?: number;
  /** Day-cycle ticks advanced per simulated second. 0 freezes the clock (the default). */
  readonly dayTicksPerSecond?: number;
  /** Distinct item stacks the player may hold. Reaching it makes pickups and mining fail with INVENTORY_FULL. */
  readonly maxInventoryStacks?: number;
  /** Hostile health overrides for scenarios; defaults to the vanilla value for the entity name. */
  readonly hostileHealth?: Readonly<Record<string, number>>;
}

export interface SimStack {
  slot: number;
  name: string;
  type: number;
  count: number;
  metadata: number | null;
  durabilityUsed: number | null;
}

interface SimHostile {
  readonly id: string;
  readonly name: string;
  x: number;
  z: number;
  readonly originX: number;
  readonly originZ: number;
  attackCooldownMs: number;
  health: number;
  readonly maxHealth: number;
}

interface SimItem {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  x: number;
  z: number;
}

export interface SimBlockView {
  readonly name: string;
  readonly boundingBox: "block" | "empty";
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

export class SimulatedActionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SimulatedActionError";
  }
}

const HOSTILE_HEALTH: Readonly<Record<string, number>> = {
  zombie: 20,
  skeleton: 20,
  spider: 16,
  creeper: 20,
  husk: 20,
  drowned: 20,
  enderman: 40,
};

const HOSTILE_DROPS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  zombie: { rotten_flesh: 1 },
  skeleton: { bone: 1 },
  spider: { string: 1 },
  creeper: { gunpowder: 1 },
};

export function simItemType(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 1_000 + (hash % 8_000);
}

/** Small deterministic PRNG (mulberry32) so every seed replays identically. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function cellKey(x: number, z: number): string {
  return `${x},${z}`;
}

function blockKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function horizontal(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export class SimulatedMinecraftWorld {
  private readonly blocks = new Map<string, { name: string; age: number | null }>();
  private readonly hostiles = new Map<string, SimHostile>();
  private readonly items = new Map<string, SimItem>();
  private readonly stallCellKeys: Set<string>;
  private readonly pending: SimScheduledEvent[];
  private readonly random: () => number;
  private readonly definition: SimWorldDefinition;
  private clockMs = 0;
  private berryGrowthAccumulatorMs = 0;
  private itemCounter = 0;
  private nextInventorySlot = 9;
  private readonly dayTicksStart: number;
  private readonly dayTicksPerSecond: number;
  readonly maxInventoryStacks: number;

  playerX: number;
  playerY: number;
  playerZ: number;
  health: number;
  food: number;
  readonly gameMode = "survival" as string;
  readonly dimension = "overworld" as string;
  readonly inventory: SimStack[] = [];
  /** Counters for evaluation metrics. */
  readonly stats = { ticksSimulated: 0, minHealth: Number.POSITIVE_INFINITY, damageTaken: 0, starvationTicks: 0 };

  constructor(definition: SimWorldDefinition) {
    this.definition = definition;
    this.random = seededRandom(definition.seed);
    for (const placement of definition.placements) {
      this.blocks.set(blockKey(placement.x, placement.y, placement.z), {
        name: placement.name,
        age: placement.age ?? (placement.name === "sweet_berry_bush" ? 3 : null),
      });
    }
    for (const hostile of definition.hostiles) this.addHostile(hostile);
    for (const item of definition.items) this.addItem(item.name, item.count, item.x, item.z);
    this.stallCellKeys = new Set(definition.stallCells.map((cell) => cellKey(cell.x, cell.z)));
    this.pending = [...definition.schedule].sort((left, right) => left.atMs - right.atMs);
    this.playerX = definition.player.x + 0.5;
    this.playerY = definition.groundY + 1;
    this.playerZ = definition.player.z + 0.5;
    this.health = definition.player.health;
    this.food = definition.player.food;
    for (const stack of definition.player.inventory) this.addToInventory(stack.name, stack.count);
    this.stats.minHealth = this.health;
    this.dayTicksStart = definition.dayTicks ?? 6_000;
    this.dayTicksPerSecond = definition.dayTicksPerSecond ?? 0;
    this.maxInventoryStacks = definition.maxInventoryStacks ?? 36;
  }

  /** Ticks into the day cycle; `isNight` follows the Java Edition night window. */
  get dayTicks(): number {
    const advanced = this.clockMs / 1_000 * this.dayTicksPerSecond;
    return Math.floor(this.dayTicksStart + advanced) % 24_000;
  }

  get dayNumber(): number {
    return Math.floor((this.dayTicksStart + (this.clockMs / 1_000) * this.dayTicksPerSecond) / 24_000);
  }

  get isNight(): boolean {
    const ticks = this.dayTicks;
    return ticks >= 13_000 && ticks < 23_000;
  }

  get nowMs(): number {
    return this.clockMs;
  }

  /** Seeded random draw in [0, 1). Consumers must draw in a deterministic order. */
  nextRandom(): number {
    return this.random();
  }

  get origin(): { x: number; z: number } {
    return { x: this.definition.player.x, z: this.definition.player.z };
  }

  get seed(): number {
    return this.definition.seed;
  }

  get navigationStuckTimeoutMs(): number {
    return this.definition.navigationStuckTimeoutMs;
  }

  /** Block at a coordinate: `null` when the chunk is not loaded (unknown), otherwise a view. */
  blockAt(x: number, y: number, z: number): SimBlockView | null {
    if (Math.abs(x) > this.definition.loadedRadius || Math.abs(z) > this.definition.loadedRadius) return null;
    const placed = this.blocks.get(blockKey(x, y, z));
    if (placed) {
      return {
        name: placed.name,
        boundingBox: placed.name === "air" ? "empty" : "block",
        properties: placed.age === null ? {} : { age: placed.age },
      };
    }
    if (y === this.definition.groundY) return { name: "grass_block", boundingBox: "block", properties: {} };
    if (y < this.definition.groundY) return { name: "stone", boundingBox: "block", properties: {} };
    return { name: "air", boundingBox: "empty", properties: {} };
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    return this.blockAt(x, y, z)?.boundingBox === "block";
  }

  setBlock(x: number, y: number, z: number, name: string | null): void {
    const key = blockKey(x, y, z);
    if (name === null) {
      if (y === this.definition.groundY) {
        this.blocks.set(key, { name: "air", age: null });
      } else {
        this.blocks.delete(key);
      }
      return;
    }
    this.blocks.set(key, { name, age: name === "sweet_berry_bush" ? 3 : null });
  }

  setBlockAge(x: number, y: number, z: number, age: number): void {
    const placed = this.blocks.get(blockKey(x, y, z));
    if (placed) this.blocks.set(blockKey(x, y, z), { ...placed, age });
  }

  /** Whether the player can stand at this grid cell (solid ground, two free blocks above). */
  isStandable(x: number, z: number): boolean {
    const groundY = this.definition.groundY;
    if (Math.abs(x) > this.definition.loadedRadius || Math.abs(z) > this.definition.loadedRadius) return false;
    return (
      this.isSolidAt(x, groundY, z) &&
      !this.isSolidAt(x, groundY + 1, z) &&
      !this.isSolidAt(x, groundY + 2, z)
    );
  }

  get standingY(): number {
    return this.definition.groundY + 1;
  }

  /** Breadth-first search over standable cells. Returns the list of cells after the start, or null. */
  findPath(
    goal: (x: number, z: number) => boolean,
    maxNodes = 40_000,
  ): { x: number; z: number }[] | null {
    const startX = Math.floor(this.playerX);
    const startZ = Math.floor(this.playerZ);
    if (goal(startX, startZ)) return [];
    const previous = new Map<string, string | null>([[cellKey(startX, startZ), null]]);
    const queue: Array<{ x: number; z: number }> = [{ x: startX, z: startZ }];
    let head = 0;
    while (head < queue.length && previous.size <= maxNodes) {
      const current = queue[head];
      head += 1;
      if (!current) break;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = current.x + dx;
        const nz = current.z + dz;
        const key = cellKey(nx, nz);
        if (previous.has(key) || !this.isStandable(nx, nz)) continue;
        previous.set(key, cellKey(current.x, current.z));
        if (goal(nx, nz)) {
          const path: Array<{ x: number; z: number }> = [];
          let walk: string | null | undefined = key;
          while (walk && walk !== cellKey(startX, startZ)) {
            const [px, pz] = walk.split(",").map(Number);
            path.push({ x: px ?? 0, z: pz ?? 0 });
            walk = previous.get(walk);
          }
          return path.reverse();
        }
        queue.push({ x: nx, z: nz });
      }
    }
    return null;
  }

  /**
   * Walks a path one cell at a time. Returns the cell where a hidden stall occurred, or null when
   * the path completed. Time, hunger, hostiles and pickups advance while walking.
   */
  walk(path: readonly { x: number; z: number }[], shouldStop: () => void): { stalledAt: { x: number; z: number } | null } {
    for (const cell of path) {
      shouldStop();
      if (this.stallCellKeys.has(cellKey(cell.x, cell.z))) {
        this.advance(this.definition.navigationStuckTimeoutMs, shouldStop);
        return { stalledAt: cell };
      }
      this.playerX = cell.x + 0.5;
      this.playerZ = cell.z + 0.5;
      this.playerY = this.standingY;
      this.advance(1_000 / WALK_BLOCKS_PER_SECOND, shouldStop, 1);
    }
    return { stalledAt: null };
  }

  /**
   * Advances the world clock by `ms`, running scheduled events, mobs, vitals and pickups.
   * `blocksWalked` is the distance covered during this span, spread evenly across its ticks.
   */
  advance(ms: number, shouldStop: () => void = () => undefined, blocksWalked = 0): void {
    let remaining = ms;
    const blocksPerMs = ms > 0 ? blocksWalked / ms : 0;
    while (remaining > 0) {
      shouldStop();
      const step = Math.min(SIM_TICK_MS, remaining);
      remaining -= step;
      this.clockMs += step;
      this.stats.ticksSimulated += 1;
      this.runSchedule();
      this.moveHostiles(step);
      this.updateVitals(step, blocksPerMs * step);
      this.growBerries(step);
      this.pickUpItems();
    }
  }

  private runSchedule(): void {
    while (this.pending[0] && this.pending[0].atMs <= this.clockMs) {
      const event = this.pending.shift();
      if (!event) break;
      if (event.type === "remove_block") this.setBlock(event.x, event.y, event.z, null);
      else if (event.type === "place_block") this.setBlock(event.x, event.y, event.z, event.name);
      else if (event.type === "spawn_hostile") this.addHostile(event.hostile);
      else this.addItem(event.item.name, event.item.count, event.item.x, event.item.z);
    }
  }

  private moveHostiles(stepMs: number): void {
    const seconds = stepMs / 1_000;
    for (const hostile of this.hostiles.values()) {
      hostile.attackCooldownMs = Math.max(0, hostile.attackCooldownMs - stepMs);
      const toPlayerX = this.playerX - hostile.x;
      const toPlayerZ = this.playerZ - hostile.z;
      const distance = Math.hypot(toPlayerX, toPlayerZ);
      if (distance <= HOSTILE_AGGRO_RADIUS) {
        if (distance > HOSTILE_ATTACK_RANGE) {
          const stride = Math.min(distance, HOSTILE_SPEED_BLOCKS_PER_SECOND * seconds);
          hostile.x += (toPlayerX / distance) * stride;
          hostile.z += (toPlayerZ / distance) * stride;
        }
        if (distance <= HOSTILE_ATTACK_RANGE && hostile.attackCooldownMs === 0) {
          this.damage(HOSTILE_DAMAGE);
          hostile.attackCooldownMs = HOSTILE_ATTACK_COOLDOWN_MS;
        }
      } else {
        const angle = this.random() * Math.PI * 2;
        const stride = 0.5 * seconds;
        const nextX = hostile.x + Math.cos(angle) * stride;
        const nextZ = hostile.z + Math.sin(angle) * stride;
        if (horizontal(nextX, nextZ, hostile.originX, hostile.originZ) <= 6) {
          hostile.x = nextX;
          hostile.z = nextZ;
        }
      }
    }
  }

  private damage(amount: number): void {
    this.health = Math.max(0, this.health - amount);
    this.stats.damageTaken += amount;
    this.stats.minHealth = Math.min(this.stats.minHealth, this.health);
  }

  private updateVitals(stepMs: number, blocksWalked: number): void {
    this.food = Math.max(0, this.food - stepMs * IDLE_HUNGER_PER_MS - blocksWalked * WALK_HUNGER_PER_BLOCK);
    const regenPerMs = 1 / REGEN_INTERVAL_MS;
    if (this.food >= 18 && this.health < 20) {
      this.health = Math.min(20, this.health + stepMs * regenPerMs);
    }
    if (this.food <= 0) {
      this.stats.starvationTicks += 1;
      this.damage((stepMs / REGEN_INTERVAL_MS));
    }
    this.stats.minHealth = Math.min(this.stats.minHealth, this.health);
  }

  private growBerries(stepMs: number): void {
    this.berryGrowthAccumulatorMs += stepMs;
    if (this.berryGrowthAccumulatorMs < BERRY_GROWTH_INTERVAL_MS) return;
    this.berryGrowthAccumulatorMs -= BERRY_GROWTH_INTERVAL_MS;
    for (const [key, block] of this.blocks) {
      if (block.name === "sweet_berry_bush" && block.age !== null && block.age < 3) {
        this.blocks.set(key, { ...block, age: block.age + 1 });
      }
    }
  }

  private pickUpItems(): void {
    for (const [id, item] of this.items) {
      if (Math.hypot(item.x - this.playerX, item.z - this.playerZ) > PICKUP_RADIUS) continue;
      if (this.isInventoryFull(item.name)) continue; // A full inventory leaves the drop on the ground.
      this.addToInventory(item.name, item.count);
      this.items.delete(id);
    }
  }

  private addHostile(hostile: SimHostilePlacement): void {
    const health = this.definition.hostileHealth?.[hostile.name] ?? HOSTILE_HEALTH[hostile.name] ?? 20;
    this.hostiles.set(hostile.id, {
      id: hostile.id,
      name: hostile.name,
      x: hostile.x + 0.5,
      z: hostile.z + 0.5,
      originX: hostile.x + 0.5,
      originZ: hostile.z + 0.5,
      attackCooldownMs: 0,
      health,
      maxHealth: health,
    });
  }

  /** Returns the hostile's health after the damage, or null when the id is unknown. */
  damageHostile(id: string, amount: number): { health: number; died: boolean } | null {
    const hostile = this.hostiles.get(id);
    if (!hostile) return null;
    hostile.health = Math.max(0, hostile.health - amount);
    const died = hostile.health <= 0;
    if (died) {
      this.hostiles.delete(id);
      for (const [name, count] of Object.entries(HOSTILE_DROPS[hostile.name] ?? {})) {
        this.addItem(name, count, Math.floor(hostile.x), Math.floor(hostile.z));
      }
    }
    return { health: hostile.health, died };
  }

  hostileById(id: string): { id: string; name: string; health: number; maxHealth: number; x: number; z: number } | null {
    const hostile = this.hostiles.get(id);
    if (!hostile) return null;
    return {
      id: hostile.id,
      name: hostile.name,
      health: hostile.health,
      maxHealth: hostile.maxHealth,
      x: hostile.x,
      z: hostile.z,
    };
  }

  addItem(name: string, count: number, x: number, z: number): void {
    this.itemCounter += 1;
    this.items.set(`item-${this.itemCounter}`, { id: `item-${this.itemCounter}`, name, count, x: x + 0.5, z: z + 0.5 });
  }

  findDropNear(name: string, x: number, z: number, radius: number): SimItem | null {
    for (const [id, item] of this.items) {
      if (item.name !== name) continue;
      if (Math.hypot(item.x - x, item.z - z) <= radius) return { ...item, id };
    }
    return null;
  }

  hostileEntities(): Array<{ id: string; name: string; x: number; z: number; health: number }> {
    return [...this.hostiles.values()].map((hostile) => ({
      id: hostile.id,
      name: hostile.name,
      x: hostile.x,
      z: hostile.z,
      health: hostile.health,
    }));
  }

  hostilesNear(x: number, y: number, z: number, radius: number): boolean {
    return [...this.hostiles.values()].some((hostile) => {
      const distance = Math.hypot(hostile.x - x, this.standingY - y, hostile.z - z);
      return distance <= radius;
    });
  }

  /** Solid, mineable block at a cell, or null when it is air/unknown/not solid. */
  mineableAt(x: number, y: number, z: number): string | null {
    const block = this.blockAt(x, y, z);
    if (!block || block.boundingBox !== "block") return null;
    return block.name;
  }

  countItem(name: string): number {
    return this.inventory.filter((stack) => stack.name === name).reduce((sum, stack) => sum + stack.count, 0);
  }

  /** True when no new stack can be added: every allowed slot already holds a different item. */
  isInventoryFull(name?: string): boolean {
    if (name !== undefined && this.inventory.some((stack) => stack.name === name)) return false;
    return this.inventory.length >= this.maxInventoryStacks;
  }

  addToInventory(name: string, count: number): void {
    const existing = this.inventory.find((stack) => stack.name === name);
    if (existing) {
      existing.count += count;
      return;
    }
    if (this.inventory.length >= this.maxInventoryStacks) {
      throw new SimulatedActionError(
        `Inventory holds ${this.inventory.length} stacks and cannot accept ${name}.`,
        "INVENTORY_FULL",
      );
    }
    this.inventory.push({
      slot: this.nextInventorySlot,
      name,
      type: simItemType(name),
      count,
      metadata: null,
      durabilityUsed: null,
    });
    this.nextInventorySlot = Math.min(44, this.nextInventorySlot + 1);
  }

  removeFromInventory(name: string, count: number): void {
    let remaining = count;
    for (let index = this.inventory.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const stack = this.inventory[index];
      if (!stack || stack.name !== name) continue;
      const take = Math.min(stack.count, remaining);
      stack.count -= take;
      remaining -= take;
      if (stack.count === 0) this.inventory.splice(index, 1);
    }
    if (remaining > 0) throw new SimulatedActionError(`Inventory is missing ${remaining} ${name}.`, "ITEM_NOT_IN_INVENTORY");
  }

  /** Observation parts. These are computed from the same data the live scanner would read. */
  localCube(): {
    blocks: MinecraftObservation["nearbyBlocks"];
    unknownCells: number;
    sampledCells: number;
    truncated: boolean;
  } {
    const centerX = Math.floor(this.playerX);
    const centerY = Math.floor(this.playerY);
    const centerZ = Math.floor(this.playerZ);
    let unknownCells = 0;
    let sampledCells = 0;
    const blocks: MinecraftObservation["nearbyBlocks"] = [];
    for (let dx = -LOCAL_RADIUS; dx <= LOCAL_RADIUS; dx += 1) {
      for (let dz = -LOCAL_RADIUS; dz <= LOCAL_RADIUS; dz += 1) {
        for (let dy = -LOCAL_VERTICAL_RADIUS; dy <= LOCAL_VERTICAL_RADIUS; dy += 1) {
          sampledCells += 1;
          const x = centerX + dx;
          const y = centerY + dy;
          const z = centerZ + dz;
          const block = this.blockAt(x, y, z);
          if (!block) {
            unknownCells += 1;
            continue;
          }
          if (block.name === "air") continue;
          blocks.push({
            position: { x, y, z },
            name: block.name,
            type: simItemType(block.name),
            boundingBox: block.boundingBox,
          });
        }
      }
    }
    return { blocks, unknownCells, sampledCells, truncated: false };
  }

  resourceSightings(limit: number): { blocks: MinecraftObservation["resourceSightings"]; truncated: boolean } {
    const found: MinecraftObservation["resourceSightings"] = [];
    for (const [key, block] of this.blocks) {
      if (!isResourceBlockName(block.name)) continue;
      const [x = 0, y = 0, z = 0] = key.split(",").map(Number);
      if (Math.abs(x) > this.definition.loadedRadius || Math.abs(z) > this.definition.loadedRadius) continue;
      const distance = Math.hypot(x + 0.5 - this.playerX, y + 0.5 - this.playerY, z + 0.5 - this.playerZ);
      if (distance > RESOURCE_SCAN_RADIUS) continue;
      found.push({
        name: block.name,
        position: { x, y, z },
        distance,
        ...(block.name === "sweet_berry_bush" && block.age !== null ? { properties: { age: block.age } } : {}),
      });
    }
    found.sort((left, right) => left.distance - right.distance || left.position.x - right.position.x || left.position.z - right.position.z);
    return { blocks: found.slice(0, limit), truncated: found.length > limit };
  }

  /** Mineable stone/ore blocks in range, using the same scan radius as the resource scan. */
  minableSightings(limit: number): { blocks: MinecraftObservation["minableSightings"]; truncated: boolean } {
    const found: NonNullable<MinecraftObservation["minableSightings"]> = [];
    for (const [key, block] of this.blocks) {
      if (!isMineableBlockName(block.name)) continue;
      const [x = 0, y = 0, z = 0] = key.split(",").map(Number);
      if (Math.abs(x) > this.definition.loadedRadius || Math.abs(z) > this.definition.loadedRadius) continue;
      const distance = Math.hypot(x + 0.5 - this.playerX, y + 0.5 - this.playerY, z + 0.5 - this.playerZ);
      if (distance > RESOURCE_SCAN_RADIUS) continue;
      found.push({ name: block.name, position: { x, y, z }, distance });
    }
    found.sort((left, right) => left.distance - right.distance || left.position.x - right.position.x);
    return { blocks: found.slice(0, limit), truncated: found.length > limit };
  }

  /** Number of hostiles within a radius; combat refuses to engage when more than one is near. */
  hostileCountNear(x: number, y: number, z: number, radius: number): number {
    return [...this.hostiles.values()].filter((hostile) => {
      const distance = Math.hypot(hostile.x - x, this.standingY - y, hostile.z - z);
      return distance <= radius;
    }).length;
  }

  entityList(): MinecraftObservation["entities"] {
    const entities: MinecraftObservation["entities"] = [];
    for (const hostile of this.hostiles.values()) {
      const distance = Math.hypot(hostile.x - this.playerX, this.playerY - this.standingY, hostile.z - this.playerZ);
      if (distance > ENTITY_RADIUS) continue;
      entities.push({
        id: hostile.id,
        name: hostile.name,
        type: "hostile",
        position: { x: hostile.x, y: this.standingY, z: hostile.z },
        distance,
        health: hostile.health,
      });
    }
    return entities.sort((left, right) => left.distance - right.distance).slice(0, 64);
  }

  itemDropList(): MinecraftObservation["itemDrops"] {
    const drops: MinecraftObservation["itemDrops"] = [];
    for (const item of this.items.values()) {
      const distance = Math.hypot(item.x - this.playerX, item.z - this.playerZ);
      if (distance > ENTITY_RADIUS) continue;
      drops.push({
        id: `drop-${item.x}-${item.z}-${item.name}`,
        name: item.name,
        count: item.count,
        position: { x: item.x, y: this.standingY + 0.2, z: item.z },
        distance,
      });
    }
    return drops.sort((left, right) => left.distance - right.distance).slice(0, 32);
  }

}
