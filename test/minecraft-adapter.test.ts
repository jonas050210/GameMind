import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import pino, { type Logger } from "pino";
import type { Bot, BotOptions } from "mineflayer";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import {
  DEFAULT_MINECRAFT_CONFIG,
  MinecraftAdapter,
  minecraftAdapterConfigFromEnv,
  type MinecraftAdapterConfig,
  type MinecraftBotFactory,
} from "../src/games/minecraft/minecraft-adapter.js";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";

class MockVector {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {}

  offset(x: number, y: number, z: number): MockVector {
    return new MockVector(this.x + x, this.y + y, this.z + z);
  }

  distanceTo(other: MockVector): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  clone(): MockVector {
    return new MockVector(this.x, this.y, this.z);
  }

  subtract(other: MockVector): MockVector {
    return new MockVector(this.x - other.x, this.y - other.y, this.z - other.z);
  }
}

function createMockBot(
  autoSpawn: boolean,
  startingFood = 20,
  navigationStalls = false,
  collectionStalls = false,
): Bot {
  const emitter = new EventEmitter();
  const playerEntity = {
    id: 1,
    name: "GameMind",
    type: "player",
    position: new MockVector(0.5, 64, 0.5),
    velocity: new MockVector(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    isValid: true,
  };
  const cow = {
    id: 2,
    name: "cow",
    type: "mob",
    position: new MockVector(2.5, 64, 0.5),
    velocity: new MockVector(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 10,
    isValid: true,
  };
  const inventoryItems: Array<{
    slot: number;
    name: string;
    type: number;
    count: number;
    metadata: number | null;
    durabilityUsed: number | null;
  }> = [];
  const inventorySlots: unknown[] = Array.from({ length: 46 }, () => null);
  let hungerLevel = startingFood;
  const itemNames = [
    "oak_log", "oak_planks", "birch_planks", "stick", "crafting_table",
    "wooden_pickaxe", "wooden_axe", "wooden_shovel", "wooden_sword", "apple",
  ];
  const itemTypes = new Map(itemNames.map((name, index) => [name, 1_000 + index]));
  const nameForType = new Map([...itemTypes].map(([name, id]) => [id, name]));
  const removeInventory = (name: string, count: number): void => {
    let remaining = count;
    for (let index = 0; index < inventoryItems.length && remaining > 0; index += 1) {
      const stack = inventoryItems[index];
      if (!stack || stack.name !== name) continue;
      const take = Math.min(remaining, stack.count);
      remaining -= take;
      if (stack.count === take) {
        inventoryItems.splice(index, 1);
        index -= 1;
      } else inventoryItems[index] = { ...stack, count: stack.count - take };
    }
    if (remaining > 0) throw new Error(`Mock inventory missing ${name}.`);
  };
  const addInventory = (name: string, count: number): void => {
    const current = inventoryItems.find((item) => item.name === name);
    if (current) current.count += count;
    else inventoryItems.push({
      slot: inventoryItems.reduce((max, item) => Math.max(max, item.slot), 8) + 1,
      name,
      type: itemTypes.get(name) ?? 2_000,
      count,
      metadata: null,
      durabilityUsed: null,
    });
  };
  const blocks = new Map<string, { name: string; type: number; boundingBox: string }>([
    ["0,63,0", { name: "grass_block", type: 2, boundingBox: "block" }],
    ["2,64,0", { name: "oak_log", type: 17, boundingBox: "block" }],
  ]);
  const blockKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const destinationSlots: Record<string, number> = {
    hand: 36,
    "off-hand": 45,
    head: 5,
    torso: 6,
    legs: 7,
    feet: 8,
  };
  const botLike = Object.assign(emitter, {
    __blocks: blocks,
    username: "GameMind",
    version: "1.20.4",
    entity: playerEntity,
    entities: { 1: playerEntity, 2: cow },
    // prismarine-world currently returns these chunk coordinates as strings at runtime.
    world: { getColumns: () => [
      { chunkX: "0", chunkZ: "0" },
      { chunkX: "-1", chunkZ: "0" },
      { chunkX: "not-a-coordinate", chunkZ: "0" },
      { chunkX: "-3", chunkZ: "2" },
    ] },
    game: { dimension: "overworld", gameMode: "survival" },
    health: 20,
    food: 20,
    foodSaturation: 5,
    registry: {
      itemsByName: Object.fromEntries([...itemTypes].map(([name, id]) => [name, { id }])),
    },
    recipesFor: (itemType: number, _metadata: number | null, _minCount: number | null, _table: unknown) => {
      const name = nameForType.get(itemType) ?? "unknown";
      const count = name.endsWith("_planks") || name === "stick" ? 4 : 1;
      const requiresTable = name.startsWith("wooden_");
      return [{ result: { id: itemType, count }, requiresTable }];
    },
    craft: async (recipe: { result: { id: number; count: number }; requiresTable: boolean }, runs = 1) => {
      const name = nameForType.get(recipe.result.id) ?? "unknown";
      const outputCount = recipe.result.count * runs;
      if (name === "oak_planks") removeInventory("oak_log", runs);
      if (name === "stick") removeInventory("oak_planks", runs * 2);
      if (name === "crafting_table") removeInventory("oak_planks", runs * 4);
      if (name === "wooden_pickaxe") {
        removeInventory("oak_planks", runs * 3);
        removeInventory("stick", runs * 2);
      }
      addInventory(name, outputCount);
    },
    consume: async () => {
      const held = inventorySlots[36] as { name?: string; count?: number } | null;
      if (!held || held.name !== "apple") throw new Error("Mock held item is not edible.");
      hungerLevel = Math.min(20, hungerLevel + 4);
      if ((held.count ?? 0) > 1) inventorySlots[36] = { ...held, count: (held.count ?? 0) - 1 };
      else inventorySlots[36] = null;
    },
    canSeeBlock: () => true,
    placeBlock: async (referenceBlock: { position: MockVector }, faceVector: MockVector) => {
      const target = referenceBlock.position.offset(faceVector.x, faceVector.y, faceVector.z);
      const held = inventorySlots[36] as { name?: string; count?: number } | null;
      if (!held || held.name !== "crafting_table") throw new Error("Mock held item is not a crafting table.");
      blocks.set(blockKey(target.x, target.y, target.z), {
        name: "crafting_table",
        type: itemTypes.get("crafting_table") ?? 2_000,
        boundingBox: "block",
      });
      inventorySlots[36] = null;
    },
    oxygenLevel: 300,
    inventory: {
      items: () => inventoryItems,
      slots: inventorySlots,
    },
    getEquipmentDestSlot: (destination: string) => destinationSlots[destination] ?? 0,
    blockAt: (position: MockVector) => {
      const x = Math.floor(position.x);
      const y = Math.floor(position.y);
      const z = Math.floor(position.z);
      const stored = blocks.get(blockKey(x, y, z));
      return {
        name: stored?.name ?? "air",
        type: stored?.type ?? 0,
        position: new MockVector(x, y, z),
        boundingBox: stored?.boundingBox ?? "empty",
        hardness: stored ? 1 : 0,
      };
    },
    canDigBlock: () => true,
    pathfinder: {
      goto: (goal: { x: number; y: number; z: number }) => {
        if (navigationStalls) return new Promise<void>(() => undefined);
        playerEntity.position = new MockVector(goal.x + 0.5, goal.y, goal.z + 0.5);
        return Promise.resolve();
      },
      setGoal: () => undefined,
      stop: () => undefined,
    },
    collectBlock: {
      movements: undefined,
      collect: async (block: { position: MockVector; name: string; type: number }) => {
        if (collectionStalls) return new Promise<void>(() => undefined);
        const { x, y, z } = block.position;
        blocks.delete(blockKey(x, y, z));
        inventoryItems.push({
          slot: inventoryItems.length + 9,
          name: block.name,
          type: block.type,
          count: 1,
          metadata: null,
          durabilityUsed: null,
        });
        playerEntity.position = new MockVector(x + 0.5, y + 1, z + 0.5);
      },
      cancelTask: async () => undefined,
    },
    look: async (yaw: number, pitch: number, _force?: boolean) => {
      playerEntity.yaw = yaw;
      playerEntity.pitch = pitch;
      queueMicrotask(() => emitter.emit("move", playerEntity.position));
    },
    equip: async (item: { name: string; type: number; count: number; slot: number }, destination: string) => {
      const itemIndex = inventoryItems.findIndex((candidate) => candidate === item);
      if (itemIndex >= 0) inventoryItems.splice(itemIndex, 1);
      const slot = destinationSlots[destination] ?? 0;
      const equipped = { ...item, slot, count: 1 };
      inventorySlots[slot] = equipped;
    },
    clearControlStates: () => undefined,
    stopDigging: () => undefined,
    quit: (reason = "quit") => queueMicrotask(() => emitter.emit("end", reason)),
    end: (reason = "end") => queueMicrotask(() => emitter.emit("end", reason)),
  });
  Object.defineProperty(botLike, "food", { configurable: true, get: () => hungerLevel });
  const bot = botLike as unknown as Bot;
  if (autoSpawn) queueMicrotask(() => bot.emit("spawn"));
  return bot;
}

function seedInventory(bot: Bot, name: string, count: number, type = 1_000): void {
  const inventory = bot.inventory.items() as unknown as Array<{
    slot: number;
    name: string;
    type: number;
    count: number;
    metadata: number | null;
    durabilityUsed: number | null;
  }>;
  inventory.push({
    slot: inventory.reduce((max, item) => Math.max(max, item.slot), 8) + 1,
    name,
    type,
    count,
    metadata: null,
    durabilityUsed: null,
  });
}

function config(overrides: Partial<MinecraftAdapterConfig> = {}): MinecraftAdapterConfig {
  return { ...DEFAULT_MINECRAFT_CONFIG, connectTimeoutMs: 100, ...overrides };
}

function createTestAdapter(
  logger: Logger,
  botFactory: MinecraftBotFactory,
  configuration = config(),
): MinecraftAdapter {
  return new MinecraftAdapter(logger, configuration, {
    botFactory,
    installPlugins: () => undefined,
    configureSafeMovements: () => undefined,
  });
}

test("automatic respawn defaults on, is configurable from the environment, and rejects invalid values", () => {
  assert.equal(minecraftAdapterConfigFromEnv({}).autoRespawn, true);
  assert.equal(minecraftAdapterConfigFromEnv({ MINECRAFT_AUTO_RESPAWN: "false" }).autoRespawn, false);
  assert.equal(minecraftAdapterConfigFromEnv({ MINECRAFT_AUTO_RESPAWN: "TRUE" }).autoRespawn, true);
  assert.throws(
    () => minecraftAdapterConfigFromEnv({ MINECRAFT_AUTO_RESPAWN: "sometimes" }),
    /MINECRAFT_AUTO_RESPAWN must be 'true' or 'false'/,
  );
});

test("Minecraft adapter connects, structures observations, executes and confirms look, then shuts down", async () => {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const bot = createMockBot(true);
  const factory: MinecraftBotFactory = (_options: BotOptions) => bot;
  const adapter = createTestAdapter(logger, factory);
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);

  const session = await runtime.connect();
  assert.equal(session.gameId, "minecraft-java");
  assert.equal(session.gameVersion, "1.20.4");
  const initial = runtime.currentWorldState;
  assert.ok(initial);
  assert.equal(initial.state.player.health, 20);
  assert.equal(initial.state.entities[0]?.name, "cow");
  // Resource and table blocks are listed first so that the capped local sample never drops them.
  assert.equal(initial.state.nearbyBlocks[0]?.name, "oak_log");
  assert.ok(initial.state.nearbyBlocks.some((block) => block.name === "grass_block"));
  assert.equal(initial.state.sampledRegion.sampledCells, 605);
  assert.equal(initial.state.sampledRegion.center.x, 0);
  assert.equal(initial.state.sampledRegion.verticalRadius, 2);
  assert.deepEqual(initial.state.resourceSightings, []);
  assert.deepEqual(initial.state.resourceScan.loadedChunks, [{ x: 0, z: 0 }, { x: -1, z: 0 }]);
  assert.deepEqual(initial.state.minableScan?.loadedChunks, [{ x: 0, z: 0 }, { x: -1, z: 0 }]);
  assert.deepEqual(initial.state.itemDrops, []);

  const result = await skills.run("minecraft.orient", { yaw: Math.PI / 2, pitch: 0.1 });
  assert.equal(result.action.status, "succeeded");
  assert.equal(result.action.confirmed, true);
  assert.equal(result.action.confirmation, "mineflayer_client_rotation_matches_request");
  assert.ok(Math.abs((result.observationAfter?.state.player.orientation.yaw ?? 0) - Math.PI / 2) < 1e-9);

  await runtime.shutdown("adapter test finished");
  assert.equal(adapter.status, "disconnected");
});

test("Minecraft inspect, bounded navigation, single-log collection, and equip confirm observed post-state", async () => {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const bot = createMockBot(true);
  const factory: MinecraftBotFactory = (_options: BotOptions) => bot;
  const adapter = createTestAdapter(logger, factory);
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  await runtime.connect();

  const inspected = await skills.run("minecraft.inspect-block", { x: 0, y: 63, z: 0 });
  assert.equal(inspected.action.status, "succeeded");
  assert.equal(inspected.action.confirmation, "local_block_state_read");
  assert.equal(inspected.action.details?.name, "grass_block");

  const navigated = await skills.run("minecraft.navigate", { x: 3, y: 64, z: 3, range: 1 });
  assert.equal(navigated.action.status, "succeeded");
  assert.equal(navigated.action.confirmation, "pathfinder_goal_reached_and_position_checked");
  assert.deepEqual(navigated.observationAfter?.state.player.position, { x: 3.5, y: 64, z: 3.5 });

  const collected = await skills.run("minecraft.collect-log", {
    x: 2,
    y: 64,
    z: 0,
    blockName: "oak_log",
  });
  assert.equal(collected.action.status, "succeeded");
  assert.equal(collected.action.confirmed, true);
  assert.equal(collected.action.confirmation, "target_block_removed_and_inventory_delta_checked");
  assert.equal(collected.action.details?.blockRemoved, true);
  assert.equal(collected.action.details?.inventoryGained, true);
  assert.equal(collected.action.details?.inventoryBefore, 0);
  assert.equal(collected.action.details?.inventoryAfter, 1);
  assert.equal(collected.observationAfter?.state.inventory[0]?.name, "oak_log");
  assert.equal(
    collected.observationAfter?.state.nearbyBlocks.some((block) => block.position.x === 2 && block.name === "oak_log"),
    false,
  );

  const equipped = await skills.run("minecraft.equip-item", {
    item: "oak_log",
    destination: "head",
  });
  assert.equal(equipped.action.status, "succeeded");
  assert.equal(equipped.action.confirmed, true);
  assert.equal(equipped.observationAfter?.state.equipment.head?.name, "oak_log");

  await runtime.shutdown("extended adapter test finished");
});

test("Minecraft crafting, eating, and crafting-table placement require and confirm observed state changes", async () => {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const bot = createMockBot(true, 5);
  seedInventory(bot, "oak_log", 1, 17);
  seedInventory(bot, "apple", 1, 1_009);
  seedInventory(bot, "crafting_table", 1, 1_004);
  const internalBlocks = (bot as unknown as {
    __blocks: Map<string, { name: string; type: number; boundingBox: string }>;
  }).__blocks;
  internalBlocks.set("-1,63,0", { name: "grass_block", type: 2, boundingBox: "block" });
  const adapter = createTestAdapter(logger, () => bot);
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  await runtime.connect();

  const crafted = await skills.run("minecraft.craft-item", { item: "oak_planks", count: 4 });
  assert.equal(crafted.action.status, "succeeded");
  assert.equal(crafted.action.confirmed, true);
  assert.equal(crafted.observationAfter?.state.inventory.find((item) => item.name === "oak_planks")?.count, 4);
  assert.equal(crafted.observationAfter?.state.inventory.some((item) => item.name === "oak_log"), false);

  const eaten = await skills.run("minecraft.eat-food", { item: "apple" });
  assert.equal(eaten.action.status, "succeeded");
  assert.equal(eaten.action.confirmed, true);
  assert.equal(eaten.observationAfter?.state.player.food, 9);
  assert.equal(eaten.observationAfter?.state.inventory.some((item) => item.name === "apple"), false);

  const placed = await skills.run("minecraft.place-crafting-table", { x: -1, y: 64, z: 0 });
  assert.equal(placed.action.status, "succeeded");
  assert.equal(placed.action.confirmed, true);
  assert.equal(
    placed.observationAfter?.state.nearbyBlocks.some((block) =>
      block.name === "crafting_table" && block.position.x === -1 && block.position.y === 64,
    ),
    true,
  );
  assert.equal(placed.observationAfter?.state.inventory.some((item) => item.name === "crafting_table"), false);

  await runtime.shutdown("craft/eat/place action test finished");
});

test("live adapter rechecks visible hostile proximity immediately before collection and placement", async () => {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const bot = createMockBot(true);
  seedInventory(bot, "crafting_table", 1, 1_004);
  const world = bot as unknown as {
    entities: Record<number, { id: number; name: string; type: string; position: MockVector }>;
    __blocks: Map<string, { name: string; type: number; boundingBox: string }>;
  };
  world.entities[3] = { id: 3, name: "zombie", type: "hostile", position: new MockVector(2.5, 64, 0.5) };
  world.__blocks.set("-1,63,0", { name: "grass_block", type: 2, boundingBox: "block" });
  const adapter = createTestAdapter(logger, () => bot);
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  await runtime.connect();

  const collection = await skills.run("minecraft.collect-log", {
    x: 2,
    y: 64,
    z: 0,
    blockName: "oak_log",
  });
  assert.equal(collection.action.status, "failed");
  assert.equal(collection.action.failure?.code, "RESOURCE_TARGET_THREATENED");
  assert.equal(collection.observationAfter?.state.inventory.length, 1);

  const placement = await skills.run("minecraft.place-crafting-table", { x: -1, y: 64, z: 0 });
  assert.equal(placement.action.status, "failed");
  assert.equal(placement.action.failure?.code, "PLACEMENT_TARGET_THREATENED");
  assert.equal(
    placement.observationAfter?.state.nearbyBlocks.some((block) => block.name === "crafting_table"),
    false,
  );
  await runtime.shutdown("hostile proximity check complete");
});

test("Minecraft navigation rejects targets beyond its fixed distance without moving", async () => {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const bot = createMockBot(true);
  const factory: MinecraftBotFactory = (_options: BotOptions) => bot;
  const adapter = createTestAdapter(logger, factory);
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  await runtime.connect();

  const result = await skills.run("minecraft.navigate", { x: 100, y: 64, z: 0, range: 1 });
  assert.equal(result.action.status, "failed");
  assert.equal(result.action.failure?.code, "NAVIGATION_TARGET_TOO_FAR");
  assert.deepEqual(result.observationAfter?.state.player.position, { x: 0.5, y: 64, z: 0.5 });
  await runtime.shutdown("navigation limit test finished");
});

test("navigation progress watchdog fails a stalled goal without disconnecting the session", async () => {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const bot = createMockBot(true, 20, true);
  const adapter = createTestAdapter(logger, () => bot, config({ navigationStuckTimeoutMs: 1_000 }));
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  await runtime.connect();

  const result = await skills.run("minecraft.navigate", { x: 4, y: 64, z: 0, range: 1 });
  assert.equal(result.action.status, "failed");
  assert.equal(result.action.failure?.code, "NAVIGATION_STUCK");
  assert.equal(adapter.status, "connected");
  await runtime.shutdown("navigation watchdog test finished");
});

test("stalled resource collection is cancelled by the shared movement watchdog", async () => {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const bot = createMockBot(true, 20, false, true);
  const adapter = createTestAdapter(logger, () => bot, config({ navigationStuckTimeoutMs: 1_000 }));
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  await runtime.connect();

  const result = await skills.run("minecraft.collect-log", {
    x: 2,
    y: 64,
    z: 0,
    blockName: "oak_log",
  });
  assert.equal(result.action.status, "failed");
  assert.equal(result.action.failure?.code, "NAVIGATION_STUCK");
  assert.equal(adapter.status, "connected");
  await runtime.shutdown("collection watchdog test finished");
});

test("plugin installation precedes safe movement setup and Mineflayer receives the respawn setting", async () => {
  const logger = pino({ level: "silent" });
  const bot = createMockBot(true);
  let respawnOption: boolean | undefined;
  const factory: MinecraftBotFactory = (options: BotOptions) => {
    respawnOption = options.respawn;
    return bot;
  };
  const setupOrder: string[] = [];
  const adapter = new MinecraftAdapter(logger, config({ autoRespawn: false }), {
    botFactory: factory,
    installPlugins: () => setupOrder.push("plugins"),
    configureSafeMovements: () => setupOrder.push("safe-movements"),
  });

  await adapter.connect();
  assert.deepEqual(setupOrder, ["plugins", "safe-movements"]);
  assert.equal(respawnOption, false);
  assert.equal(adapter.status, "connected");
  await adapter.disconnect("plugin lifecycle test complete");
});

test("adapter refuses to expose a session when safe movement configuration fails", async () => {
  const logger = pino({ level: "silent" });
  const bot = createMockBot(true);
  const factory: MinecraftBotFactory = (_options: BotOptions) => bot;
  const adapter = new MinecraftAdapter(logger, config(), {
    botFactory: factory,
    installPlugins: () => undefined,
    configureSafeMovements: () => {
      throw new Error("safe movement setup failed");
    },
  });

  await assert.rejects(adapter.connect(), /safe movement setup failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.status, "disconnected");
  assert.equal(adapter.session, null);
});

test("Minecraft connection timeout rejects and leaves the adapter safely disconnected", async () => {
  const logger = pino({ level: "silent" });
  const bot = createMockBot(false);
  const factory: MinecraftBotFactory = (_options: BotOptions) => bot;
  const adapter = createTestAdapter(logger, factory, config({ connectTimeoutMs: 10 }));

  await assert.rejects(adapter.connect(), /Timed out after 10 ms/);
  await adapter.disconnect("test cleanup");
  assert.equal(adapter.status, "disconnected");
  assert.equal(adapter.session, null);
});

test("unexpected server end clears the active Minecraft session and preserves its trace correlation", async () => {
  const logger = pino({ level: "silent" });
  const sink = new MemoryTraceSink();
  const trace = new TraceRecorder(sink, logger);
  const bot = createMockBot(true);
  const factory: MinecraftBotFactory = (_options: BotOptions) => bot;
  const adapter = createTestAdapter(logger, factory);
  const { runtime } = createMinecraftAgent(adapter, trace, logger);
  const session = await runtime.connect();

  bot.emit("end", "server closed the connection");
  assert.equal(adapter.status, "disconnected");
  assert.equal(adapter.session, null);
  assert.equal(runtime.session, null);
  assert.equal(runtime.currentWorldState, null);
  await new Promise((resolve) => setImmediate(resolve));
  const disconnectEvent = sink.events.find((event) => event.eventType === "adapter.disconnected");
  assert.equal(disconnectEvent?.sessionId, session.id);
  await runtime.shutdown("test cleanup");
});

test("adapter can reconnect with a fresh session after the prior connection ends", async () => {
  const logger = pino({ level: "silent" });
  const bots = [createMockBot(false), createMockBot(false)];
  let nextBot = 0;
  const factory: MinecraftBotFactory = (_options: BotOptions) => {
    const bot = bots[nextBot];
    if (!bot) throw new Error("No scripted bot remains.");
    nextBot += 1;
    queueMicrotask(() => bot.emit("spawn"));
    return bot;
  };
  const adapter = createTestAdapter(logger, factory);
  const first = await adapter.connect();
  bots[0]?.emit("end", "server restarted");
  const second = await adapter.connect();

  assert.notEqual(second.id, first.id);
  assert.equal(adapter.status, "connected");
  await adapter.disconnect("test cleanup");
  assert.equal(adapter.status, "disconnected");
});
