import assert from "node:assert/strict";
import test from "node:test";
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

test("progress tracker: starts at food-security when hunger is low", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    player: { ...minimalState().player, food: 8 },
    inventory: [{ slot: 0, name: "bread", type: 1, count: 1, metadata: null, durabilityUsed: null }],
  });
  const snapshot = tracker.getProgress(state);
  assert.equal(snapshot.currentMilestone, "food-security");
});

test("progress tracker: advances past food-security when hunger is full", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
    ],
  });
  const snapshot = tracker.getProgress(state);
  // With full hunger and no tools, should be at wooden-tools
  assert.equal(snapshot.currentMilestone, "wooden-tools");
  assert.ok(snapshot.completedMilestones.includes("food-security"));
});

test("progress tracker: recognizes wooden-tools completion with wooden pickaxe", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  const snapshot = tracker.getProgress(state);
  assert.ok(snapshot.completedMilestones.includes("food-security"));
  assert.ok(snapshot.completedMilestones.includes("wooden-tools"));
  // Shelter comes next (contextual — only triggers at night)
  assert.equal(snapshot.currentMilestone, "shelter");
});

test("progress tracker: recognizes stone-age completion with stone pickaxe", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  const snapshot = tracker.getProgress(state);
  assert.ok(snapshot.completedMilestones.includes("stone-age"));
});

test("progress tracker: counts inventory correctly", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    inventory: [
      { slot: 0, name: "oak_log", type: 1, count: 5, metadata: null, durabilityUsed: null },
      { slot: 1, name: "cobblestone", type: 1, count: 12, metadata: null, durabilityUsed: null },
      { slot: 2, name: "stick", type: 1, count: 4, metadata: null, durabilityUsed: null },
      { slot: 3, name: "coal", type: 1, count: 3, metadata: null, durabilityUsed: null },
    ],
  });
  const snapshot = tracker.getProgress(state);
  assert.equal(snapshot.inventory.logs, 5);
  assert.equal(snapshot.inventory.cobblestone, 12);
  assert.equal(snapshot.inventory.sticks, 4);
  assert.equal(snapshot.inventory.coal, 3);
  assert.equal(snapshot.inventory.food, 0);
});

test("progress tracker: serializes and restores across restarts", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  tracker.getProgress(state);

  const serialized = tracker.toJSON();
  const restored = ProgressTracker.fromJSON(serialized);
  const state2 = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
    ],
  });
  const snapshot2 = restored.getProgress(state2);
  assert.ok(snapshot2.completedMilestones.includes("wooden-tools"));
  assert.ok(snapshot2.completedMilestones.includes("stone-age"));
});

test("progress tracker: milestones list has all milestones", () => {
  const tracker = new ProgressTracker();
  const state = minimalState();
  const snapshot = tracker.getProgress(state);
  assert.ok(snapshot.milestones.length >= 5);
  const ids = snapshot.milestones.map((m) => m.id);
  assert.ok(ids.includes("food-security"));
  assert.ok(ids.includes("wooden-tools"));
  assert.ok(ids.includes("shelter"));
  assert.ok(ids.includes("stone-age"));
  assert.ok(ids.includes("sustained-gathering"));
});

test("progress tracker: iron-age milestone requires iron pickaxe", () => {
  const tracker = new ProgressTracker();
  // Has stone pickaxe but NOT iron pickaxe
  const state = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  const snapshot = tracker.getProgress(state);
  assert.ok(!snapshot.completedMilestones.includes("iron-age"));
});

test("progress tracker: iron-age completed with iron pickaxe", () => {
  const tracker = new ProgressTracker();
  const state = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 3, name: "iron_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  const snapshot = tracker.getProgress(state);
  assert.ok(snapshot.completedMilestones.includes("iron-age"));
});
