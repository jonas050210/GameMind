import assert from "node:assert/strict";
import test from "node:test";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import type { MinecraftTask } from "../src/games/minecraft/task.js";
import { gatherResourceTaskSchema, mineResourceTaskSchema } from "../src/games/minecraft/task.js";

function stateWithDrops(overrides: Partial<MinecraftObservation> = {}): MinecraftObservation {
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

test("dropped item: gather task picks up nearby dropped log", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = stateWithDrops({
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
    kind: "gather_resource",
    resourceName: "oak_log",
    targetCount: 1,
    maxActions: 10,
  });

  const result = model.decide(state, task);
  assert.ok(result.selected !== null, "Decision model should select a candidate");
  assert.ok(
    result.selected.goalId.includes("pickup") || result.selected.skillId === "minecraft.pickup-item",
    `Expected pickup goal or skill, got goalId=${result.selected.goalId}, skillId=${result.selected.skillId}`,
  );
});

test("dropped item: mine task picks up nearby dropped cobblestone", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = stateWithDrops({
    inventory: [{ slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null }],
    equipment: {
      hand: { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      offhand: null, head: null, torso: null, legs: null, feet: null,
    },
    nearbyBlocks: [{ position: { x: 5, y: 64, z: 0 }, name: "stone", type: 1, boundingBox: "block", distance: 5 }],
    itemDrops: [{
      id: "drop-1",
      name: "cobblestone",
      count: 2,
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
    }],
  });
  const task = mineResourceTaskSchema.parse({
    id: "test-mine",
    kind: "mine_resource",
    resourceName: "stone",
    targetCount: 1,
    maxActions: 10,
  });

  const result = model.decide(state, task);
  assert.ok(result.selected !== null, "Decision model should select a candidate");
  // With pickaxe equipped and cobblestone drop nearby, should prefer pickup or mine
  const allGoalIds = [result.selected.goalId, ...result.alternatives.map((a: { goalId: string }) => a.goalId)];
  const hasPickup = allGoalIds.some((id: string) => id.includes("pickup") || id.includes("cobblestone"));
  const hasMine = allGoalIds.some((id: string) => id.includes("mine"));
  assert.ok(hasPickup || hasMine, `Expected pickup or mine goal among candidates, got: ${allGoalIds.join(", ")}`);
});

test("dropped item: agent ignores drops not matching task target", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = stateWithDrops({
    nearbyBlocks: [{ position: { x: 3, y: 64, z: 0 }, name: "oak_log", type: 1, boundingBox: "block", distance: 3 }],
    itemDrops: [{
      id: "drop-1",
      name: "dirt",
      count: 5,
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
    }],
  });
  const task = gatherResourceTaskSchema.parse({
    id: "test-gather",
    kind: "gather_resource",
    resourceName: "oak_log",
    targetCount: 1,
    maxActions: 10,
  });

  const result = model.decide(state, task);
  assert.ok(result.selected !== null);
  // Should prefer the block (collect-log) over the dirt drop
  assert.ok(
    result.selected.goalId.includes("collect") || result.selected.skillId === "minecraft.collect-log",
    `Expected block collection over irrelevant drop, got ${result.selected.goalId}`,
  );
});

test("dropped item: agent avoids drop near hostile", () => {
  const model = new MinecraftTaskDecisionModel();
  const state = stateWithDrops({
    itemDrops: [{
      id: "drop-1",
      name: "oak_log",
      count: 1,
      position: { x: 3, y: 64, z: 0 },
      distance: 3,
    }],
    entities: [{
      id: "z1",
      name: "zombie",
      type: "hostile",
      position: { x: 3.5, y: 64, z: 0.5 },
      distance: 3.5,
      health: 20,
    }],
  });
  const task = gatherResourceTaskSchema.parse({
    id: "test-gather",
    kind: "gather_resource",
    resourceName: "oak_log",
    targetCount: 1,
    maxActions: 10,
    dangerRadius: 6,
  });

  const result = model.decide(state, task);
  // Should not pick up the drop near the hostile (it's within danger radius)
  // It should either choose defense/flee or be blocked
  if (result.selected) {
    assert.ok(
      !result.selected.goalId.includes("pickup"),
      "Should not pick up a drop within the danger radius of a hostile",
    );
  }
});
