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
import type { BotOptions } from "mineflayer";
import { MINECRAFT_HARVEST_BERRIES_CAPABILITY, MINECRAFT_PICKUP_ITEM_CAPABILITY, MINECRAFT_REST_CAPABILITY } from "../src/games/minecraft/capabilities.js";
import { minecraftObservationSchema } from "../src/games/minecraft/observation.js";
import { MinecraftAdapter } from "../src/games/minecraft/minecraft-adapter.js";
import { createLiveMock, connectAdapter, attemptCollection, run, config, NO_PATH_X, type MockOptions, type MockBlock, Vec } from "./support/minecraft-double.js";

test("Minecraft chat is not wired to any control path", async () => {
  const mock = createLiveMock();
  const adapter = await connectAdapter(mock);
  // The chat-command system was removed: the adapter exposes no chat subscription or send path,
  // and emitting chat must not throw, move the agent, or change any state.
  assert.equal("onCompanionChat" in adapter, false);
  assert.equal("sendCompanionChat" in adapter, false);
  assert.equal(typeof (adapter as unknown as Record<string, unknown>).onCompanionChat, "undefined");
  (mock.bot as unknown as EventEmitter).emit("chat", "Alex", "#follow");
  await adapter.disconnect("test");
});

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

test("observation preserves water, logs, leaves, soil and stone with measured visibility and distance", async () => {
  const mock = createLiveMock();
  mock.blocks.set("1,64,0", { name: "water", type: 9, boundingBox: "empty" });
  mock.blocks.set("2,64,0", { name: "birch_log", type: 17, boundingBox: "block" });
  mock.blocks.set("0,65,1", { name: "oak_leaves", type: 18, boundingBox: "block" });
  mock.blocks.set("0,63,0", { name: "grass_block", type: 2, boundingBox: "block" });
  mock.blocks.set("-1,63,0", { name: "dirt", type: 3, boundingBox: "block" });
  mock.blocks.set("0,63,-1", { name: "stone", type: 1, boundingBox: "block" });
  const adapter = await connectAdapter(mock, { observationRadius: 3, maxObservedBlocks: 6 });
  const state = (await adapter.observe()).state;

  for (const name of ["water", "birch_log", "oak_leaves", "grass_block", "dirt", "stone"]) {
    const observed = state.nearbyBlocks.find((block) => block.name === name);
    assert.ok(observed, `${name} must survive the capped local observation`);
    assert.equal(observed.visible, true, `${name} visibility comes from Mineflayer`);
    assert.ok(typeof observed.distance === "number" && observed.distance >= 0);
  }
  assert.equal(state.nearbyBlocks.find((block) => block.name === "water")?.type, 9);
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

/* ---------------------------------------------------------------- live session facts */

test("an unreported dimension or game mode is reported as unknown and never blocks work", async () => {
  // This is the exact live shape of a session whose login packet had not been handled yet: `bot.game` is
  // an empty object, so the old code read `undefined !== "overworld"` and blocked every skill.
  const mock = createLiveMock({ game: {} });
  mock.blocks.set("6,64,5", { name: "oak_log", type: 1, boundingBox: "block" });
  const adapter = await connectAdapter(mock);
  const state = (await adapter.observe()).state;

  assert.equal(state.player.dimension, null);
  assert.equal(state.player.gameMode, null);
  assert.equal(state.player.session?.dimension?.evidence, "unreported");
  assert.equal(state.player.session?.gameMode?.evidence, "unreported");

  const session = adapter.session;
  assert.ok(session);
  const outcome = await attemptCollection(adapter, session.id);
  assert.notEqual(outcome.code, "GAME_MODE_BLOCKS_COLLECTION", "an unknown mode must not become a refusal");
  assert.notEqual(outcome.code, "UNSUPPORTED_DIMENSION", "an unknown dimension must not become a refusal");
  assert.doesNotMatch(outcome.message, /survival mode|overworld/, `the refusal text leaked: ${outcome.message}`);
  await adapter.disconnect("test");
});

test("a verified Creative report refuses collection and carries the evidence", async () => {
  const mock = createLiveMock({ gameMode: "creative", playerGameMode: 1 });
  mock.blocks.set("6,64,5", { name: "oak_log", type: 1, boundingBox: "block" });
  const adapter = await connectAdapter(mock);
  const state = (await adapter.observe()).state;
  assert.equal(state.player.gameMode, "creative");
  assert.equal(state.player.session?.gameMode?.evidence, "verified");

  const session = adapter.session;
  assert.ok(session);
  const outcome = await attemptCollection(adapter, session.id);
  assert.equal(outcome.code, "GAME_MODE_BLOCKS_COLLECTION");
  assert.match(outcome.message, /creative \(verified: bot\.game\.gameMode \+ bot\.player\.gamemode\)/);
  await adapter.disconnect("test");
});

test("disagreeing game-mode sources are reported as a conflict instead of blocking survival", async () => {
  // `bot.game.gameMode` only refreshes on `game_state_change`, so a `/gamemode survival` on the server can
  // leave it saying "creative" while the player list already says survival. Refusing here was the false
  // Creative report the live test hit.
  const mock = createLiveMock({ gameMode: "creative", playerGameMode: 0 });
  mock.blocks.set("6,64,5", { name: "oak_log", type: 1, boundingBox: "block" });
  const adapter = await connectAdapter(mock);
  const state = (await adapter.observe()).state;
  assert.equal(state.player.gameMode, null);
  assert.equal(state.player.session?.gameMode?.evidence, "conflicting");
  assert.match(String(state.player.session?.gameMode?.note ?? ""), /creative \(bot\.game\.gameMode\) and survival/);

  const session = adapter.session;
  assert.ok(session);
  const outcome = await attemptCollection(adapter, session.id);
  assert.notEqual(outcome.code, "GAME_MODE_BLOCKS_COLLECTION", "a conflict is reported, not refused");
  assert.doesNotMatch(outcome.message, /requires survival mode/);
  await adapter.disconnect("test");
});

test("a server that names the world instead of the dimension is not read as 'no overworld'", async () => {
  const mock = createLiveMock({ dimension: "minecraft:overworld" });
  const adapter = await connectAdapter(mock);
  const state = (await adapter.observe()).state;
  assert.equal(state.player.dimension, "overworld");
  await adapter.disconnect("test");

  const nether = await connectAdapter(createLiveMock({ dimension: -1 }));
  const netherState = (await nether.observe()).state;
  assert.equal(netherState.player.dimension, "the_nether");
  await nether.disconnect("test");

  const custom = await connectAdapter(createLiveMock({ dimension: "custom:lobby" }));
  const customState = (await custom.observe()).state;
  assert.equal(customState.player.dimension, "custom:lobby");
  assert.match(String(customState.player.session?.dimension?.note ?? ""), /never as the overworld/);
  await custom.disconnect("test");
});

test("mid-session mode and dimension changes are picked up by the next observation", async () => {
  const mock = createLiveMock();
  const adapter = await connectAdapter(mock);
  const before = (await adapter.observe()).state;
  assert.equal(before.player.gameMode, "survival");

  const game = mock.bot.game as unknown as { gameMode: string; dimension: string };
  game.gameMode = "creative";
  game.dimension = "minecraft:the_nether";
  mock.bot.emit("game");

  const after = (await adapter.observe()).state;
  assert.equal(after.player.gameMode, "creative", "the gate re-reads the session instead of trusting connect time");
  assert.equal(after.player.dimension, "the_nether");
  assert.equal(after.player.session?.gameMode?.evidence, "single-source");
  const change = (adapter as unknown as { sessionChange?: { kind: string; detail: string } }).sessionChange;
  assert.equal(change?.kind, "game");
  assert.match(String(change?.detail), /creative/);
  await adapter.disconnect("test");
});

test("vitals the session never sent stay unknown instead of becoming safe numbers", async () => {
  const mock = createLiveMock({ vitalsUnreported: true, oxygenLevel: null });
  const adapter = await connectAdapter(mock);
  const state = (await adapter.observe()).state;
  assert.equal(state.player.health, null);
  assert.equal(state.player.food, null);
  assert.equal(state.player.foodSaturation, null);
  assert.equal(state.player.oxygenLevel, null, "no air metadata is not full lungs");
  assert.equal(state.player.alive, null, "an unreported life state is not a death");
  assert.equal(state.player.session?.vitalsObservedAt ?? null, null, "nothing has been observed this session");
  assert.equal(state.player.deathCount, 0);

  // The inventory claim now comes from the window's empty-slot count, not a stack-count guess.
  assert.equal(state.player.inventoryFull, false);
  await adapter.disconnect("test");
});

test("the air gauge is reported in ticks, so a half-empty tank reads as half empty", async () => {
  const adapter = await connectAdapter(createLiveMock({ oxygenLevel: 10 }));
  const state = (await adapter.observe()).state;
  assert.equal(state.player.oxygenLevel, 150);
  assert.equal(state.player.session?.airEvidence, "single-source");
  await adapter.disconnect("test");
});

test("health and hunger are re-read from the session on every observation", async () => {
  const mock = createLiveMock();
  const adapter = await connectAdapter(mock);
  const first = (await adapter.observe()).state;
  assert.equal(first.player.health, 20);

  mock.bot.health = 7;
  mock.bot.emit("health");
  const second = (await adapter.observe()).state;
  assert.equal(second.player.health, 7);
  assert.ok(second.player.session?.vitalsObservedAt, "the session reported health, so its age is knowable");

  const drained = (mock.bot as unknown as { oxygenLevel: number | null });
  drained.oxygenLevel = 2;
  const third = (await adapter.observe()).state;
  assert.equal(third.player.oxygenLevel, 30);
  await adapter.disconnect("test");
});

test("a payload that does not match the contract fails as a named validation error", async () => {
  const mock = createLiveMock();
  const adapter = await connectAdapter(mock);
  // A proxy that echoes the entity as a string is the kind of surprise that used to kill the whole run
  // with an unreadable ZodError dump; the observation must now say which field broke.
  (mock.bot as unknown as { username: unknown }).username = 42;
  await assert.rejects(
    () => adapter.observe(),
    (error: unknown) => {
      const failure = error as { code?: string; message?: string };
      assert.equal(failure.code, "OBSERVATION_SCHEMA_INVALID");
      assert.match(String(failure.message), /player\.username/);
      return true;
    },
  );
  await adapter.disconnect("test");
});

// Live regression: `bot.canSeeBlock` returns `null` (not `false`) when its raycast hits nothing, and the
// observation schema rejects that as OBSERVATION_SCHEMA_INVALID. The sightings below are the live shapes
// that reached the schema: a stone found by the wide mineable scan whose ray hits nothing, a log the ray
// hits behind another block, and a cube block with the same "no hit" outcome.
test("a line-of-sight ray that hits nothing is reported as not visible, not as a schema failure", async () => {
  const mock = createLiveMock({
    lineOfSight: (block) => {
      if (block.name === "stone" && block.position.x === 12) return "no-hit";
      if (block.name === "oak_log" && block.position.x === 14) return "blocked";
      if (block.name === "dirt" && block.position.x === 1) return "no-hit";
      return "clear";
    },
  });
  mock.blocks.set("12,64,0", { name: "stone", type: 1, boundingBox: "block" });
  mock.blocks.set("14,64,0", { name: "oak_log", type: 1, boundingBox: "block" });
  mock.blocks.set("1,64,0", { name: "dirt", type: 3, boundingBox: "block" });
  const adapter = await connectAdapter(mock);
  const state = (await adapter.observe()).state;

  const stone = state.minableSightings?.find((sighting) => sighting.name === "stone");
  assert.ok(stone, "the wide mineable scan found the stone");
  assert.equal(stone.visible, false, "a ray that hit nothing is a measured not-visible, not an unknown");
  const log = state.resourceSightings.find((sighting) => sighting.name === "oak_log");
  assert.equal(log?.visible, false, "a ray stopped by another block is not visible");
  const cubeDirt = state.nearbyBlocks.find((block) => block.name === "dirt");
  assert.equal(cubeDirt?.visible, false);
  for (const sighting of state.minableSightings ?? []) {
    assert.equal(typeof sighting.visible, "boolean", "every reported visibility is a real boolean");
  }
  await adapter.disconnect("test");
});

test("a rejected observation names the value that arrived, so the live log shows what the session sent", async () => {
  const mock = createLiveMock();
  const adapter = await connectAdapter(mock);
  // A non-string username reaches the contract unchanged; the message must quote the received value.
  (mock.bot as unknown as { username: unknown }).username = 42;
  await assert.rejects(
    () => adapter.observe(),
    (error: unknown) => {
      const failure = error as { code?: string; message?: string };
      assert.equal(failure.code, "OBSERVATION_SCHEMA_INVALID");
      assert.match(String(failure.message), /player\.username: expected string, received 42/);
      return true;
    },
  );
  await adapter.disconnect("test");
});

test("a line-of-sight test that throws stays unknown: the field is omitted, not guessed", async () => {
  const mock = createLiveMock();
  mock.blocks.set("12,64,0", { name: "stone", type: 1, boundingBox: "block" });
  (mock.bot as unknown as { canSeeBlock: () => boolean }).canSeeBlock = () => {
    throw new Error("chunk is being replaced");
  };
  const adapter = await connectAdapter(mock);
  const stone = (await adapter.observe()).state.minableSightings?.find((sighting) => sighting.name === "stone");
  assert.ok(stone);
  assert.equal("visible" in stone, false);
  await adapter.disconnect("test");
});

test("the observation contract still rejects a non-boolean visibility; the adapter now produces only booleans", () => {
  const base = {
    player: {
      username: "GameMind",
      position: { x: 0, y: 64, z: 0 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 300,
      onGround: true,
    },
    inventory: [],
    equipment: { hand: null, offhand: null, head: null, torso: null, legs: null, feet: null },
    entities: [],
    nearbyBlocks: [],
    resourceSightings: [],
    resourceScan: { radius: 24, limit: 192, center: { x: 0, y: 64, z: 0 }, truncated: false },
    itemDrops: [],
    sampledRegion: { radius: 5, verticalRadius: 2, center: { x: 0, y: 64, z: 0 }, sampledCells: 0, unknownCells: 0, truncated: false },
  };
  const sighting = { name: "stone", position: { x: 12, y: 64, z: 0 }, distance: 12 };
  assert.equal(minecraftObservationSchema.safeParse({ ...base, minableSightings: [{ ...sighting, visible: false }] }).success, true);
  assert.equal(minecraftObservationSchema.safeParse({ ...base, minableSightings: [{ ...sighting }] }).success, true);
  assert.equal(
    minecraftObservationSchema.safeParse({ ...base, minableSightings: [{ ...sighting, visible: null }] }).success,
    false,
    "null is not a visibility value and must stay invalid",
  );
  assert.equal(
    minecraftObservationSchema.safeParse({ ...base, minableSightings: [{ ...sighting, visible: "yes" }] }).success,
    false,
  );
});
