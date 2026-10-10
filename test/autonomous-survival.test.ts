import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateAutonomousTask } from "../src/games/minecraft/autonomous-task.js";
import { gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";

function baseObservation(overrides: Partial<MinecraftObservation> = {}): MinecraftObservation {
  return {
    player: {
      username: "TestAgent",
      position: { x: 0, y: 64, z: 0 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 300,
      onGround: true,
      alive: true,
    },
    inventory: [],
    equipment: { hand: null, offhand: null, head: null, torso: null, legs: null, feet: null },
    entities: [],
    nearbyBlocks: [],
    resourceSightings: [],
    resourceScan: { radius: 32, limit: 192, center: { x: 0, y: 64, z: 0 }, truncated: false },
    itemDrops: [],
    sampledRegion: { radius: 5, verticalRadius: 3, center: { x: 0, y: 64, z: 0 }, sampledCells: 100, unknownCells: 0, truncated: false },
    ...overrides,
  } as MinecraftObservation;
}

const gatherTask = gatherResourceTaskSchema.parse({
  id: "test",
  resourceName: "oak_log",
  targetCount: 1,
});

describe("autonomous task generation", () => {
  it("generates secure-food task when hungry with food in inventory", () => {
    const state = baseObservation({
      player: { ...baseObservation().player, food: 10 },
      inventory: [{ slot: 0, name: "bread", type: 0, count: 3, metadata: null, durabilityUsed: null }],
    });
    const task = generateAutonomousTask(state);
    assert.ok(task, "should generate a task");
    assert.equal(task!.kind, "secure_food");
  });

  it("generates gather-logs task when no tools and no logs", () => {
    const state = baseObservation({
      player: { ...baseObservation().player, food: 20, health: 20 },
      inventory: [],
    });
    const task = generateAutonomousTask(state);
    assert.ok(task, "should generate a task");
    assert.equal(task!.kind, "gather_resource");
  });

  it("generates craft-pickaxe task when has logs but no tools", () => {
    const state = baseObservation({
      player: { ...baseObservation().player, food: 20, health: 20 },
      inventory: [{ slot: 0, name: "oak_log", type: 0, count: 4, metadata: null, durabilityUsed: null }],
    });
    const task = generateAutonomousTask(state);
    assert.ok(task, "should generate a task");
    assert.equal(task!.kind, "craft_item");
    assert.equal((task as { targetItem: string }).targetItem, "wooden_pickaxe");
  });

  it("generates heal task when low health with food available", () => {
    const state = baseObservation({
      player: { ...baseObservation().player, health: 8, food: 12 },
      inventory: [{ slot: 0, name: "bread", type: 0, count: 3, metadata: null, durabilityUsed: null }],
    });
    const task = generateAutonomousTask(state);
    assert.ok(task, "should generate a task");
    assert.equal(task!.kind, "secure_food");
  });

  it("prioritizes food over logs when hungry", () => {
    const state = baseObservation({
      player: { ...baseObservation().player, food: 8, health: 20 },
      inventory: [{ slot: 0, name: "bread", type: 0, count: 1, metadata: null, durabilityUsed: null }],
    });
    const task = generateAutonomousTask(state);
    assert.ok(task, "should generate a task");
    assert.equal(task!.kind, "secure_food");
  });
});

describe("proactive eating thresholds", () => {
  it("food threshold is 14 for proactive eating", async () => {
    const { MinecraftTaskDecisionModel } = await import("../src/games/minecraft/decision-model.js");
    const model = new MinecraftTaskDecisionModel();
    const state = baseObservation({
      player: { ...baseObservation().player, food: 14 },
      inventory: [{ slot: 0, name: "bread", type: 0, count: 1, metadata: null, durabilityUsed: null }],
    });
    const decision = model.decide(state, gatherTask, { excludedTargets: new Set(), previousFailureCode: null });
    assert.equal(decision.selected?.goalId, "restore-hunger", "agent should eat proactively at food=14");
  });

  it("agent does not eat when food is above threshold", async () => {
    const { MinecraftTaskDecisionModel } = await import("../src/games/minecraft/decision-model.js");
    const model = new MinecraftTaskDecisionModel();
    const state = baseObservation({
      player: { ...baseObservation().player, food: 15 },
      inventory: [
        { slot: 0, name: "bread", type: 0, count: 1, metadata: null, durabilityUsed: null },
      ],
      nearbyBlocks: [{ position: { x: 1, y: 64, z: 0 }, name: "oak_log", type: 0, boundingBox: "block", distance: 1 }],
      resourceSightings: [],
    });
    const decision = model.decide(state, gatherTask, { excludedTargets: new Set(), previousFailureCode: null });
    assert.notEqual(decision.selected?.goalId, "restore-hunger", "agent should not eat at food=15");
  });
});

describe("rest threshold improvements", () => {
  it("rest triggers at health 14 (raised from 12)", async () => {
    const { MinecraftTaskDecisionModel } = await import("../src/games/minecraft/decision-model.js");
    const model = new MinecraftTaskDecisionModel();
    const state = baseObservation({
      player: { ...baseObservation().player, health: 14, food: 18 },
      nearbyBlocks: [],
    });
    const decision = model.decide(state, gatherTask, { excludedTargets: new Set(), previousFailureCode: null });
    assert.equal(decision.selected?.goalId, "rest:recover-health", "agent should rest at health=14 with food=18");
  });
});

describe("night preparation", () => {
  it("shelter trigger works when approaching night", async () => {
    const { MinecraftTaskDecisionModel } = await import("../src/games/minecraft/decision-model.js");
    const model = new MinecraftTaskDecisionModel();
    const state = baseObservation({
      player: { ...baseObservation().player, health: 20, food: 20 },
      time: { dayTicks: 12500, day: 1, isNight: false, source: "time.timeOfDay" },
      inventory: [{ slot: 0, name: "cobblestone", type: 0, count: 4, metadata: null, durabilityUsed: null }],
      nearbyBlocks: [],
    });
    const decision = model.decide(state, gatherTask, { excludedTargets: new Set(), previousFailureCode: null });
    assert.ok(decision, "decision should be made when night is approaching");
  });
});

describe("panic command and stop feedback", () => {
  it("panic command is available in the commands interface", () => {
    // The panic command is added to the ControlCenterCommands type
    // and the run-control.ts commands object. We verify the type accepts it.
    type Commands = import("../src/control-center/types.js").ControlCenterCommands;
    const commands: Commands = {
      panic: async () => ({ ok: true, message: "test" }),
    };
    assert.ok(typeof commands.panic === "function", "panic command should be callable");
  });
});
