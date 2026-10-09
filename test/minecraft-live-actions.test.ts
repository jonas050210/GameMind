/**
 * Control-flow tests for the live adapter's new observation and action paths, using a Mineflayer
 * double. They do NOT prove compatibility with a Minecraft server or with Mineflayer's real
 * behaviour; that requires the live checks in docs/LIVE_VERIFICATION.md.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pino from "pino";
import type { Bot, BotOptions } from "mineflayer";
import {
  DEFAULT_MINECRAFT_CONFIG,
  MinecraftAdapter,
  type MinecraftAdapterConfig,
} from "../src/games/minecraft/minecraft-adapter.js";
import {
  MINECRAFT_HARVEST_BERRIES_CAPABILITY,
  MINECRAFT_PICKUP_ITEM_CAPABILITY,
  MINECRAFT_REST_CAPABILITY,
} from "../src/games/minecraft/capabilities.js";

class Vec {
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

  floored(): Vec {
    return new Vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }

  subtract(other: Vec): Vec {
    return new Vec(this.x - other.x, this.y - other.y, this.z - other.z);
  }
}

interface MockBlock {
  name: string;
  type: number;
  boundingBox: string;
  age?: number;
}

interface MockOptions {
  readonly gameMode?: string;
  readonly health?: number;
  readonly food?: number;
  readonly regenerate?: boolean;
}

/** A navigation goal the double cannot path to (within the adapter's 48-block limit). */
const NO_PATH_X = 40;

function createLiveMock(options: MockOptions = {}) {
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
    game: { dimension: "overworld", gameMode: options.gameMode ?? "survival", minY: -64, height: 384 },
    foodSaturation: 5,
    oxygenLevel: 300,
    inventory: { items: () => inventory, slots: [] as unknown[] },
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
    canSeeBlock: () => true,
    activateBlock: async (block: { name: string; position: Vec }) => {
      const stored = blocks.get(key(block.position.x, block.position.y, block.position.z));
      if (stored?.name === "sweet_berry_bush" && (stored.age ?? 0) >= 2) {
        addItem("sweet_berries", 2);
        stored.age = 1;
      }
    },
    pathfinder: {
      goto: async (goal: { x: number; y: number; z: number; constructor: { name: string } }) => {
        goals.push(goal);
        if (goal.x === NO_PATH_X) {
          throw Object.assign(new Error("No path to the goal!"), { name: "NoPath" });
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
      if (options.regenerate) health = Math.min(20, health + 1);
      return health;
    },
    set: (value: number) => {
      health = value;
    },
  });
  Object.defineProperty(bot, "food", { configurable: true, get: () => food });

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

function config(overrides: Partial<MinecraftAdapterConfig> = {}): MinecraftAdapterConfig {
  return { ...DEFAULT_MINECRAFT_CONFIG, connectTimeoutMs: 200, ...overrides };
}

async function connectAdapter(mock: ReturnType<typeof createLiveMock>, overrides: Partial<MinecraftAdapterConfig> = {}) {
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

async function run(adapter: MinecraftAdapter, capability: string, input: unknown) {
  const session = adapter.session;
  assert.ok(session);
  return adapter.executeAction({ actionId: randomUUID(), sessionId: session.id, capability, input }, new AbortController().signal);
}

test("observation reports wide resource sightings, berry ages, and dropped items", async () => {
  const mock = createLiveMock();
  mock.blocks.set("12,64,0", { name: "oak_log", type: 1, boundingBox: "block" });
  mock.blocks.set("-6,64,4", { name: "sweet_berry_bush", type: 2, boundingBox: "block", age: 3 });
  mock.addDrop("bread", 1, 3.5, -2.5);
  const adapter = await connectAdapter(mock);
  const observation = await adapter.observe();
  const state = observation.state;

  assert.deepEqual(state.resourceScan.center, { x: 0, y: 64, z: 0 });
  assert.equal(state.resourceScan.truncated, false);
  const log = state.resourceSightings.find((sighting) => sighting.name === "oak_log");
  assert.ok(log, "the log beyond the 3-block cube is in the wide scan");
  const bush = state.resourceSightings.find((sighting) => sighting.name === "sweet_berry_bush");
  assert.deepEqual(bush?.properties, { age: 3 });
  assert.equal(state.itemDrops[0]?.name, "bread");
  assert.equal(state.itemDrops[0]?.count, 1);
  await adapter.disconnect("test");
});

test("wide resource scans report truncation when the limit is reached", async () => {
  const mock = createLiveMock();
  for (let index = 0; index < 5; index += 1) mock.blocks.set(`${10 + index},64,0`, { name: "oak_log", type: 1, boundingBox: "block" });
  const adapter = await connectAdapter(mock, { resourceScanLimit: 3 });
  const observation = await adapter.observe();
  assert.equal(observation.state.resourceSightings.length, 3);
  assert.equal(observation.state.resourceScan.truncated, true);
  await adapter.disconnect("test");
});

test("pickup walks to the observed drop and confirms the inventory gain", async () => {
  const mock = createLiveMock();
  mock.addDrop("bread", 1, 5.5, 0.5);
  const adapter = await connectAdapter(mock);
  // The double's pathfinder moves the player onto the goal, where a real drop would be collected.
  const originalGoto = mock.bot.pathfinder.goto as unknown as (goal: unknown) => Promise<void>;
  (mock.bot.pathfinder as { goto: unknown }).goto = async (goal: { x: number; y: number; z: number }) => {
    await originalGoto(goal);
    mock.addItem("bread", 1);
  };
  const outcome = await run(adapter, MINECRAFT_PICKUP_ITEM_CAPABILITY, { x: 5, y: 64, z: 0, itemName: "bread", dangerRadius: 6 });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.details?.inventoryAfter, 1);
  await adapter.disconnect("test");
});

test("pickup refuses when no dropped item of that name is observed at the requested position", async () => {
  const mock = createLiveMock();
  const adapter = await connectAdapter(mock);
  await assert.rejects(
    run(adapter, MINECRAFT_PICKUP_ITEM_CAPABILITY, { x: 5, y: 64, z: 0, itemName: "bread", dangerRadius: 6 }),
    (error: unknown) => (error as { code?: string }).code === "ITEM_DROP_NOT_FOUND",
  );
  await adapter.disconnect("test");
});

test("berry harvesting refuses unripe bushes and confirms a ripe harvest through the inventory", async () => {
  const mock = createLiveMock();
  mock.blocks.set("3,64,0", { name: "sweet_berry_bush", type: 2, boundingBox: "block", age: 1 });
  const adapter = await connectAdapter(mock);
  await assert.rejects(
    run(adapter, MINECRAFT_HARVEST_BERRIES_CAPABILITY, { x: 3, y: 64, z: 0, dangerRadius: 6 }),
    (error: unknown) => (error as { code?: string }).code === "BERRY_NOT_RIPE",
  );

  mock.blocks.set("3,64,0", { name: "sweet_berry_bush", type: 2, boundingBox: "block", age: 3 });
  const harvested = await run(adapter, MINECRAFT_HARVEST_BERRIES_CAPABILITY, { x: 3, y: 64, z: 0, dangerRadius: 6 });
  assert.equal(harvested.confirmed, true);
  assert.equal(mock.countItem("sweet_berries"), 2);
  assert.equal(harvested.details?.ageAfter, 1);
  await adapter.disconnect("test");
});

test("rest confirms a health increase observed during the rest window", async () => {
  const mock = createLiveMock({ health: 8, food: 20, regenerate: true });
  const adapter = await connectAdapter(mock);
  const outcome = await run(adapter, MINECRAFT_REST_CAPABILITY, { durationMs: 5_000, targetHealth: 12, dangerRadius: 6 });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.details?.stopReason, "target");
  await adapter.disconnect("test");
});

test("rest is interrupted by a visible hostile and reports a specific failure code", async () => {
  const mock = createLiveMock({ health: 8, food: 20 });
  mock.addHostile(2, 0.5);
  const adapter = await connectAdapter(mock);
  await assert.rejects(
    run(adapter, MINECRAFT_REST_CAPABILITY, { durationMs: 5_000, targetHealth: 16, dangerRadius: 6 }),
    (error: unknown) => (error as { code?: string }).code === "REST_INTERRUPTED_BY_THREAT",
  );
  await adapter.disconnect("test");
});

test("rest without a health increase is not confirmed when the window simply expires", async () => {
  const mock = createLiveMock({ health: 8, food: 10 });
  const adapter = await connectAdapter(mock);
  const outcome = await run(adapter, MINECRAFT_REST_CAPABILITY, { durationMs: 1_000, targetHealth: 16, dangerRadius: 6 });
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.details?.stopReason, "duration");
  await adapter.disconnect("test");
});

test("pathfinder planning failures are reported with stable action codes, not generic failures", async () => {
  const mock = createLiveMock();
  const adapter = await connectAdapter(mock);
  await assert.rejects(
    run(adapter, "minecraft.navigate", { x: NO_PATH_X, y: 64, z: 0, range: 1 }),
    (error: unknown) => (error as { code?: string }).code === "PATH_NOT_FOUND",
  );
  await adapter.disconnect("test");
});

test("resource-scan configuration is validated", () => {
  const logger = pino({ level: "silent" });
  assert.throws(
    () => new MinecraftAdapter(logger, config({ resourceScanRadius: 1 }), { botFactory: () => createLiveMock().bot }),
    /Resource scan radius/,
  );
  assert.throws(
    () => new MinecraftAdapter(logger, config({ resourceScanLimit: 0 }), { botFactory: () => createLiveMock().bot }),
    /Resource scan limit/,
  );
});

test("an unreadable dropped item or block state is skipped without failing the whole observation", async () => {
  const mock = createLiveMock();
  mock.blocks.set("3,64,0", { name: "sweet_berry_bush", type: 2, boundingBox: "block", age: 3 });
  mock.addDrop("bread", 1, 2.5, 0.5);
  const entities = mock.bot.entities as unknown as Record<number, unknown>;
  entities[99] = {
    id: 99,
    name: "item",
    type: "other",
    position: new Vec(4.5, 64.2, 0.5),
    velocity: new Vec(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    getDroppedItem: () => {
      throw new Error("unparsable item metadata");
    },
  };
  const adapter = await connectAdapter(mock);
  const observation = await adapter.observe();
  assert.equal(observation.state.itemDrops.length, 1, "the readable drop is kept and the broken one is skipped");
  assert.equal(observation.state.itemDrops[0]?.name, "bread");
  assert.ok(observation.state.resourceSightings.some((sighting) => sighting.name === "sweet_berry_bush"));
  await adapter.disconnect("test");
});
