import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import type { GameMindRuntime } from "../src/core/game-mind-runtime.js";
import type { SkillRuntime } from "../src/core/skill-runtime.js";
import type { WorldState } from "../src/core/types.js";
import { MinecraftWheatFarmRunner } from "../src/games/minecraft/wheat-farm-runner.js";
import { farmWheatTaskSchema } from "../src/games/minecraft/task.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { createFakeMinecraftFixture } from "../src/testing/fake-minecraft-adapter.js";

const SESSION_ID = "farm-test-session";

function makeWorld(
  inventory: MinecraftObservation["inventory"] = [],
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
      entities: [],
    },
  };
}

function setup(options: {
  readonly hydratedSoil?: boolean;
  readonly crop?: "air" | "wheat";
  readonly inventory?: MinecraftObservation["inventory"];
  readonly player?: Partial<MinecraftObservation["player"]>;
} = {}) {
  let world = makeWorld(options.inventory, options.player);
  let actionId = 0;
  const calls: string[] = [];
  const navigationTargets: Array<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly from: { readonly x: number; readonly y: number; readonly z: number };
  }> = [];
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
      calls.push(skillId);
      const startedAt = new Date().toISOString();
      const makeAction = (details: unknown = {}) => ({
        actionId: `farm-action-${++actionId}`,
        sessionId: SESSION_ID,
        capability: skillId,
        status: "succeeded",
        confirmed: true,
        confirmation: "test action",
        requestedAt: startedAt,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        failure: null,
        details,
      });
      if (skillId === "minecraft.inspect-block") {
        const cell = input as { readonly y: number };
        const soil = cell.y === 63;
        const name = soil ? (options.hydratedSoil ? "farmland" : "grass_block") : (options.crop ?? "air");
        const properties = soil && options.hydratedSoil ? { moisture: 7 } : {};
        return {
          skillId,
          action: makeAction({ name, properties }),
          observationBefore: world,
          observationAfter: world,
        };
      }
      if (skillId === "minecraft.navigate") {
        const target = input as { readonly x: number; readonly y: number; readonly z: number };
        navigationTargets.push({ ...target, from: { ...world.state.player.position } });
        const before = world;
        const after = updateWorld({
          ...world.state,
          player: {
            ...world.state.player,
            position: { x: target.x + 0.5, y: target.y, z: target.z + 0.5 },
          },
        });
        return { skillId, action: makeAction(), observationBefore: before, observationAfter: after };
      }
      if (skillId === "minecraft.plant-wheat") {
        const target = input as { readonly x: number; readonly y: number; readonly z: number };
        const distance = Math.hypot(
          world.state.player.position.x - target.x,
          world.state.player.position.y - target.y,
          world.state.player.position.z - target.z,
        );
        if (distance > 24) throw new Error("WHEAT_TARGET_TOO_FAR");
        const before = world;
        let consumed = false;
        const inventory = world.state.inventory.flatMap((item) => {
          if (item.name !== "wheat_seeds" || consumed) return [item];
          consumed = true;
          return item.count > 1 ? [{ ...item, count: item.count - 1 }] : [];
        });
        if (!consumed) throw new Error("Test planter ran out of wheat seeds.");
        const nearbyBlocks = [
          ...world.state.nearbyBlocks.filter((block) =>
            block.position.x !== target.x || block.position.y !== target.y || block.position.z !== target.z,
          ),
          { position: { x: target.x, y: target.y, z: target.z }, name: "wheat", type: 59, boundingBox: "empty" },
        ];
        const after = updateWorld({ ...world.state, inventory, nearbyBlocks });
        return { skillId, action: makeAction(), observationBefore: before, observationAfter: after };
      }
      throw new Error(`Unexpected skill '${skillId}'`);
    },
  } as unknown as SkillRuntime<MinecraftObservation>;
  const runner = new MinecraftWheatFarmRunner(runtime, skills, pino({ level: "silent" }));
  return { runner, calls, navigationTargets };
}

function task(width = 1, depth = 1) {
  return farmWheatTaskSchema.parse({
    id: "test-farm",
    kind: "farm_wheat",
    origin: { x: 0, y: 64, z: 0 },
    width,
    depth,
    maxActions: 5_000,
    maxDurationMs: 1_800_000,
  });
}

test("farm dimensions stay within the 25×50 and 1,250-cell limits", () => {
  assert.equal(farmWheatTaskSchema.safeParse({ id: "max-farm", kind: "farm_wheat", origin: { x: 0, y: 64, z: 0 }, width: 25, depth: 50 }).success, true);
  assert.equal(farmWheatTaskSchema.safeParse({ id: "wide-farm", kind: "farm_wheat", origin: { x: 0, y: 64, z: 0 }, width: 26, depth: 1 }).success, false);
  assert.equal(farmWheatTaskSchema.safeParse({ id: "deep-farm", kind: "farm_wheat", origin: { x: 0, y: 64, z: 0 }, width: 1, depth: 51 }).success, false);
});

test("wheat runner refuses non-farmland before using seeds or planting", async () => {
  const { runner, calls } = setup({ hydratedSoil: false });
  const result = await runner.run(task());
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "FARM_SOIL_NOT_HYDRATED");
  assert.equal(calls.filter((skill) => skill === "minecraft.plant-wheat").length, 0);
  assert.equal(calls.some((skill) => skill === "minecraft.till-soil" || skill === "minecraft.place-water"), false);
});

test("wheat runner fails closed when survival mode, living state, or hunger is unconfirmed", async () => {
  const cases: Array<{
    readonly player: Partial<MinecraftObservation["player"]>;
    readonly expectedCode: string;
  }> = [
    { player: { gameMode: null }, expectedCode: "FARM_REQUIRES_SURVIVAL" },
    { player: { alive: null }, expectedCode: "PLAYER_LIFE_UNCONFIRMED" },
    { player: { food: null }, expectedCode: "FARM_VITALS_TOO_LOW" },
  ];
  for (const scenario of cases) {
    const { runner, calls } = setup({ hydratedSoil: true, player: scenario.player });
    const result = await runner.run(task());
    assert.equal(result.status, "blocked");
    assert.equal(result.failure?.code, scenario.expectedCode);
    assert.equal(calls.length, 0, "do not inspect or plant until prerequisites are confirmed");
  }
});

test("wheat runner preflights seed inventory and never plants a partial field", async () => {
  const { runner, calls } = setup({ hydratedSoil: true, crop: "air" });
  const result = await runner.run(task(2, 1));
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "FARM_SEEDS_MISSING");
  assert.equal(calls.filter((skill) => skill === "minecraft.plant-wheat").length, 0);
});

test("a 1×50 farm surveys fully, then plants from the survey endpoint within bounded navigation reach", async () => {
  const { runner, calls, navigationTargets } = setup({
    hydratedSoil: true,
    crop: "air",
    inventory: [{ slot: 9, name: "wheat_seeds", type: 295, count: 50, metadata: null, durabilityUsed: null }],
    player: { position: { x: 0.5, y: 64, z: 24.5 } },
  });
  const result = await runner.run(task(1, 50));
  assert.equal(result.status, "succeeded");
  assert.equal(result.metrics.targetItemsGained, 50);
  assert.equal(calls.filter((skill) => skill === "minecraft.plant-wheat").length, 50);
  assert.ok(navigationTargets.length > 0);
  for (const target of navigationTargets) {
    assert.ok(Math.hypot(target.from.x - target.x, target.from.y - target.y, target.from.z - target.z) <= 48);
  }
});

test("an already planted wheat cell needs no extra seed and is left alone", async () => {
  const { runner, calls } = setup({ hydratedSoil: true, crop: "wheat" });
  const result = await runner.run(task());
  assert.equal(result.status, "succeeded");
  assert.equal(result.metrics.targetItemsGained, 1);
  assert.equal(calls.filter((skill) => skill === "minecraft.plant-wheat").length, 0);
});
