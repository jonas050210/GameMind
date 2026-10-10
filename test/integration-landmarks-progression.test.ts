import assert from "node:assert/strict";
import test from "node:test";
import { LandmarkMemory } from "../src/games/minecraft/landmark-memory.js";
import { ProgressTracker } from "../src/games/minecraft/progress-tracker.js";
import { generateAutonomousTask } from "../src/games/minecraft/autonomous-task.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";

/**
 * Integration tests that verify the full pipeline from observation through
 * landmark recording, milestone tracking, and autonomous task generation.
 *
 * These tests exercise the connections between:
 * - LandmarkMemory (recording from observations)
 * - ProgressTracker (milestone tracking across tasks)
 * - generateAutonomousTask (task generation using tracker state)
 */

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

/**
 * Simulate the autonomous loop recording landmarks from observations,
 * then verify the landmark memory contains what we expect.
 */
test("integration: landmark memory records resource sightings from observation", () => {
  const landmarkMemory = new LandmarkMemory();
  const state = minimalState({
    minableSightings: [
      { name: "stone", position: { x: 10, y: 62, z: 5 }, distance: 12 },
      { name: "coal_ore", position: { x: -8, y: 58, z: 3 }, distance: 15 },
    ],
    resourceSightings: [
      { name: "oak_log", position: { x: 5, y: 65, z: -3 }, distance: 6 },
    ],
  });

  // Simulate the recordLandmarksFromObservation function
  for (const sighting of state.minableSightings ?? []) {
    landmarkMemory.record({
      type: "resource-vein",
      position: sighting.position,
      label: `${sighting.name} deposit`,
      sequence: 1,
      metadata: { resourceName: sighting.name },
    });
  }
  for (const sighting of state.resourceSightings) {
    landmarkMemory.record({
      type: "resource-vein",
      position: sighting.position,
      label: `${sighting.name} source`,
      sequence: 1,
      metadata: { resourceName: sighting.name },
    });
  }

  // stone at (10,5) and oak_log at (5,-3) are within 16 blocks → merged into 1 landmark
  // coal_ore at (-8,3) is ~18 blocks from stone → separate
  assert.equal(landmarkMemory.size, 2);
  assert.equal(landmarkMemory.getByType("resource-vein").length, 2);

  // Verify nearest resource query works
  const nearest = landmarkMemory.getNearest({ x: 0, y: 64, z: 0 }, "resource-vein");
  assert.ok(nearest !== null);
});

test("integration: landmark memory records danger zones from hazards and hostiles", () => {
  const landmarkMemory = new LandmarkMemory();
  const state = minimalState({
    nearbyBlocks: [
      { position: { x: 3, y: 63, z: 0 }, name: "lava", type: 0, boundingBox: "block", distance: 3 },
      { position: { x: -5, y: 64, z: 2 }, name: "campfire", type: 0, boundingBox: "block", distance: 5.4 },
    ],
    entities: [
      { id: "z1", name: "zombie", type: "hostile", position: { x: 8, y: 64, z: 8 }, distance: 11.3, health: 20 },
    ],
  });

  for (const block of state.nearbyBlocks) {
    if (block.name === "lava" || block.name === "magma_block" || block.name === "campfire") {
      landmarkMemory.record({
        type: "danger-zone",
        position: block.position,
        label: `${block.name} hazard`,
        sequence: 1,
        metadata: { hazardType: block.name },
      });
    }
  }
  for (const entity of state.entities) {
    if (entity.type === "hostile") {
      landmarkMemory.record({
        type: "danger-zone",
        position: { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
        label: `${entity.name} threat`,
        sequence: 1,
        metadata: { hazardType: entity.name },
      });
    }
  }

  // lava(3,0), campfire(-5,2), zombie(8,8) — all within 16 blocks of each other → merge
  assert.equal(landmarkMemory.size, 1);
  assert.equal(landmarkMemory.getByType("danger-zone").length, 1);
});

test("integration: landmark memory persists across simulated restart", () => {
  const memory = new LandmarkMemory();
  memory.record({
    type: "resource-vein",
    position: { x: 20, y: 60, z: 15 },
    label: "Iron deposit",
    sequence: 42,
    metadata: { resourceName: "iron_ore", quantity: 8 },
  });
  memory.record({
    type: "shelter",
    position: { x: 5, y: 64, z: -3 },
    label: "Cardinal shelter",
    sequence: 100,
  });
  memory.record({
    type: "danger-zone",
    position: { x: -10, y: 30, z: 5 },
    label: "Spawner cave",
    sequence: 55,
    metadata: { hazardType: "spawner" },
  });

  // Simulate restart: serialize and restore
  const serialized = memory.toJSON();
  const restored = LandmarkMemory.fromJSON(serialized);

  assert.equal(restored.size, 3);
  const iron = restored.getByType("resource-vein")[0]!;
  assert.equal(iron.metadata?.resourceName, "iron_ore");
  assert.equal(iron.lastConfirmedSequence, 42);

  const shelter = restored.getByType("shelter")[0]!;
  assert.equal(shelter.position.x, 5);

  const danger = restored.getByType("danger-zone")[0]!;
  assert.equal(danger.metadata?.hazardType, "spawner");
});

test("integration: progress tracker drives task chain across restarts", () => {
  // Phase 1: agent starts with nothing
  const tracker1 = new ProgressTracker();
  const state1 = minimalState({ inventory: [] });
  const task1 = generateAutonomousTask(state1, tracker1);
  assert.ok(task1 !== null);
  assert.equal(task1!.kind, "gather_resource"); // needs logs

  // Serialize tracker (simulating restart)
  const serialized = tracker1.toJSON();

  // Phase 2: after restart, agent has gathered logs and crafted a wooden pickaxe
  const tracker2 = ProgressTracker.fromJSON(serialized);
  const state2 = minimalState({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "cobblestone", type: 1, count: 3, metadata: null, durabilityUsed: null },
    ],
  });
  const task2 = generateAutonomousTask(state2, tracker2);
  assert.ok(task2 !== null);
  // Should advance to mining for stone pickage progression
  assert.equal(task2!.kind, "mine_resource");

  // Phase 3: restart again, now has stone pickaxe
  const serialized2 = tracker2.toJSON();
  const tracker3 = ProgressTracker.fromJSON(serialized2);
  const state3 = minimalState({
    inventory: [
      { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 1, name: "stone_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
      { slot: 2, name: "cobblestone", type: 1, count: 5, metadata: null, durabilityUsed: null },
    ],
  });
  const task3 = generateAutonomousTask(state3, tracker3);
  assert.ok(task3 !== null);
  assert.equal(task3!.kind, "mine_resource"); // sustained gathering
});

test("integration: exploration uses known resource locations from landmark memory", async () => {
  const { chooseExplorationWaypoint } = await import("../src/games/minecraft/exploration.js");
  const { WorldMemory } = await import("../src/games/minecraft/world-memory.js");
  const memory = new WorldMemory();

  // Use observe to mark cells as explored
  const obs = minimalState({
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: false },
  });
  memory.observe(obs, 1);

  const waypoint = chooseExplorationWaypoint(memory, {
    from: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    maxRadius: 64,
    minLeg: 8,
    maxLeg: 48,
    hostileAvoidRadius: 8,
    excludedKeys: new Set(),
    knownResourceLocations: [
      { position: { x: 30, z: 30 }, resourceName: "iron_ore" },
    ],
  });

  // The exploration should still work and return a waypoint
  assert.ok(waypoint !== null);
  assert.ok(typeof waypoint.score === "number");
});

test("integration: exploration rejects waypoints near known danger zones", async () => {
  const { chooseExplorationWaypoint } = await import("../src/games/minecraft/exploration.js");
  const { WorldMemory } = await import("../src/games/minecraft/world-memory.js");
  const memory = new WorldMemory();

  // Use observe to mark cells as explored
  const obs = minimalState({
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: false },
  });
  memory.observe(obs, 1);

  // Place a danger zone at a location that would otherwise be a good exploration target
  const waypoint = chooseExplorationWaypoint(memory, {
    from: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    maxRadius: 64,
    minLeg: 8,
    maxLeg: 48,
    hostileAvoidRadius: 8,
    excludedKeys: new Set(),
    knownDangerZones: [
      // Danger zone very close — should not cause rejection of far-away cells
      { position: { x: 5, z: 5 } },
    ],
  });

  // Should still find a waypoint (not near the danger zone)
  assert.ok(waypoint !== null);
  // The waypoint should be far from the danger zone
  const distToDanger = Math.hypot(waypoint.x - 5, waypoint.z - 5);
  assert.ok(distToDanger > 8, `Waypoint should be far from danger zone, got distance ${distToDanger}`);
});

test("integration: task generates with proper action limits for multi-step chains", () => {
  const tracker = new ProgressTracker();
  const states = [
    // No tools → gather
    minimalState({ inventory: [] }),
    // Has logs → craft pickaxe
    minimalState({ inventory: [{ slot: 0, name: "oak_log", type: 1, count: 5, metadata: null, durabilityUsed: null }] }),
    // Has pickaxe → mine
    minimalState({
      inventory: [
        { slot: 0, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
        { slot: 1, name: "cobblestone", type: 1, count: 3, metadata: null, durabilityUsed: null },
      ],
    }),
  ];

  for (const state of states) {
    const task = generateAutonomousTask(state, tracker);
    assert.ok(task !== null);
    // All autonomous tasks must have high limits (≥100)
    assert.ok(task!.maxActions >= 100, `Task ${task!.id} has maxActions=${task!.maxActions}, expected ≥100`);
    assert.ok(task!.maxDurationMs >= 60_000, `Task ${task!.id} has maxDurationMs=${task!.maxDurationMs}, expected ≥60000`);
  }
});

test("integration: recovery from empty inventory after task failure", () => {
  const tracker = new ProgressTracker();

  // Simulate: agent had tools but lost them (death/respawn)
  // Tracker still remembers milestones from before
  const stateBefore = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [
      { slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null },
      { slot: 1, name: "wooden_pickaxe", type: 1, count: 1, metadata: null, durabilityUsed: null },
    ],
  });
  tracker.getProgress(stateBefore);

  // After "respawn" with empty inventory, tracker remembers wooden-tools
  const stateAfter = minimalState({
    player: { ...minimalState().player, food: 20 },
    inventory: [],
  });
  const task = generateAutonomousTask(stateAfter, tracker);
  assert.ok(task !== null);
  // Should not try to go back to food-security since hunger is full
  // and wooden-tools milestone is already completed
  // Agent should advance toward stone-age (needs to re-gather materials)
  assert.notEqual(task!.kind, "secure_food", "should not prioritize food when hunger is full");
});
