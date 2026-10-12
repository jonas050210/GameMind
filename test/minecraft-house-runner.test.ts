import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import type { GameMindRuntime } from "../src/core/game-mind-runtime.js";
import type { SkillRuntime } from "../src/core/skill-runtime.js";
import type { WorldState } from "../src/core/types.js";
import { MinecraftHouseRunner } from "../src/games/minecraft/house-runner.js";
import { buildHouseTaskSchema } from "../src/games/minecraft/task.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { createFakeMinecraftFixture } from "../src/testing/fake-minecraft-adapter.js";

const SESSION_ID = "house-test-session";

function makeWorld(
  inventory: MinecraftObservation["inventory"] = [],
  logs: MinecraftObservation["resourceSightings"] = [],
  nearbyBlocks?: MinecraftObservation["nearbyBlocks"],
  playerOverrides: Partial<MinecraftObservation["player"]> = {},
): WorldState<MinecraftObservation> {
  const fixture = createFakeMinecraftFixture(1337);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    gameId: "minecraft-java",
    gameVersion: "1.20.4",
    sessionId: SESSION_ID,
    sequence: 1,
    observedAt: now,
    receivedAt: now,
    state: {
      ...fixture,
      player: { ...fixture.player, position: { x: 0.5, y: 64, z: 0.5 }, alive: true, ...playerOverrides },
      inventory,
      ...(nearbyBlocks ? { nearbyBlocks } : {}),
      resourceSightings: logs,
      entities: [],
    },
  };
}

function setup(options: {
  readonly inventory?: MinecraftObservation["inventory"];
  readonly resourceSightings?: MinecraftObservation["resourceSightings"];
  readonly nearbyBlocks?: MinecraftObservation["nearbyBlocks"];
  readonly occupiedAt?: string;
  readonly player?: Partial<MinecraftObservation["player"]>;
} = {}) {
  let world = makeWorld(options.inventory, options.resourceSightings, options.nearbyBlocks, options.player);
  let actionId = 0;
  const calls: Array<{ readonly skillId: string; readonly input: unknown }> = [];
  const runtime = {
    adapter: { status: "connected", gameId: "minecraft-java" },
    session: { id: SESSION_ID, gameId: "minecraft-java", gameVersion: "1.20.4", connectedAt: new Date().toISOString() },
    get currentWorldState() { return world; },
    connect: async () => undefined,
    observeIfStale: async () => world,
    safety: { startRun: () => undefined },
    trace: { record: async () => undefined },
  } as unknown as GameMindRuntime<MinecraftObservation>;
  const updateWorld = (state: MinecraftObservation): WorldState<MinecraftObservation> => {
    const now = new Date().toISOString();
    world = { ...world, sequence: world.sequence + 1, observedAt: now, receivedAt: now, state };
    return world;
  };
  const skills = {
    run: async (skillId: string, input: unknown) => {
      calls.push({ skillId, input });
      const cell = input as { readonly x: number; readonly y: number; readonly z: number; readonly blockName?: string };
      const key = `${cell.x},${cell.y},${cell.z}`;
      const startedAt = new Date().toISOString();
      const makeAction = (
        status: "succeeded" | "failed" = "succeeded",
        confirmed = true,
        failure: { readonly code: string; readonly message: string } | null = null,
        details: Readonly<Record<string, unknown>> = {},
      ) => ({
        actionId: `house-action-${++actionId}`,
        sessionId: SESSION_ID,
        capability: skillId,
        status,
        confirmed,
        confirmation: confirmed ? "test action" : null,
        requestedAt: startedAt,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        failure,
        details,
      });
      if (skillId === "minecraft.inspect-block") {
        const distance = Math.hypot(
          cell.x - world.state.player.position.x,
          cell.y - world.state.player.position.y,
          cell.z - world.state.player.position.z,
        );
        if (distance > 7) {
          return {
            skillId,
            action: makeAction("failed", false, { code: "BLOCK_OUT_OF_RANGE", message: "Block is outside the inspection radius." }),
            observationBefore: world,
            observationAfter: world,
          };
        }
        const sighting = world.state.resourceSightings.find((candidate) =>
          candidate.position.x === cell.x && candidate.position.y === cell.y && candidate.position.z === cell.z,
        );
        const name = options.occupiedAt === key
          ? "oak_log"
          : sighting?.name ?? (cell.y === 63 ? "stone" : "air");
        const boundingBox = name === "air" || name.endsWith("_air") ? "empty" : "block";
        return {
          skillId,
          action: makeAction("succeeded", true, null, { name, boundingBox }),
          observationBefore: world,
          observationAfter: world,
        };
      }
      if (skillId === "minecraft.navigate") {
        const before = world;
        const after = updateWorld({
          ...world.state,
          player: {
            ...world.state.player,
            position: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 },
          },
        });
        return { skillId, action: makeAction(), observationBefore: before, observationAfter: after };
      }
      if (skillId === "minecraft.place-block") {
        return {
          skillId,
          action: makeAction("failed", false, { code: "TEST_PLACE_STOP", message: "Test stops before placing the first approved block." }),
          observationBefore: world,
          observationAfter: world,
        };
      }
      if (skillId === "minecraft.collect-log") {
        return {
          skillId,
          action: makeAction("failed", false, { code: "TEST_COLLECTION_STOP", message: "Test stops after first approved collection attempt." }),
          observationBefore: world,
          observationAfter: world,
        };
      }
      throw new Error(`Unexpected skill ${skillId} at ${key}`);
    },
  } as unknown as SkillRuntime<MinecraftObservation>;
  const runner = new MinecraftHouseRunner(runtime, skills, pino({ level: "silent" }));
  return { runner, calls };
}

function task(allowMaterialGathering = false) {
  return buildHouseTaskSchema.parse({
    id: "test-house",
    kind: "build_house",
    origin: { x: -2, y: 64, z: -2 },
    materialName: "oak_planks",
    allowMaterialGathering,
    maxActions: 1_000,
    maxDurationMs: 60_000,
  });
}

test("house runner defaults to no material gathering and stops before any collection or placement", async () => {
  const approvedByDefault = buildHouseTaskSchema.parse({
    id: "default-house",
    kind: "build_house",
    origin: { x: -2, y: 64, z: -2 },
  });
  assert.equal(approvedByDefault.allowMaterialGathering, false);

  const { runner, calls } = setup();
  const result = await runner.run(approvedByDefault);
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "HOUSE_MATERIAL_GATHERING_NOT_APPROVED");
  assert.equal(calls.filter((call) => call.skillId === "minecraft.collect-log").length, 0);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.place-block").length, 0);
  assert.equal(result.metrics.targetItemsGained, 0);
});

test("house runner fails closed when life, survival mode, or hunger is unconfirmed", async () => {
  const cases: Array<{
    readonly player: Partial<MinecraftObservation["player"]>;
    readonly expectedCode: string;
  }> = [
    { player: { alive: null }, expectedCode: "PLAYER_LIFE_UNCONFIRMED" },
    { player: { gameMode: null }, expectedCode: "HOUSE_REQUIRES_SURVIVAL" },
    { player: { food: null }, expectedCode: "HOUSE_HUNGER_TOO_LOW" },
  ];
  for (const scenario of cases) {
    const { runner, calls } = setup({ player: scenario.player });
    const result = await runner.run(task(true));
    assert.equal(result.status, "blocked");
    assert.equal(result.failure?.code, scenario.expectedCode);
    assert.equal(calls.length, 0, "do not inspect, gather, or build without verified prerequisites");
  }
});

test("even after separate gathering permission, an occupied house site is never cleared", async () => {
  const { runner, calls } = setup({ occupiedAt: "-2,64,-2" });
  const result = await runner.run(task(true));
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "HOUSE_SITE_OCCUPIED");
  assert.match(result.failure?.message ?? "", /do not clear trees/i);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.collect-log").length, 0);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.place-block").length, 0);
});

test("a player inside the centered house footprint is moved to the safe perimeter before placement", async () => {
  const inventory: MinecraftObservation["inventory"] = [
    { slot: 9, name: "oak_planks", type: 5, count: 80, metadata: null, durabilityUsed: null },
  ];
  const { runner, calls } = setup({ inventory });
  const result = await runner.run(task());
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "TEST_PLACE_STOP");
  const navigationIndex = calls.findIndex((call) => call.skillId === "minecraft.navigate");
  const placementIndex = calls.findIndex((call) => call.skillId === "minecraft.place-block");
  assert.ok(navigationIndex >= 0 && placementIndex > navigationIndex);
  const navigation = calls[navigationIndex];
  assert.ok(navigation);
  const goal = navigation.input as { readonly x: number; readonly z: number };
  assert.ok(goal.x < -2 || goal.x > 2 || goal.z < -2 || goal.z > 2, "the exit waypoint must be outside the 5×5 footprint");
});

test("separate gathering permission still requires enough visible logs before it collects any", async () => {
  const { runner, calls } = setup();
  const result = await runner.run(task(true));
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "HOUSE_MATERIALS_MISSING");
  assert.equal(calls.filter((call) => call.skillId === "minecraft.collect-log").length, 0);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.place-block").length, 0);
});

test("visible log candidates are read-only rechecked and explicitly invisible logs are not counted", async () => {
  const invisible = Array.from({ length: 20 }, (_, index) => ({
    name: "oak_log",
    position: { x: 10 + index, y: 64, z: 0 },
    distance: 10 + index,
    visible: false,
  }));
  const { runner, calls } = setup({ resourceSightings: invisible });
  const result = await runner.run(task(true));
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "HOUSE_MATERIALS_MISSING");
  assert.equal(calls.filter((call) => call.skillId === "minecraft.inspect-block").length, 125, "insufficient visible targets are rejected before any target-by-target gather preflight");
  assert.equal(calls.filter((call) => call.skillId === "minecraft.collect-log").length, 0);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.place-block").length, 0);
});

test("unknown visibility in wide or local scans is not accepted as visible material", async () => {
  const resourceSightings = [
    ...Array.from({ length: 10 }, (_, index) => ({
      name: "oak_log",
      position: { x: 10 + index, y: 64, z: 0 },
      distance: 10 + index,
      visible: true,
    })),
    { name: "oak_log", position: { x: 20, y: 64, z: 0 }, distance: 20 },
  ];
  const nearbyBlocks: MinecraftObservation["nearbyBlocks"] = [
    ...Array.from({ length: 9 }, (_, index) => {
      const position = { x: 10 + index, y: 64, z: 10 };
      return {
        name: "oak_log",
        position,
        type: 17,
        boundingBox: "block",
        distance: Math.hypot(position.x - 0.5, position.z - 0.5),
        visible: true,
      };
    }),
    { name: "oak_log", position: { x: 19, y: 64, z: 10 }, type: 17, boundingBox: "block", distance: Math.hypot(18.5, 9.5) },
  ];
  const { runner, calls } = setup({ resourceSightings, nearbyBlocks });
  const result = await runner.run(task(true));
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "HOUSE_MATERIALS_MISSING");
  assert.match(result.failure?.message ?? "", /19 eligible log blocks/);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.inspect-block").length, 125);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.collect-log").length, 0);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.place-block").length, 0);
});

test("approved visible logs outside local inspection range are approached and rechecked before collection", async () => {
  const resourceSightings = Array.from({ length: 20 }, (_, index) => ({
    name: "oak_log",
    position: { x: 2 + index, y: 64, z: 4 },
    distance: 2 + index,
    visible: true,
  }));
  const { runner, calls } = setup({ resourceSightings });
  const result = await runner.run(task(true));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "TEST_COLLECTION_STOP");
  assert.ok(calls.filter((call) => call.skillId === "minecraft.navigate").length > 0);
  assert.ok(calls.filter((call) => call.skillId === "minecraft.inspect-block").length > 125, "all eligible logs are inspected after approaching them");
  assert.equal(calls.filter((call) => call.skillId === "minecraft.collect-log").length, 1);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.place-block").length, 0);
});

test("visible house-material candidates beyond the adapter reach are rejected before any collection", async () => {
  const beyondReach = Array.from({ length: 20 }, (_, index) => ({
    name: "oak_log",
    position: { x: 26 + index, y: 64, z: 0 },
    distance: 26 + index,
    visible: true,
  }));
  const { runner, calls } = setup({ resourceSightings: beyondReach });
  const result = await runner.run(task(true));
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "HOUSE_MATERIALS_MISSING");
  assert.match(result.failure?.message ?? "", /0 eligible log blocks/);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.inspect-block").length, 125);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.collect-log").length, 0);
  assert.equal(calls.filter((call) => call.skillId === "minecraft.place-block").length, 0);
});
