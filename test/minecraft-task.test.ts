import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { DEFAULT_CRAFT_PICKAXE_TASK, DEFAULT_GATHER_LOG_TASK } from "../src/games/minecraft/task.js";
import { MinecraftTaskRunner } from "../src/games/minecraft/task-runner.js";
import {
  createFakeMinecraftFixture,
  FakeMinecraftAdapter,
  type FakeMinecraftAdapterOptions,
} from "../src/testing/fake-minecraft-adapter.js";

function makeTaskRunner(
  initialObservation?: MinecraftObservation,
  options: Partial<Omit<FakeMinecraftAdapterOptions, "seed" | "initialObservation">> = {},
) {
  const logger = pino({ level: "silent" });
  const sink = new MemoryTraceSink();
  const trace = new TraceRecorder(sink, logger);
  const adapter = new FakeMinecraftAdapter({
    seed: 1337,
    ...(initialObservation ? { initialObservation } : {}),
    ...options,
  });
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  return {
    adapter,
    logger,
    runtime,
    sink,
    runner: new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger),
  };
}

test("task loop waits through a confirmed death, recovers after respawn, and then replans", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const deadObservation: MinecraftObservation = {
    ...fixture,
    player: { ...fixture.player, health: 0, alive: false, deathCount: 1 },
  };
  const { runtime, runner, sink } = makeTaskRunner(deadObservation, { autoRespawnAfterObservations: 2 });
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "succeeded", result.failure?.message);
  assert.equal(result.metrics.deathsObserved, 1);
  assert.equal(result.metrics.respawnRecoveries, 1);
  assert.ok(sink.events.some((event) => event.eventType === "player.death"));
  assert.equal(result.finalObservation?.state.player.health, 20);
  assert.equal(result.metrics.resourceCollected, 1);
  await runtime.shutdown("respawn recovery test complete");
});

test("awaiting respawn respects the task deadline and does not attempt actions while dead", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const deadObservation: MinecraftObservation = {
    ...fixture,
    player: { ...fixture.player, health: 0, alive: false, deathCount: 1 },
  };
  const { runtime, runner } = makeTaskRunner(deadObservation);
  const result = await runner.run({ ...DEFAULT_GATHER_LOG_TASK, maxDurationMs: 200 });

  assert.equal(result.status, "timed_out");
  assert.equal(result.failure?.code, "TASK_DEADLINE");
  assert.equal(result.actions.length, 0);
  assert.equal(result.metrics.respawnRecoveries, 0);
  await runtime.shutdown("respawn deadline test complete");
});

test("bounded gather task collects an observed log, replans, and verifies inventory progress", async () => {
  const { runtime, runner, sink } = makeTaskRunner();
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "succeeded");
  assert.equal(result.failure, null);
  assert.equal(result.metrics.actions, 1);
  assert.equal(result.metrics.successfulActions, 1);
  assert.equal(result.metrics.resourceCollected, 1);
  assert.equal(result.metrics.taskSucceeded, true);
  assert.equal(result.metrics.targetItemsGained, 1);
  assert.equal(result.metrics.progressRatio, 1);
  assert.equal(result.metrics.decisions, 2);
  assert.equal(result.actions[0]?.skillId, "minecraft.collect-log");
  assert.equal(result.actions[0]?.confirmed, true);
  assert.equal(
    result.finalObservation?.state.inventory.find((item) => item.name === "oak_log")?.count,
    1,
  );
  assert.deepEqual(
    sink.events.filter((event) => event.eventType.startsWith("task.")).map((event) => event.eventType),
    ["task.started", "task.action", "task.completed"],
  );
  await runtime.shutdown("task test complete");
});

test("survival-prioritized wood plan crafts and places a table, gathers a missing log, then crafts a wooden pickaxe", async () => {
  const fixture = createFakeMinecraftFixture(2026);
  const initialObservation: MinecraftObservation = {
    ...fixture,
    inventory: [{
      slot: 9,
      name: "oak_log",
      type: 17,
      count: 2,
      metadata: null,
      durabilityUsed: null,
    }],
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run({ ...DEFAULT_CRAFT_PICKAXE_TASK, maxActions: 20 });

  assert.equal(result.status, "succeeded", result.failure?.message);
  assert.equal(result.metrics.taskSucceeded, true);
  assert.equal(result.metrics.targetItem, "wooden_pickaxe");
  assert.equal(result.metrics.targetItemsGained, 1);
  assert.equal(result.metrics.progressRatio, 1);
  assert.ok(result.metrics.progressEvents >= 5);
  assert.ok(result.actions.some((action) => action.skillId === "minecraft.place-crafting-table"));
  assert.ok(result.actions.some((action) => action.skillId === "minecraft.collect-log"));
  assert.equal(result.actions.at(-1)?.skillId, "minecraft.craft-item");
  assert.equal(result.finalObservation?.state.inventory.find((item) => item.name === "wooden_pickaxe")?.count, 1);
  assert.equal(result.metrics.failedActions, 0);
  assert.ok((result.metrics.itemsGained.oak_log ?? 0) >= 1);
  assert.ok((result.metrics.resourcesConsumed.oak_log ?? 0) >= 3);
  assert.ok(result.metrics.actions <= 20);
  await runtime.shutdown("craft task test complete");
});

test("low hunger is handled before gathering and food/resource costs are measured", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const initialObservation: MinecraftObservation = {
    ...fixture,
    player: { ...fixture.player, food: 6 },
    inventory: [{
      slot: 9,
      name: "apple",
      type: 260,
      count: 1,
      metadata: null,
      durabilityUsed: null,
    }],
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "succeeded");
  assert.equal(result.actions[0]?.skillId, "minecraft.eat-food");
  assert.equal(result.actions[1]?.skillId, "minecraft.collect-log");
  assert.equal(result.metrics.foodGained, 4);
  assert.equal(result.metrics.resourcesConsumed.apple, 1);
  assert.equal(result.metrics.resourceCollected, 1);
  assert.equal(result.metrics.damageTaken, 0);
  await runtime.shutdown("survival priority test complete");
});

test("critical hunger without food blocks task progress when exploration is disabled", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const initialObservation: MinecraftObservation = {
    ...fixture,
    player: { ...fixture.player, food: 2 },
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run({ ...DEFAULT_GATHER_LOG_TASK, maxExplorationLegs: 0 });

  assert.equal(result.status, "blocked");
  assert.equal(result.actions.length, 0);
  assert.match(result.failure?.message ?? "", /critically low/);
  assert.equal(result.metrics.taskSucceeded, false);
  await runtime.shutdown("no food test complete");
});

test("critical health blocks progress when no validated healing skill exists", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const initialObservation: MinecraftObservation = {
    ...fixture,
    player: { ...fixture.player, health: 5 },
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "blocked");
  assert.equal(result.actions.length, 0);
  assert.match(result.failure?.message ?? "", /no validated healing skill/);
  await runtime.shutdown("critical health test complete");
});

test("craft task reports missing observed prerequisites without attempting unsafe actions", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const initialObservation: MinecraftObservation = {
    ...fixture,
    nearbyBlocks: fixture.nearbyBlocks.filter((block) => !block.name.endsWith("_log")),
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run({ ...DEFAULT_CRAFT_PICKAXE_TASK, maxExplorationLegs: 0 });

  assert.equal(result.status, "blocked");
  assert.equal(result.metrics.actions, 0);
  assert.match(result.failure?.message ?? "", /safe nearby logs/);
  await runtime.shutdown("missing crafting prerequisite test complete");
});

test("nearby hostile mobs outrank collection and the task only gathers after moving away", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const player = fixture.player.position;
  const initialObservation: MinecraftObservation = {
    ...fixture,
    entities: [
      {
        id: "fixture-zombie",
        name: "zombie",
        type: "mob",
        position: { x: player.x + 2, y: player.y, z: player.z },
        distance: 2,
        health: 20,
      },
    ],
    nearbyBlocks: fixture.nearbyBlocks.map((block) =>
      block.name === "oak_log"
        ? {
            ...block,
            position: {
              x: Math.floor(player.x) - 8,
              y: Math.floor(player.y),
              z: Math.floor(player.z),
            },
          }
        : block,
    ),
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "succeeded");
  assert.equal(result.metrics.actions, 2);
  assert.equal(result.actions[0]?.goalId, "avoid-nearby-hostile");
  assert.equal(result.actions[0]?.skillId, "minecraft.navigate");
  assert.equal(result.actions[1]?.goalId, "collect:oak_log");
  assert.equal(result.metrics.damageTaken, 0);
  assert.equal(result.metrics.resourceCollected, 1);
  await runtime.shutdown("danger-priority test complete");
});

test("a resource beside a visible hostile remains blocked even after the player flees", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const player = fixture.player.position;
  const initialObservation: MinecraftObservation = {
    ...fixture,
    entities: [
      {
        id: "fixture-zombie",
        name: "zombie",
        type: "mob",
        position: { x: player.x + 2, y: player.y, z: player.z },
        distance: 2,
        health: 20,
      },
    ],
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run({ ...DEFAULT_GATHER_LOG_TASK, maxExplorationLegs: 0 });

  assert.equal(result.status, "blocked");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]?.skillId, "minecraft.navigate");
  assert.equal(result.metrics.resourceCollected, 0);
  assert.match(result.failure?.message ?? "", /inside the 6-block danger radius/);
  await runtime.shutdown("hostile-resource safety test complete");
});

test("exhausting flee targets never demotes an active danger constraint to gathering", () => {
  const fixture = createFakeMinecraftFixture(1337);
  const player = fixture.player.position;
  const state: MinecraftObservation = {
    ...fixture,
    entities: [
      {
        id: "fixture-zombie",
        name: "zombie",
        type: "mob",
        position: { x: player.x + 2, y: player.y, z: player.z },
        distance: 2,
        health: 20,
      },
    ],
  };
  const model = new MinecraftTaskDecisionModel();
  const excludedTargets = new Set<string>();
  let replanned = model.decide(state, DEFAULT_GATHER_LOG_TASK, {
    excludedTargets,
    previousFailureCode: null,
  });
  for (let attempt = 0; attempt < 4 && replanned.terminalStatus === null; attempt += 1) {
    const newFleeTargets = [replanned.selected, ...replanned.alternatives]
      .filter((candidate) => candidate?.targetKey?.startsWith("flee:"))
      .map((candidate) => candidate?.targetKey)
      .filter((targetKey): targetKey is string => typeof targetKey === "string")
      .filter((targetKey) => !excludedTargets.has(targetKey));
    for (const targetKey of newFleeTargets) excludedTargets.add(targetKey);
    replanned = model.decide(state, DEFAULT_GATHER_LOG_TASK, {
      excludedTargets,
      previousFailureCode: "NAVIGATION_FAILED",
    });
  }
  assert.ok(excludedTargets.size >= 3);
  assert.equal(replanned.terminalStatus, "blocked");
  assert.equal(replanned.selected, null);
  assert.equal(replanned.alternatives.length, 0);
  assert.match(replanned.summary, /stop rather than approach a resource/);
});

test("failed resource target is excluded and replanning selects a different observed log", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const firstLog = fixture.nearbyBlocks.find((block) => block.name === "oak_log");
  assert.ok(firstLog);
  const initialObservation: MinecraftObservation = {
    ...fixture,
    nearbyBlocks: [
      ...fixture.nearbyBlocks,
      {
        ...firstLog,
        position: { ...firstLog.position, x: firstLog.position.x + 1 },
      },
    ],
  };
  const { adapter, runtime, runner } = makeTaskRunner(initialObservation);
  adapter.failNextAction(new Error("scripted first-target failure"));
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "succeeded");
  assert.equal(result.metrics.actions, 2);
  assert.equal(result.metrics.failedActions, 1);
  assert.equal(result.metrics.successfulActions, 1);
  assert.equal(result.actions[0]?.status, "failed");
  assert.equal(result.actions[1]?.status, "succeeded");
  assert.notEqual(result.actions[0]?.targetKey, result.actions[1]?.targetKey);
  assert.equal(result.metrics.resourceCollected, 1);
  assert.equal(result.metrics.recoveryAttempts, 1);
  assert.equal(result.metrics.successfulRecoveries, 1);
  await runtime.shutdown("replanning test complete");
});

test("stuck navigation is recognized, excluded, and followed by a successful recovery route", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const player = fixture.player.position;
  const initialObservation: MinecraftObservation = {
    ...fixture,
    entities: [{
      id: "fixture-zombie",
      name: "zombie",
      type: "mob",
      position: { x: player.x + 2, y: player.y, z: player.z },
      distance: 2,
      health: 20,
    }],
    nearbyBlocks: fixture.nearbyBlocks.map((block) => block.name === "oak_log"
      ? { ...block, position: { x: Math.floor(player.x) - 8, y: Math.floor(player.y), z: Math.floor(player.z) } }
      : block),
  };
  const { adapter, runtime, runner } = makeTaskRunner(initialObservation);
  adapter.failNextNavigation();
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "succeeded", result.failure?.message);
  assert.equal(result.metrics.stuckActions, 1);
  assert.equal(result.metrics.failedActions, 1);
  assert.equal(result.metrics.recoveryAttempts, 1);
  assert.equal(result.metrics.successfulRecoveries, 1);
  assert.equal(result.actions[0]?.failureCode, "NAVIGATION_STUCK");
  assert.notEqual(result.actions[0]?.targetKey, result.actions[1]?.targetKey);
  await runtime.shutdown("navigation recovery test complete");
});

test("a fixture obstacle blocks one route and the task replans onto a different flee target", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const player = fixture.player.position;
  const initialObservation: MinecraftObservation = {
    ...fixture,
    entities: [{
      id: "fixture-creeper",
      name: "creeper",
      type: "mob",
      position: { x: player.x + 2, y: player.y, z: player.z },
      distance: 2,
      health: 20,
    }],
    nearbyBlocks: fixture.nearbyBlocks.map((block) => block.name === "oak_log"
      ? { ...block, position: { x: Math.floor(player.x) - 8, y: Math.floor(player.y), z: Math.floor(player.z) } }
      : block),
  };
  const initialDecision = new MinecraftTaskDecisionModel().decide(initialObservation, DEFAULT_GATHER_LOG_TASK, {
    excludedTargets: new Set(),
    previousFailureCode: null,
  });
  assert.ok(initialDecision.selected);
  const blocked = initialDecision.selected.input as { x: number; y: number; z: number };
  const { runtime, runner } = makeTaskRunner(initialObservation, {
    unreachableNavigationTargets: [`${blocked.x},${blocked.y},${blocked.z}`],
  });
  const result = await runner.run(DEFAULT_GATHER_LOG_TASK);

  assert.equal(result.status, "succeeded", result.failure?.message);
  assert.equal(result.metrics.failedActions, 1);
  assert.equal(result.metrics.recoveryAttempts, 1);
  assert.notEqual(result.actions[0]?.targetKey, result.actions[1]?.targetKey);
  await runtime.shutdown("obstacle path recovery test complete");
});

test("task action budget is enforced before starting another decision action", async () => {
  const fixture = createFakeMinecraftFixture(1337);
  const player = fixture.player.position;
  const initialObservation: MinecraftObservation = {
    ...fixture,
    entities: [
      {
        id: "fixture-creeper",
        name: "creeper",
        type: "mob",
        position: { x: player.x + 2, y: player.y, z: player.z },
        distance: 2,
        health: 20,
      },
    ],
    nearbyBlocks: fixture.nearbyBlocks.map((block) =>
      block.name === "oak_log"
        ? {
            ...block,
            position: {
              x: Math.floor(player.x) - 8,
              y: Math.floor(player.y),
              z: Math.floor(player.z),
            },
          }
        : block,
    ),
  };
  const { runtime, runner } = makeTaskRunner(initialObservation);
  const result = await runner.run({ ...DEFAULT_GATHER_LOG_TASK, maxActions: 1 });

  assert.equal(result.status, "max_actions");
  assert.equal(result.failure?.code, "TASK_ACTION_BUDGET");
  assert.equal(result.metrics.actions, 1);
  assert.equal(result.actions[0]?.skillId, "minecraft.navigate");
  await runtime.shutdown("budget test complete");
});
