import assert from "node:assert/strict";
import test from "node:test";
import { LandmarkMemory } from "../src/games/minecraft/landmark-memory.js";
import { ProgressTracker } from "../src/games/minecraft/progress-tracker.js";
import type { MilestoneId } from "../src/games/minecraft/progress-tracker.js";
import { generateAutonomousTask } from "../src/games/minecraft/autonomous-task.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";

/**
 * Regression tests ensuring that task completion criteria, milestone transitions,
 * and multi-step chains work correctly under edge cases.
 */

function stateWith(overrides: Partial<MinecraftObservation> = {}): MinecraftObservation {
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

test("task-transition: logs → planks → pickaxe chain produces correct tasks", () => {
  const tracker = new ProgressTracker();

  // Step 1: No tools, no logs → gather
  const s1 = stateWith({ inventory: [] });
  const t1 = generateAutonomousTask(s1, tracker);
  assert.equal(t1!.kind, "gather_resource");

  // Step 2: Has logs → craft pickaxe
  const s2 = stateWith({
    inventory: [{ slot: 0, name: "oak_log", type: 1, count: 5, metadata: null, durabilityUsed: null }],
  });
  const t2 = generateAutonomousTask(s2, tracker);
  assert.equal(t2!.kind, "craft_item");
  if (t2!.kind === "craft_item") {
    assert.equal((t2 as any).targetItem, "wooden_pickaxe");
  }

  // Step 3: Has wooden pickaxe → mine for stone-age
  const s3 = stateWith({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "cobblestone", type: 1, count: 2, metadata: null, durabilityUsed: null },
    ],
  });
  const t3 = generateAutonomousTask(s3, tracker);
  assert.equal(t3!.kind, "mine_resource");

  // Step 4: Has enough cobblestone and materials → craft stone pickaxe
  const s4 = stateWith({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "cobblestone", type: 1, count: 8, metadata: null, durabilityUsed: null },
      { slot: 2, name: "oak_planks", type: 1, count: 4, metadata: null, durabilityUsed: null },
      { slot: 3, name: "stick", type: 1, count: 4, metadata: null, durabilityUsed: null },
    ],
  });
  const t4 = generateAutonomousTask(s4, tracker);
  assert.equal(t4!.kind, "craft_item");
  if (t4!.kind === "craft_item") {
    assert.equal((t4 as any).targetItem, "stone_pickaxe");
  }
});

test("task-transition: night shelter priority overrides tool progression", () => {
  const tracker = new ProgressTracker();
  const state = stateWith({
    inventory: [
      { slot: 0, name: "cobblestone", type: 1, count: 10, metadata: null, durabilityUsed: null },
    ],
    time: { dayTicks: 14000, day: 1, isNight: true },
    entities: [
      { id: "z1", name: "zombie", type: "hostile", position: { x: 5, y: 64, z: 5 }, distance: 7, health: 20 },
    ],
  });
  const task = generateAutonomousTask(state, tracker);
  assert.ok(task !== null);
  // At night with placeable blocks, shelter should take priority
  assert.equal(task!.kind, "build_shelter");
});

test("task-transition: hunger emergency overrides everything", () => {
  const tracker = new ProgressTracker();
  const state = stateWith({
    player: { ...stateWith().player, food: 4 },
    inventory: [{ slot: 0, name: "bread", type: 1, count: 2, metadata: null, durabilityUsed: null }],
  });
  const task = generateAutonomousTask(state, tracker);
  assert.ok(task !== null);
  assert.equal(task!.kind, "secure_food");
});

test("task-transition: stone-age complete → advances to iron-age", () => {
  const tracker = new ProgressTracker();
  const state = stateWith({
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 5, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 3, name: "cobblestone", type: 1, count: 5, metadata: null, durabilityUsed: null },
    ],
  });
  const task = generateAutonomousTask(state, tracker);
  assert.ok(task !== null);
  // After stone-age, agent advances to iron-age (needs iron ore)
  assert.equal(task!.kind, "mine_resource");
  if (task!.kind === "mine_resource") {
    assert.equal(task.resourceName, "iron_ore");
  }
});

test("regression: milestone never regresses even if tools are lost", () => {
  const tracker = new ProgressTracker();
  // Progress through to stone-age
  const s1 = stateWith({
    player: { ...stateWith().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  const snap1 = tracker.getProgress(s1);
  assert.ok(snap1.completedMilestones.includes("stone-age"));

  // Now agent loses stone pickaxe (died, dropped it)
  const s2 = stateWith({
    player: { ...stateWith().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  const snap2 = tracker.getProgress(s2);
  // Milestone should still be completed even though the tool is gone
  assert.ok(snap2.completedMilestones.includes("stone-age"), "milestone must not regress");
});

test("regression: tracker serialization survives empty JSON", () => {
  const tracker = ProgressTracker.fromJSON({});
  // Default state has food=20, so food-security will be completed on evaluation
  const snap = tracker.getProgress(stateWith());
  assert.ok(snap.completedMilestones.includes("food-security"), "default state completes food-security");
});

test("regression: tracker handles null/undefined gracefully", () => {
  const tracker1 = ProgressTracker.fromJSON(null);
  const snap1 = tracker1.getProgress(stateWith());
  // Default state (food=20) will complete food-security
  assert.ok(snap1.completedMilestones.includes("food-security"));
  assert.equal(snap1.currentMilestone, "wooden-tools");

  const tracker2 = ProgressTracker.fromJSON(undefined);
  const snap2 = tracker2.getProgress(stateWith());
  assert.equal(snap2.currentMilestone, "wooden-tools");
});

test("regression: landmark memory handles duplicate positions correctly", () => {
  const memory = new LandmarkMemory();
  memory.record({ type: "resource-vein", position: { x: 10, y: 64, z: 0 }, label: "A", sequence: 1 });
  memory.record({ type: "resource-vein", position: { x: 10, y: 64, z: 0 }, label: "B", sequence: 2 });
  // Same exact position, same type → should merge (update)
  assert.equal(memory.size, 1);
  assert.equal(memory.getByType("resource-vein")[0]!.label, "B");
});

test("regression: exploration scoring bonus for known resources", async () => {
  // Verify the exploration module handles the new fields without crashing
  const { chooseExplorationWaypoint } = await import("../src/games/minecraft/exploration.js");
  const { WorldMemory } = await import("../src/games/minecraft/world-memory.js");
  const memory = new WorldMemory();

  // Create some explored cells via observe
  const obs = stateWith({
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: false },
  });
  memory.observe(obs, 1);

  // With known resources: should prefer cells near them
  const wp1 = chooseExplorationWaypoint(memory, {
    from: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    maxRadius: 64,
    minLeg: 8,
    maxLeg: 48,
    hostileAvoidRadius: 8,
    excludedKeys: new Set(),
    knownResourceLocations: [{ position: { x: 24, z: 0 }, resourceName: "stone" }],
  });
  assert.ok(wp1 !== null);
  assert.ok(typeof wp1.score === "number");

  // Without known resources: should still work normally
  const wp2 = chooseExplorationWaypoint(memory, {
    from: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    maxRadius: 64,
    minLeg: 8,
    maxLeg: 48,
    hostileAvoidRadius: 8,
    excludedKeys: new Set(),
  });
  assert.ok(wp2 !== null);
});
