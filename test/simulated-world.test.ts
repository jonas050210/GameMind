import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";
import {
  berryBushAt,
  dropAt,
  hostileAt,
  logAt,
  simulatedWorld,
  treeAt,
} from "../src/testing/simulated-minecraft/scenarios.js";
import { SimulatedMinecraftWorld } from "../src/testing/simulated-minecraft/world.js";

async function connected(options: Parameters<typeof simulatedWorld>[0]) {
  const adapter = new SimulatedMinecraftAdapter({ definition: simulatedWorld(options) });
  await adapter.connect();
  return adapter;
}

async function act(adapter: SimulatedMinecraftAdapter, capability: string, input: unknown) {
  return adapter.executeAction(
    { actionId: randomUUID(), sessionId: adapter.session?.id ?? "", capability, input },
    new AbortController().signal,
  );
}

test("navigation routes around an obstacle and confirms arrival at the goal", async () => {
  const adapter = await connected({ seed: 1, placements: treeAt(3, 0, 4) });
  const outcome = await act(adapter, "minecraft.navigate", { x: 6, y: 64, z: 0, range: 1 });
  assert.equal(outcome.confirmed, true);
  const position = adapter.world.playerX;
  assert.ok(Math.abs(position - 6.5) <= 2.25, `arrived near the goal, got ${position}`);
  await adapter.disconnect("test");
});

test("an enclosed target fails with PATH_NOT_FOUND and the player does not move", async () => {
  const walls = [logAt(4, 0), logAt(6, 0), logAt(5, 1), logAt(5, -1)];
  const adapter = await connected({ seed: 2, placements: walls });
  const before = { x: adapter.world.playerX, z: adapter.world.playerZ };
  await assert.rejects(
    act(adapter, "minecraft.navigate", { x: 5, y: 64, z: 0, range: 1 }),
    (error: unknown) => (error as { code?: string }).code === "PATH_NOT_FOUND",
  );
  assert.deepEqual({ x: adapter.world.playerX, z: adapter.world.playerZ }, before);
  await adapter.disconnect("test");
});

test("a stalled cell reports NAVIGATION_STUCK after the stuck timeout and keeps the session", async () => {
  const adapter = await connected({ seed: 3, stallCells: [{ x: 2, z: 0 }] });
  const startedAt = adapter.simulatedNowMs;
  await assert.rejects(
    act(adapter, "minecraft.navigate", { x: 4, y: 64, z: 0, range: 1 }),
    (error: unknown) => (error as { code?: string }).code === "NAVIGATION_STUCK",
  );
  assert.ok(adapter.simulatedNowMs - startedAt >= 10_000, "the stuck timeout consumed virtual time");
  assert.equal(adapter.status, "connected");
  await adapter.disconnect("test");
});

test("collection re-checks the block after walking and gains nothing if it was removed in transit", async () => {
  const adapter = await connected({
    seed: 4,
    placements: [logAt(8, 0)],
    schedule: [{ atMs: 500, type: "remove_block", x: 8, y: 64, z: 0 }],
  });
  const outcome = await act(adapter, "minecraft.collect_block", {
    x: 8,
    y: 64,
    z: 0,
    blockName: "oak_log",
    dangerRadius: 6,
  });
  assert.equal(outcome.confirmed, false, "a removed log must not be credited");
  assert.equal(adapter.world.countItem("oak_log"), 0);
  await adapter.disconnect("test");
});

test("pickup confirms an inventory gain only when the observed drop exists", async () => {
  const adapter = await connected({ seed: 5, items: [dropAt("bread", 1, 4, -3)] });
  await assert.rejects(
    act(adapter, "minecraft.pickup_item", { x: 1, y: 64, z: 1, itemName: "bread", dangerRadius: 6 }),
    (error: unknown) => (error as { code?: string }).code === "ITEM_DROP_NOT_FOUND",
  );
  const picked = await act(adapter, "minecraft.pickup_item", { x: 4, y: 64, z: -3, itemName: "bread", dangerRadius: 6 });
  assert.equal(picked.confirmed, true);
  assert.equal(adapter.world.countItem("bread"), 1);
  await adapter.disconnect("test");
});

test("berry harvesting refuses unripe bushes and resets a ripe bush to age 1", async () => {
  const unripe = await connected({ seed: 6, placements: [berryBushAt(3, 0, 1)] });
  await assert.rejects(
    act(unripe, "minecraft.harvest_berries", { x: 3, y: 64, z: 0, dangerRadius: 6 }),
    (error: unknown) => (error as { code?: string }).code === "BERRY_NOT_RIPE",
  );
  await unripe.disconnect("test");

  const ripe = await connected({ seed: 7, placements: [berryBushAt(3, 0, 3)] });
  const harvested = await act(ripe, "minecraft.harvest_berries", { x: 3, y: 64, z: 0, dangerRadius: 6 });
  assert.equal(harvested.confirmed, true);
  assert.ok(ripe.world.countItem("sweet_berries") >= 2);
  assert.equal(ripe.world.blockAt(3, 64, 0)?.properties.age, 1);
  await ripe.disconnect("test");
});

test("rest regenerates health only when food is at the regeneration threshold", async () => {
  const fed = await connected({ seed: 8, player: { health: 10, food: 20 } });
  const healed = await act(fed, "minecraft.rest", { durationMs: 8_000, targetHealth: 20, dangerRadius: 6 });
  assert.equal(healed.confirmed, true);
  assert.ok(fed.world.health > 11.5, `expected roughly +2 health over 8 s, got ${fed.world.health}`);
  await fed.disconnect("test");

  const hungry = await connected({ seed: 9, player: { health: 10, food: 10 } });
  const idle = await act(hungry, "minecraft.rest", { durationMs: 8_000, targetHealth: 20, dangerRadius: 6 });
  assert.equal(idle.confirmed, false, "no regeneration below food 18 must not be confirmed");
  assert.equal(hungry.world.health, 10);
  await hungry.disconnect("test");
});

test("rest is interrupted by a hostile inside its danger radius", async () => {
  const adapter = await connected({ seed: 10, player: { health: 10, food: 20 }, hostiles: [hostileAt("z1", 2, 0)] });
  await assert.rejects(
    act(adapter, "minecraft.rest", { durationMs: 8_000, targetHealth: 20, dangerRadius: 6 }),
    (error: unknown) => (error as { code?: string }).code === "REST_INTERRUPTED_BY_THREAT",
  );
  await adapter.disconnect("test");
});

test("the local cube keeps resource blocks even when the 64-block cap truncates terrain", async () => {
  const adapter = await connected({ seed: 11, placements: [logAt(3, 3)] });
  const observation = await adapter.observe();
  assert.equal(observation.state.sampledRegion.truncated, true, "stone and grass exceed the cap");
  assert.ok(
    observation.state.nearbyBlocks.some((block) => block.name === "oak_log" && block.position.x === 3 && block.position.z === 3),
    "the log at the corner of the sampled cube survives truncation",
  );
  await adapter.disconnect("test");
});

test("resource sightings cover the wide radius, report truncation, and omit far resources", async () => {
  const near = Array.from({ length: 70 }, (_, index) => logAt(10 + (index % 10), 10 + Math.floor(index / 10)));
  const far = logAt(40, 0);
  const adapter = await connected({ seed: 12, placements: [...near, far] });
  const observation = await adapter.observe();
  assert.equal(observation.state.resourceScan.truncated, true);
  assert.equal(observation.state.resourceSightings.length, 64);
  assert.ok(observation.state.resourceSightings.every((sighting) => sighting.distance <= 24));
  await adapter.disconnect("test");
});

test("ripe berry bushes are observed with their age and drops appear in the item scan", async () => {
  const adapter = await connected({
    seed: 13,
    placements: [berryBushAt(-5, 2, 2)],
    items: [dropAt("apple", 1, 3, 3)],
  });
  const observation = await adapter.observe();
  const bush = observation.state.resourceSightings.find((sighting) => sighting.name === "sweet_berry_bush");
  assert.deepEqual(bush?.properties, { age: 2 });
  assert.equal(observation.state.itemDrops[0]?.name, "apple");
  await adapter.disconnect("test");
});

test("hunger drains over time and starvation damages health", async () => {
  const adapter = await connected({ seed: 14, player: { food: 20, health: 20 } });
  adapter.world.advance(120_000);
  assert.ok(adapter.world.food < 20, "food decreases while time passes");
  assert.ok(adapter.world.food > 17, "idle hunger is slow");
  await adapter.disconnect("test");

  const starving = await connected({ seed: 15, player: { food: 0, health: 12 } });
  // Damage interrupts resting; the adapter reports it as an error, not as a silent success.
  await assert.rejects(
    act(starving, "minecraft.rest", { durationMs: 8_000, targetHealth: 20, dangerRadius: 6 }),
    (error: unknown) => (error as { code?: string }).code === "REST_INTERRUPTED_BY_DAMAGE",
  );
  assert.ok(starving.world.health < 12, "starvation reduced health");
  await starving.disconnect("test");
});

test("the same seed reproduces the same hostile movement", () => {
  const definition = simulatedWorld({ seed: 16, hostiles: [hostileAt("z1", 9, 9), hostileAt("z2", -7, 4)] });
  const first = new SimulatedMinecraftWorld(definition);
  const second = new SimulatedMinecraftWorld(definition);
  first.advance(20_000);
  second.advance(20_000);
  assert.deepEqual(first.hostileEntities(), second.hostileEntities());
});

test("cells beyond the loaded radius are unknown rather than empty", async () => {
  const nearEdge = await connected({ seed: 17, loadedRadius: 2 });
  const observation = await nearEdge.observe();
  assert.ok(observation.state.sampledRegion.unknownCells > 0, "the sampled cube reaches past the loaded square");
  await nearEdge.disconnect("test");

  const far = new SimulatedMinecraftWorld(simulatedWorld({ seed: 18, loadedRadius: 4, player: { x: 30, z: 0 } }));
  assert.equal(far.blockAt(30, 63, 0), null, "outside the loaded square is unknown, not air");
  assert.equal(far.blockAt(2, 63, 0)?.name, "grass_block", "inside the loaded square the ground is known");
});
