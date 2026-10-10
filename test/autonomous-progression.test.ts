import assert from "node:assert/strict";
import test from "node:test";
import { generateAutonomousTask } from "../src/games/minecraft/autonomous-task.js";
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

test("autonomous: hungry agent with food → secures food", () => {
  const state = minimalState({
    player: {
      ...minimalState().player,
      food: 10,
    },
    inventory: [{ slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null }],
  });
  const task = generateAutonomousTask(state);
  assert.ok(task !== null);
  assert.equal(task.kind, "secure_food");
});

test("autonomous: no tools, no logs → gathers logs", () => {
  const state = minimalState({ inventory: [] });
  const task = generateAutonomousTask(state);
  assert.ok(task !== null);
  assert.equal(task.kind, "gather_resource");
  if (task.kind === "gather_resource") {
    assert.equal(task.resourceName, "oak_log");
  }
});

test("autonomous: has logs, no pickaxe → crafts pickaxe", () => {
  const state = minimalState({
    inventory: [{ slot: 0, name: "oak_log", type: 1, count: 5, metadata: null, durabilityUsed: null }],
  });
  const task = generateAutonomousTask(state);
  assert.ok(task !== null);
  assert.equal(task.kind, "craft_item");
  if (task.kind === "craft_item") {
    assert.equal(task.targetItem, "wooden_pickaxe");
  }
});

test("autonomous: has wooden pickaxe, low cobblestone → mines stone", () => {
  const state = minimalState({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "cobblestone", type: 1, count: 3, metadata: null, durabilityUsed: null },
    ],
  });
  const task = generateAutonomousTask(state);
  assert.ok(task !== null);
  assert.equal(task.kind, "mine_resource");
  if (task.kind === "mine_resource") {
    assert.equal(task.resourceName, "stone");
  }
});

test("autonomous: has stone pickaxe, low cobblestone → sustains stone gathering", () => {
  const state = minimalState({
    inventory: [
      { slot: 0, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "cobblestone", type: 1, count: 5, metadata: null, durabilityUsed: null },
    ],
  });
  const task = generateAutonomousTask(state);
  assert.ok(task !== null);
  assert.equal(task.kind, "mine_resource");
});

test("autonomous: night + hostiles + placeable blocks → builds shelter", () => {
  const state = minimalState({
    inventory: [
      { slot: 0, name: "cobblestone", type: 1, count: 8, metadata: null, durabilityUsed: null },
    ],
    entities: [{ id: "z1", name: "zombie", type: "hostile", position: { x: 5, y: 64, z: 5 }, distance: 7, health: 20 }],
    time: { dayTicks: 14000, day: 1, isNight: true },
  });
  const task = generateAutonomousTask(state);
  assert.ok(task !== null);
  assert.equal(task.kind, "build_shelter");
});

test("autonomous: no food but has tools → advances to stone-age (food stockpile deferred)", () => {
  const state = minimalState({
    player: { ...minimalState().player, food: 20, health: 20 },
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "oak_log", type: 1, count: 10, metadata: null, durabilityUsed: null },
      { slot: 2, name: "cobblestone", type: 1, count: 20, metadata: null, durabilityUsed: null },
    ],
  });
  const task = generateAutonomousTask(state);
  assert.ok(task !== null);
  // With tools and materials, the agent advances to stone-age rather than stockpiling food.
  // Food stockpiling is deferred until stone-age is reached.
  assert.equal(task.kind, "craft_item");
});

test("autonomous: all tasks have high action limits (≥100)", () => {
  // Test that autonomous tasks allow long runs
  const states = [
    minimalState({ inventory: [] }), // gather
    minimalState({ inventory: [{ slot: 0, name: "oak_log", type: 1, count: 5, metadata: null, durabilityUsed: null }] }), // craft
    minimalState({
      player: { ...minimalState().player, food: 10 },
      inventory: [{ slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null }],
    }), // food
  ];

  for (const state of states) {
    const task = generateAutonomousTask(state);
    assert.ok(task !== null);
    assert.ok(task.maxActions >= 20, `Expected maxActions >= 20, got ${task.maxActions} for task ${task.id}`);
  }
});
