import assert from "node:assert/strict";
import test from "node:test";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { gatherResourceTaskSchema, mineResourceTaskSchema, craftItemTaskSchema } from "../src/games/minecraft/task.js";

function baseState(overrides: Partial<MinecraftObservation> = {}): MinecraftObservation {
  return {
    player: {
      username: "TestBot",
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
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: false },
    itemDrops: [],
    sampledRegion: { radius: 24, verticalRadius: 8, center: { x: 0, y: 64, z: 0 }, sampledCells: 0, unknownCells: 0, truncated: false },
    time: { dayTicks: 6000, day: 1, isNight: false },
    ...overrides,
  } as MinecraftObservation;
}

test("useful drop: picks up cobblestone during gather-logs task", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = baseState({
    inventory: [{ slot: 0, name: "oak_log", type: 1, count: 3, metadata: null, durabilityUsed: null }],
    itemDrops: [{
      id: "drop-1",
      name: "cobblestone",
      count: 4,
      position: { x: 3, y: 64, z: 0 },
      distance: 3,
    }],
    // No blocks in view so gather has nothing to target
  });
  const task = gatherResourceTaskSchema.parse({
    id: "test-gather",
    resourceName: "oak_log",
    targetCount: 4,
    maxActions: 10,
  });

  const result = model.decide(state, task);
  assert.ok(result.selected !== null, "Should have a decision");
  // The useful drop should be selected since there are no logs to gather
  assert.ok(
    result.selected.goalId === "pickup:cobblestone",
    `Expected pickup:cobblestone, got ${result.selected.goalId}`,
  );
});

test("useful drop: picks up stick during mine-stone task", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = baseState({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
    equipment: {
      hand: { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      offhand: null, head: null, torso: null, legs: null, feet: null,
    },
    nearbyBlocks: [{ position: { x: 10, y: 64, z: 0 }, name: "stone", type: 1, boundingBox: "block", distance: 10 }],
    itemDrops: [{
      id: "drop-1",
      name: "stick",
      count: 3,
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
    }],
  });
  const task = mineResourceTaskSchema.parse({
    id: "test-mine",
    resourceName: "stone",
    targetCount: 4,
    maxActions: 10,
  });

  const result = model.decide(state, task);
  assert.ok(result.selected !== null);
  // Close stick drop should be preferred over distant stone
  const allGoals = [result.selected.goalId, ...result.alternatives.map((a: { goalId: string }) => a.goalId)];
  assert.ok(
    allGoals.includes("pickup:stick") || result.selected.goalId === "pickup:stick",
    `Expected stick pickup in candidates, got: ${allGoals.join(", ")}`,
  );
});

test("useful drop: ignores non-useful items (dirt)", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = baseState({
    inventory: [{ slot: 0, name: "oak_log", type: 1, count: 3, metadata: null, durabilityUsed: null }],
    itemDrops: [{
      id: "drop-1",
      name: "dirt",
      count: 10,
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
    }],
  });
  const task = gatherResourceTaskSchema.parse({
    id: "test-gather",
    resourceName: "oak_log",
    targetCount: 4,
    maxActions: 10,
  });

  const result = model.decide(state, task);
  // Should not pick up dirt — it's not in the useful items set
  if (result.selected) {
    assert.ok(
      !result.selected.goalId.includes("pickup:dirt"),
      "Should not pick up dirt as it's not a useful drop",
    );
  }
});

test("useful drop: avoids drop near hostile", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = baseState({
    inventory: [{ slot: 0, name: "oak_log", type: 1, count: 3, metadata: null, durabilityUsed: null }],
    itemDrops: [{
      id: "drop-1",
      name: "cobblestone",
      count: 4,
      position: { x: 3, y: 64, z: 0 },
      distance: 3,
    }],
    entities: [{
      id: "z1",
      name: "zombie",
      type: "hostile",
      position: { x: 4, y: 64, z: 0 },
      distance: 4,
      health: 20,
    }],
  });
  const task = gatherResourceTaskSchema.parse({
    id: "test-gather",
    resourceName: "oak_log",
    targetCount: 4,
    maxActions: 10,
    dangerRadius: 6,
  });

  const result = model.decide(state, task);
  // The cobblestone drop is within the danger radius of a hostile
  if (result.selected) {
    assert.ok(
      result.selected.goalId !== "pickup:cobblestone",
      "Should not pick up a drop within the danger radius of a hostile",
    );
  }
});

test("useful drop: skips when it matches the task target (already handled by task candidates)", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = baseState({
    itemDrops: [{
      id: "drop-1",
      name: "oak_log",
      count: 1,
      position: { x: 3, y: 64, z: 0 },
      distance: 3,
    }],
  });
  const task = gatherResourceTaskSchema.parse({
    id: "test-gather",
    resourceName: "oak_log",
    targetCount: 1,
    maxActions: 10,
  });

  const result = model.decide(state, task);
  assert.ok(result.selected !== null);
  // The task-specific gather candidate handles this, not the useful-drop candidate
  // The goalId should be from gatherCandidates, not usefulDropCandidate
  assert.ok(
    result.selected.goalId === "pickup:oak_log",
    `Expected pickup:oak_log, got ${result.selected.goalId}`,
  );
});
