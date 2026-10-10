/**
 * Shared Mineflayer double for the adapter tests. It exercises the real adapter code paths against a fake
 * bot; it does NOT prove compatibility with a Minecraft server (see docs/LIVE_VERIFICATION.md).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import pino from "pino";
import type { Bot, BotOptions } from "mineflayer";
import {
  DEFAULT_MINECRAFT_CONFIG,
  MinecraftAdapter,
  type MinecraftAdapterConfig,
} from "../../src/games/minecraft/minecraft-adapter.js";
import { minecraftObservationSchema } from "../../src/games/minecraft/observation.js";
import {
  MINECRAFT_HARVEST_BERRIES_CAPABILITY,
  MINECRAFT_PICKUP_ITEM_CAPABILITY,
  MINECRAFT_REST_CAPABILITY,
} from "../../src/games/minecraft/capabilities.js";

export class Vec {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {}

  offset(dx: number, dy: number, dz: number): Vec {
    return new Vec(this.x + dx, this.y + dy, this.z + dz);
  }

  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  clone(): Vec {
    return new Vec(this.x, this.y, this.z);
  }
  /** Mutating setter, as in the real `vec3`; the adapter uses it on clones. */
  set(x: number, y: number, z: number): Vec {
    return new Vec(x, y, z);
  }

  floored(): Vec {
    return new Vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }

  subtract(other: Vec): Vec {
    return new Vec(this.x - other.x, this.y - other.y, this.z - other.z);
  }
}

export interface MockBlock {
  name: string;
  type: number;
  boundingBox: string;
  age?: number;
  /** Mineflayer's block.diggable: false for bedrock-like blocks. Defaults to true. */
  diggable?: boolean;
  /** When true, canHarvest() needs a held item (a stand-in for a tool-tier requirement). Defaults to false. */
  requiresTool?: boolean;
}

export interface MockOptions {
  readonly gameMode?: string;
  /** `bot.player.gamemode`, the second live source Mineflayer keeps. */
  readonly playerGameMode?: number | string;
  readonly dimension?: string | number | null;
  /** Replaces `bot.game` entirely, e.g. `{}` as it is before the login packet is handled. */
  readonly game?: Record<string, unknown>;
  readonly health?: number;
  readonly food?: number;
  /** When true the session never sent an `update_health` packet, so the fields are absent. */
  readonly vitalsUnreported?: boolean;
  readonly oxygenLevel?: number | null;
  readonly isAlive?: boolean;
  readonly time?: { timeOfDay: number; day: number; isDay: boolean } | null;
  readonly regenerate?: boolean;
  /**
   * Per-block line-of-sight outcome, shaped like Mineflayer's `canSeeBlock`, which ends with
   * `raycastHit && raycastHit.position.equals(block.position)`:
   * "clear" → true (the ray reaches the block); "blocked" → false (the ray hit another block first);
   * "no-hit" → null (the ray hit nothing, so the expression short-circuits to null, not false).
   * Defaults to "clear" for every block.
   */
  readonly lineOfSight?: (block: { name: string; position: { x: number; y: number; z: number } }) => "clear" | "blocked" | "no-hit";
}

/** A navigation goal the double cannot path to (within the adapter's 48-block limit). */
export const NO_PATH_X = 40;
/** A navigation goal whose planning runs out of time (within the 48-block limit). */
export const PLAN_TIMEOUT_X = 41;

export function createLiveMock(options: MockOptions = {}) {
  const emitter = new EventEmitter();
  const player = { id: 1, name: "GameMind", type: "player", position: new Vec(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true };
  const blocks = new Map<string, MockBlock>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const inventory: Array<{ slot: number; name: string; type: number; count: number; metadata: null; durabilityUsed: null }> = [];
  const entities: Record<number, unknown> = { 1: player };
  let health = options.health ?? 20;
  let food = options.food ?? 20;
  const goals: unknown[] = [];

  const addItem = (name: string, count: number) => {
    const existing = inventory.find((stack) => stack.name === name);
    if (existing) existing.count += count;
    else inventory.push({ slot: inventory.length + 9, name, type: 1, count, metadata: null, durabilityUsed: null });
  };
  const countItem = (name: string) => inventory.filter((stack) => stack.name === name).reduce((sum, stack) => sum + stack.count, 0);

  const bot = Object.assign(emitter, {
    username: "GameMind",
    version: "1.20.4",
    entity: player,
    entities,
    // `game` is exactly what Mineflayer keeps: the login packet's fields, empty until that arrives.
    game: options.game ?? {
      ...(options.dimension === null ? {} : { dimension: options.dimension ?? "overworld" }),
      gameMode: options.gameMode ?? "survival",
      minY: -64,
      height: 384,
    },
    // Mineflayer's player list entry carries the raw mode id, independent of `bot.game.gameMode`.
    ...(options.playerGameMode === undefined ? {} : { player: { gamemode: options.playerGameMode } }),
    ...(options.time === null ? {} : { time: options.time ?? { timeOfDay: 6_000, day: 0, isDay: true } }),
    foodSaturation: options.vitalsUnreported ? undefined : 5,
    oxygenLevel: options.oxygenLevel === undefined ? 20 : options.oxygenLevel,
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    inventory: { items: () => inventory, slots: [] as unknown[], emptySlotCount: () => Math.max(0, 36 - inventory.length) },
    getEquipmentDestSlot: () => 0,
    blockAt: (position: { x: number; y: number; z: number }) => {
      const x = Math.floor(position.x);
      const y = Math.floor(position.y);
      const z = Math.floor(position.z);
      const stored = blocks.get(key(x, y, z));
      return {
        name: stored?.name ?? "air",
        type: stored?.type ?? 0,
        position: new Vec(x, y, z),
        boundingBox: stored?.boundingBox ?? "empty",
        hardness: 1,
        diggable: stored?.diggable ?? true,
        canHarvest: (heldType: number | null) => (stored?.requiresTool ? heldType !== null : true),
        getProperties: () => (stored?.age === undefined ? {} : { age: stored.age }),
      };
    },
    findBlocks: (search: { matching: (block: { name: string }) => boolean; maxDistance: number; count: number }) => {
      const found: Vec[] = [];
      for (const [position, block] of blocks) {
        if (!search.matching({ name: block.name })) continue;
        const [x = 0, y = 0, z = 0] = position.split(",").map(Number);
        const candidate = new Vec(x, y, z);
        if (candidate.distanceTo(player.position) <= search.maxDistance) found.push(candidate);
      }
      return found.sort((a, b) => a.distanceTo(player.position) - b.distanceTo(player.position)).slice(0, search.count);
    },
    canDigBlock: () => true,
    canSeeBlock: (block: { name: string; position: { x: number; y: number; z: number } }) => {
      const verdict = options.lineOfSight?.(block) ?? "clear";
      return verdict === "clear" ? true : verdict === "blocked" ? false : null;
    },
    activateBlock: async (block: { name: string; position: Vec }) => {
      const stored = blocks.get(key(block.position.x, block.position.y, block.position.z));
      if (stored?.name === "sweet_berry_bush" && (stored.age ?? 0) >= 2) {
        addItem("sweet_berries", 2);
        stored.age = 1;
      }
    },
    pathfinder: {
      // Mineflayer-faithful: when planning fails, goto() RESOLVES, and the planner reports the failure as a
      // path_update with an empty path and a status. The emit is asynchronous, as the real planner's is.
      goto: async (goal: { x: number; y: number; z: number; constructor: { name: string } }) => {
        goals.push(goal);
        if (goal.x === NO_PATH_X || goal.x === PLAN_TIMEOUT_X) {
          const status = goal.x === NO_PATH_X ? "noPath" : "timeout";
          // Mineflayer's goto() resolves from its own path_update listener, on a later tick (setTimeout 0): the
          // planner's event is seen first, and the promise settles after it.
          await new Promise<void>((resolve) => {
            setImmediate(() => {
              emitter.emit("path_update", { status, path: [] });
              setTimeout(resolve, 0);
            });
          });
          return;
        }
        player.position = new Vec(goal.x + 0.5, goal.y, goal.z + 0.5);
      },
      setGoal: () => undefined,
      setMovements: () => undefined,
      thinkTimeout: 1000,
    },
    collectBlock: { movements: undefined, collect: async () => undefined, cancelTask: async () => undefined },
    clearControlStates: () => undefined,
    stopDigging: () => undefined,
    look: async () => undefined,
    equip: async () => undefined,
    consume: async () => undefined,
    craft: async () => undefined,
    recipesFor: () => [],
    placeBlock: async () => undefined,
    quit: (reason = "quit") => queueMicrotask(() => emitter.emit("end", reason)),
    end: (reason = "end") => queueMicrotask(() => emitter.emit("end", reason)),
    registry: { itemsByName: {} },
  });

  // Accessors must be defined after Object.assign, which would otherwise copy their values once.
  Object.defineProperty(bot, "health", {
    configurable: true,
    get: () => {
      if (options.vitalsUnreported) return undefined;
      if (options.regenerate) health = Math.min(20, health + 1);
      return health;
    },
    set: (value: number) => {
      health = value;
    },
  });
  Object.defineProperty(bot, "food", {
    configurable: true,
    get: () => (options.vitalsUnreported ? undefined : food),
  });

  const addDrop = (name: string, count: number, x: number, z: number) => {
    const id = Object.keys(entities).length + 10;
    entities[id] = {
      id,
      name: "item",
      type: "other",
      position: new Vec(x, 64.2, z),
      velocity: new Vec(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      getDroppedItem: () => ({ name, count }),
    };
  };
  const addHostile = (x: number, z: number) => {
    const id = Object.keys(entities).length + 10;
    entities[id] = { id, name: "zombie", type: "hostile", position: new Vec(x, 64, z), velocity: new Vec(0, 0, 0), yaw: 0, pitch: 0, onGround: true, health: 20 };
  };
  return {
    bot: bot as unknown as Bot,
    blocks,
    inventory,
    addItem,
    countItem,
    addDrop,
    addHostile,
    goals,
    setPlayer: (x: number, y: number, z: number) => {
      player.position = new Vec(x, y, z);
    },
  };
}

export function config(overrides: Partial<MinecraftAdapterConfig> = {}): MinecraftAdapterConfig {
  return { ...DEFAULT_MINECRAFT_CONFIG, connectTimeoutMs: 200, ...overrides };
}

export async function connectAdapter(mock: ReturnType<typeof createLiveMock>, overrides: Partial<MinecraftAdapterConfig> = {}) {
  const logger = pino({ level: "silent" });
  const adapter = new MinecraftAdapter(logger, config(overrides), {
    botFactory: (_options: BotOptions) => {
      queueMicrotask(() => mock.bot.emit("spawn"));
      return mock.bot;
    },
    installPlugins: () => undefined,
    configureSafeMovements: () => undefined,
  });
  await adapter.connect();
  return adapter;
}

/**
 * Collects one log and returns how the adapter answered. The gate regression cares only that the answer is
 * not a refusal attributed to the session facts, so any other outcome (including a mock that never gained
 * the item) counts as "the gate stayed open".
 */
export async function attemptCollection(adapter: MinecraftAdapter, sessionId: string): Promise<{ code: string | null; message: string }> {
  try {
    const outcome = await adapter.executeAction(
      {
        actionId: randomUUID(),
        sessionId,
        capability: "minecraft.collect_block",
        input: { x: 6, y: 64, z: 5, blockName: "oak_log", dangerRadius: 8 },
      },
      new AbortController().signal,
    );
    return { code: null, message: String(outcome.confirmation ?? "executed") };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code ?? null, message: String(failure.message ?? error) };
  }
}

export async function run(adapter: MinecraftAdapter, capability: string, input: unknown) {
  const session = adapter.session;
  assert.ok(session);
  return adapter.executeAction({ actionId: randomUUID(), sessionId: session.id, capability, input }, new AbortController().signal);
}

