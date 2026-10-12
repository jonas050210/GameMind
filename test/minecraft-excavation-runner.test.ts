import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import type { GameMindRuntime } from "../src/core/game-mind-runtime.js";
import type { SkillRuntime } from "../src/core/skill-runtime.js";
import type { ActionResult, WorldState } from "../src/core/types.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { excavateVolumeTaskSchema } from "../src/games/minecraft/task.js";
import { MinecraftTaskRunner } from "../src/games/minecraft/task-runner.js";
import { createFakeMinecraftFixture } from "../src/testing/fake-minecraft-adapter.js";

const target = { x: 5, y: 63, z: 6 };

type SkillCall = { skillId: string; input: unknown };

function makeWorld(state: MinecraftObservation, sequence: number): WorldState<MinecraftObservation> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    gameId: "minecraft-java",
    gameVersion: "1.20.4",
    sessionId: "test-session",
    sequence,
    observedAt: now,
    receivedAt: now,
    state,
  };
}

function makeRunner(options: {
  readonly inspectionName?: string | null;
  readonly inspectionBlocks?: Readonly<Record<string, string | null>>;
  readonly navFails?: boolean;
  readonly startInFootprint?: boolean;
  readonly moveOnNavigation?: boolean;
  readonly startPosition?: MinecraftObservation["player"]["position"];
  readonly navigationPosition?: MinecraftObservation["player"]["position"];
    readonly player?: Partial<MinecraftObservation["player"]>;
    readonly unsafeBeforeDestructive?: boolean;
    readonly wrongSessionBeforeDestructive?: boolean;
  } = {}) {
  const fixture = createFakeMinecraftFixture(1337);
  let currentState: MinecraftObservation = {
    ...structuredClone(fixture),
    player: {
      ...fixture.player,
      position: options.startPosition ?? (options.startInFootprint
        ? { x: target.x + 0.5, y: 64, z: target.z + 0.5 }
        : { x: target.x - 0.5, y: 64, z: target.z + 0.5 }),
      alive: true,
      ...options.player,
    },
  };
  let world = makeWorld(currentState, 1);
  let observationCount = 0;
  let nextActionId = 1;
  const calls: SkillCall[] = [];
  const minedPlayerPositions: MinecraftObservation["player"]["position"][] = [];
  const traceEvents: Array<{ eventType: string; data: Readonly<Record<string, unknown>> }> = [];
  const logger = pino({ level: "silent" });
  const runtime = {
    adapter: { status: "connected", gameId: "minecraft-java" },
    session: { id: "test-session", gameId: "minecraft-java", gameVersion: "1.20.4", connectedAt: new Date().toISOString() },
    safety: { startRun: () => undefined },
    trace: { record: async (event: { eventType: string; data: Readonly<Record<string, unknown>> }) => { traceEvents.push(event); } },
    get currentWorldState() { return world; },
    observeIfStale: async () => {
      observationCount += 1;
      if (observationCount === 3 && options.unsafeBeforeDestructive) {
        currentState = {
          ...currentState,
          player: { ...currentState.player, position: { x: target.x + 0.5, y: 64, z: target.z + 0.5 } },
        };
        world = makeWorld(currentState, world.sequence + 1);
      }
      if (observationCount === 3 && options.wrongSessionBeforeDestructive) {
        return { ...world, sessionId: "different-session" };
      }
      return world;
    },
  } as unknown as GameMindRuntime<MinecraftObservation>;
  const skills = {
    run: async (skillId: string, input: unknown) => {
      calls.push({ skillId, input });
      const before = world;
      const actionId = `action-${nextActionId++}`;
      let status: ActionResult["status"] = "succeeded";
      let failure: ActionResult["failure"] = null;
      let confirmed = true;
      let details: Readonly<Record<string, unknown>> | null = null;
      if (skillId === "minecraft.inspect-block") {
        const position = input as { x: number; y: number; z: number };
        const distance = Math.hypot(
          position.x - currentState.player.position.x,
          position.y - currentState.player.position.y,
          position.z - currentState.player.position.z,
        );
        if (distance > 7) {
          status = "failed";
          confirmed = false;
          failure = { code: "BLOCK_OUT_OF_RANGE", message: "Block is outside the local inspection radius." };
        } else {
          const key = `${position.x},${position.y},${position.z}`;
          const actual = options.inspectionBlocks
            ? (options.inspectionBlocks[key] ?? "air")
            : options.inspectionName === undefined
              ? currentState.nearbyBlocks.find((block) => block.position.x === position.x && block.position.y === position.y && block.position.z === position.z)?.name ?? null
              : options.inspectionName;
          if (actual === null) {
            status = "failed";
            confirmed = false;
            failure = { code: "BLOCK_UNKNOWN", message: "Block is unknown." };
          } else {
            details = { name: actual, boundingBox: actual === "air" ? "empty" : "block", canDig: true };
          }
        }
      } else if (skillId === "minecraft.navigate") {
        if (options.navFails) {
          status = "failed";
          confirmed = false;
          failure = { code: "PATH_NOT_FOUND", message: "No safe path to inspect the cell." };
        } else if (options.startInFootprint || options.moveOnNavigation) {
          const goal = input as { x: number; y: number; z: number };
          currentState = {
            ...currentState,
            player: { ...currentState.player, position: options.navigationPosition ?? { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 } },
          };
          world = makeWorld(currentState, world.sequence + 1);
        }
      } else if (skillId === "minecraft.mine-block") {
        const position = input as { x: number; y: number; z: number };
        minedPlayerPositions.push({ ...currentState.player.position });
        currentState = {
          ...currentState,
          nearbyBlocks: currentState.nearbyBlocks.filter((block) => !(block.position.x === position.x && block.position.y === position.y && block.position.z === position.z)),
          inventory: [...currentState.inventory, { slot: 9, name: "dirt", type: 3, count: 1, metadata: null, durabilityUsed: null }],
        };
        world = makeWorld(currentState, world.sequence + 1);
      } else {
        status = "failed";
        confirmed = false;
        failure = { code: "UNEXPECTED_SKILL", message: `Unexpected skill ${skillId}.` };
      }
      const action: ActionResult = {
        actionId,
        sessionId: "test-session",
        capability: skillId,
        status,
        confirmed,
        confirmation: confirmed ? "fixture-confirmed" : null,
        requestedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        failure,
        details,
      };
      const after = world;
      return { skillId, action, observationBefore: before, observationAfter: after };
    },
  } as unknown as SkillRuntime<MinecraftObservation>;
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger);
  const task = excavateVolumeTaskSchema.parse({
    id: "test-one-cell-excavation",
    kind: "excavate_volume",
    origin: target,
    width: 1,
    height: 1,
    depth: 1,
    maxActions: 20,
    maxDurationMs: 10_000,
  });
  return { runner, task, calls, traceEvents, minedPlayerPositions, get world() { return world; } };
}

test("volume excavation inspects each cell and verifies the block removal before counting progress", async () => {
  const { runner, task, calls, traceEvents, world: _initialWorld } = makeRunner();
  void _initialWorld;
  const result = await runner.run(task);
  assert.equal(result.status, "succeeded", result.failure?.message);
  assert.equal(result.metrics.minedBlocks, 1);
  assert.equal(result.metrics.progressRatio, 1);
  assert.equal(result.metrics.targetItemsGained, 1);
  assert.deepEqual(calls.map((call) => call.skillId), ["minecraft.inspect-block", "minecraft.mine-block"]);
  assert.equal(result.actions[1]?.verification, "verified");
  assert.ok(traceEvents.some((event) => event.eventType === "task.completed"));
});

test("out-of-range excavation cells are approached from outside the footprint before any block is mined", async () => {
  const { runner, task, calls, minedPlayerPositions } = makeRunner({
    moveOnNavigation: true,
    startPosition: { x: -3, y: 64, z: 6.5 },
  });
  const result = await runner.run(task);
  assert.equal(result.status, "succeeded", result.failure?.message);
  const navigation = calls.find((call) => call.skillId === "minecraft.navigate");
  assert.ok(navigation);
  const goal = navigation.input as { readonly x: number; readonly z: number };
  assert.ok(goal.x < target.x || goal.x > target.x || goal.z < target.z || goal.z > target.z, "navigation must target the perimeter, not a cell above the excavation");
  assert.equal(minedPlayerPositions.length, 1);
  const miningPosition = minedPlayerPositions[0];
  assert.ok(miningPosition);
  assert.ok(Math.floor(miningPosition.x) < target.x || Math.floor(miningPosition.x) > target.x || Math.floor(miningPosition.z) < target.z || Math.floor(miningPosition.z) > target.z, "the player must remain outside the excavated x/z footprint when mining");
});

test("excavation refuses to dig if a successful perimeter navigation nevertheless ends over the footprint", async () => {
  const { runner, task, calls } = makeRunner({
    moveOnNavigation: true,
    startPosition: { x: -3, y: 64, z: 6.5 },
    navigationPosition: { x: 5.5, y: 64, z: 6.5 },
  });
  const result = await runner.run(task);
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "PLAYER_OVER_EXCAVATION");
  assert.equal(calls.some((call) => call.skillId === "minecraft.mine-block"), false);
});

test("fresh excavation safety is rechecked immediately before mining and a player who entered the footprint is refused", async () => {
  const { runner, task, calls } = makeRunner({ unsafeBeforeDestructive: true });
  const result = await runner.run(task);
  assert.equal(result.status, "blocked");
  assert.equal(result.failure?.code, "PLAYER_OVER_EXCAVATION");
  assert.equal(calls.some((call) => call.skillId === "minecraft.mine-block" || call.skillId === "minecraft.collect-log"), false);
});

test("excavation refuses a destructive call if its fresh observation belongs to another session", async () => {
  const { runner, task, calls } = makeRunner({ wrongSessionBeforeDestructive: true });
  const result = await runner.run(task);
  assert.equal(result.status, "disconnected");
  assert.equal(result.failure?.code, "WORLD_STATE_UNAVAILABLE");
  assert.equal(calls.some((call) => call.skillId === "minecraft.mine-block" || call.skillId === "minecraft.collect-log"), false);
});

test("volume excavation refuses destructive work when life, survival mode, or hunger is unconfirmed", async () => {
  const cases: Array<{
    readonly player: Partial<MinecraftObservation["player"]>;
    readonly expectedCode: string;
  }> = [
    { player: { alive: null }, expectedCode: "PLAYER_LIFE_UNCONFIRMED" },
    { player: { gameMode: null }, expectedCode: "EXCAVATION_REQUIRES_SURVIVAL" },
    { player: { food: null }, expectedCode: "EXCAVATION_VITALS_TOO_LOW" },
  ];
  for (const scenario of cases) {
    const { runner, task, calls } = makeRunner({ player: scenario.player });
    const result = await runner.run(task);
    assert.equal(result.status, "blocked");
    assert.equal(result.failure?.code, scenario.expectedCode);
    assert.equal(calls.length, 0, "no inspection, navigation, or mining without verified prerequisites");
  }
});

test("volume excavation verifies that the player has left the footprint before the first destructive action", async () => {
  const { runner, task, calls } = makeRunner({ startInFootprint: true });
  const result = await runner.run(task);
  assert.equal(result.status, "succeeded", result.failure?.message);
  const firstMine = calls.findIndex((call) => call.skillId === "minecraft.mine-block");
  const firstExit = calls.findIndex((call) => call.skillId === "minecraft.navigate");
  assert.ok(firstExit >= 0);
  assert.ok(firstMine > firstExit, "an exit navigation must be confirmed before any mining");
});

test("volume excavation skips only observed air and refuses unknown or unsupported cells", async () => {
  const air = makeRunner({ inspectionName: "air" });
  const airResult = await air.runner.run(air.task);
  assert.equal(airResult.status, "succeeded");
  assert.equal(airResult.metrics.minedBlocks, 0);
  assert.deepEqual(air.calls.map((call) => call.skillId), ["minecraft.inspect-block"]);

  const unknown = makeRunner({ inspectionName: null, navFails: true });
  const unknownResult = await unknown.runner.run(unknown.task);
  assert.equal(unknownResult.status, "blocked");
  assert.equal(unknownResult.failure?.code, "PATH_NOT_FOUND");
  assert.equal(unknown.calls.some((call) => call.skillId === "minecraft.mine-block"), false);

  const unsupported = makeRunner({ inspectionName: "obsidian" });
  const unsupportedResult = await unsupported.runner.run(unsupported.task);
  assert.equal(unsupportedResult.status, "blocked");
  assert.equal(unsupportedResult.failure?.code, "EXCAVATION_UNSUPPORTED_BLOCK");
  assert.equal(unsupported.calls.some((call) => call.skillId === "minecraft.mine-block"), false);
});

test("excavation schema limits each axis and total cell count", () => {
  const base = { id: "bounded", kind: "excavate_volume" as const, origin: target, width: 10, height: 10, depth: 10 };
  assert.equal(excavateVolumeTaskSchema.safeParse(base).success, true);
  assert.equal(excavateVolumeTaskSchema.safeParse({ ...base, width: 11 }).success, false);
  assert.equal(excavateVolumeTaskSchema.safeParse({ ...base, origin: { ...target, y: 505 }, height: 10 }).success, false);
});
