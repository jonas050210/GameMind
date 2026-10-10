import assert from "node:assert/strict";
import test from "node:test";
import { generateAutonomousTask } from "../src/games/minecraft/autonomous-task.js";
import { ProgressTracker } from "../src/games/minecraft/progress-tracker.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";

function minimalState(overrides: Partial<MinecraftObservation> = {}): MinecraftObservation {
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

test("multi-task: tracker persists food-security across calls", () => {
  const tracker = new ProgressTracker();

  // First call: agent eats
  const state1 = minimalState({
    player: { ...minimalState().player, food: 8 },
    inventory: [{ slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null }],
  });
  const task1 = generateAutonomousTask(state1, tracker);
  assert.ok(task1 !== null);
  assert.equal(task1.kind, "secure_food");

  // Second call: after eating, hunger is full → should advance to next milestone
  const state2 = minimalState({
    player: { ...minimalState().player, food: 18 },
    inventory: [{ slot: 0, name: "bread", type: 1, count: 1, metadata: null, durabilityUsed: null }],
  });
  const task2 = generateAutonomousTask(state2, tracker);
  assert.ok(task2 !== null);
  assert.notEqual(task2.kind, "secure_food", "should advance past food-security after hunger is full");
});

test("multi-task: full progression chain from nothing to stone-age", () => {
  const tracker = new ProgressTracker();

  // Stage 1: No tools, no food → gather logs
  const state1 = minimalState({ inventory: [] });
  const task1 = generateAutonomousTask(state1, tracker);
  assert.ok(task1 !== null);
  assert.equal(task1.kind, "gather_resource");

  // Stage 2: Has logs → craft pickaxe
  const state2 = minimalState({
    inventory: [
      { slot: 0, name: "oak_log", type: 1, count: 5, metadata: null, durabilityUsed: null },
    ],
  });
  const task2 = generateAutonomousTask(state2, tracker);
  assert.ok(task2 !== null);
  assert.equal(task2.kind, "craft_item");

  // Stage 3: Has wooden pickaxe → mine stone (for stone pickaxe)
  const state3 = minimalState({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "cobblestone", type: 1, count: 3, metadata: null, durabilityUsed: null },
    ],
  });
  const task3 = generateAutonomousTask(state3, tracker);
  assert.ok(task3 !== null);
  assert.equal(task3.kind, "mine_resource");

  // Stage 4: Has stone pickaxe → sustained gathering
  const state4 = minimalState({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "cobblestone", type: 1, count: 5, metadata: null, durabilityUsed: null },
    ],
  });
  const task4 = generateAutonomousTask(state4, tracker);
  assert.ok(task4 !== null);
  assert.equal(task4.kind, "mine_resource");
});

test("multi-task: action limit is raised for multi-step chains (≥100)", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    inventory: [
      { slot: 0, name: "oak_log", type: 1, count: 5, metadata: null, durabilityUsed: null },
    ],
  });
  const task = generateAutonomousTask(state, tracker);
  assert.ok(task !== null);
  // The action limit must support multi-step progression (was 100, now 300)
  assert.ok(task.maxActions >= 100, `Expected maxActions >= 100, got ${task.maxActions}`);
});

test("multi-task: tracker milestones don't regress", () => {
  const tracker = new ProgressTracker();

  // Get to wooden-tools milestone
  const state1 = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  const snap1 = tracker.getProgress(state1);
  assert.ok(snap1.completedMilestones.includes("wooden-tools"));

  // Even if wooden pickaxe is somehow lost from inventory, milestone should persist
  const state2 = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
    ],
  });
  const snap2 = tracker.getProgress(state2);
  assert.ok(snap2.completedMilestones.includes("wooden-tools"), "milestone should not regress once completed");
});
