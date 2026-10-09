import assert from "node:assert/strict";
import test from "node:test";
import { chooseExplorationWaypoint, explorationWaypointKey } from "../src/games/minecraft/exploration.js";
import { WorldMemory, markCoverage } from "../src/games/minecraft/world-memory.js";
import { block, observationAt } from "./support/observations.js";

const origin = { x: 0.5, y: 64, z: 0.5 };

function resourceSighting(name: string, x: number, y: number, z: number, properties?: Record<string, string | number | boolean>) {
  const distance = Math.hypot(x + 0.5 - origin.x, y - origin.y, z + 0.5 - origin.z);
  return {
    name,
    position: { x, y, z },
    distance,
    ...(properties ? { properties } : {}),
  };
}

test("memory remembers wide-scan resource sightings beyond the local cube and keeps them across observations", () => {
  const memory = new WorldMemory();
  const first = observationAt(origin, {
    resourceSightings: [resourceSighting("oak_log", 20, 64, 0)],
  });
  memory.observe(first, 0);
  assert.equal(memory.blockSightings(new Set(["oak_log"])).length, 1);

  // A later observation from elsewhere that does not cover x=20 must not forget that log.
  const elsewhere = observationAt({ x: -30.5, y: 64, z: 0.5 }, {
    resourceScan: { radius: 24, limit: 64, center: { x: -30, y: 64, z: 0 }, truncated: false },
  });
  memory.observe(elsewhere, 1);
  assert.equal(memory.blockSightings(new Set(["oak_log"])).length, 1);
});

test("a fully scanned, untruncated volume that no longer shows a remembered block invalidates it", () => {
  const memory = new WorldMemory();
  memory.observe(
    observationAt(origin, {
      resourceSightings: [resourceSighting("oak_log", 10, 64, 0)],
    }),
    0,
  );
  const update = memory.observe(observationAt(origin, { resourceSightings: [] }), 1);
  assert.equal(update.removed, 1);
  assert.equal(memory.blockSightings().length, 0);
});

test("a truncated resource scan never proves that a remembered block is gone", () => {
  const memory = new WorldMemory();
  memory.observe(
    observationAt(origin, {
      resourceSightings: [resourceSighting("oak_log", 10, 64, 0)],
    }),
    0,
  );
  const truncated = observationAt(origin, {
    resourceSightings: [],
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: true },
  });
  memory.observe(truncated, 1);
  assert.equal(memory.blockSightings().length, 1, "truncated scans are inconclusive");
});

test("unknown cells in the local cube make local absence inconclusive", () => {
  const memory = new WorldMemory();
  memory.observe(observationAt(origin, { nearbyBlocks: [block("oak_log", 1, 64, 0)] }), 0);
  const partlyUnknown = observationAt(origin, {
    nearbyBlocks: [],
    sampledRegion: { radius: 3, verticalRadius: 2, center: { x: 0, y: 64, z: 0 }, sampledCells: 245, unknownCells: 4, truncated: false },
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: true },
  });
  memory.observe(partlyUnknown, 1);
  assert.equal(memory.blockSightings().length, 1);
});

test("ripe sweet berry bushes are recognised from block properties and stale ripeness is updated", () => {
  const memory = new WorldMemory();
  memory.observe(
    observationAt(origin, {
      resourceSightings: [resourceSighting("sweet_berry_bush", 5, 64, 5, { age: 3 })],
    }),
    0,
  );
  assert.equal(memory.summary().ripeBerryBushes, 1);
  memory.observe(
    observationAt(origin, {
      resourceSightings: [resourceSighting("sweet_berry_bush", 5, 64, 5, { age: 1 })],
    }),
    1,
  );
  assert.equal(memory.summary().ripeBerryBushes, 0);
  assert.equal(memory.blockSightings(new Set(["sweet_berry_bush"]))[0]?.ripe, false);
});

test("dropped food items are tracked and removed when a nearby entity scan no longer shows them", () => {
  const memory = new WorldMemory();
  const drop = { id: "7", name: "bread", count: 1, position: { x: 3.4, y: 64.1, z: 2.8 }, distance: 4 };
  memory.observe(observationAt(origin, { itemDrops: [drop] }), 0);
  assert.equal(memory.foodItemSightings().length, 1);
  memory.observe(observationAt(origin, { itemDrops: [] }), 1);
  assert.equal(memory.foodItemSightings().length, 0);
});

test("hostiles are remembered briefly and flagged as approaching when they get closer", () => {
  const memory = new WorldMemory();
  const zombie = (distance: number) => ({
    id: "zombie-1",
    name: "zombie",
    type: "hostile",
    position: { x: origin.x + distance, y: 64, z: origin.z },
    distance,
    health: 20,
  });
  memory.observe(observationAt(origin, { entities: [zombie(9)] }), 0);
  memory.observe(observationAt(origin, { entities: [zombie(6)] }), 1);
  const [sighting] = memory.hostileSightings();
  assert.ok(sighting?.approaching);

  // Not visible for longer than the memory window: forgotten.
  for (let sequence = 2; sequence < 12; sequence += 1) memory.observe(observationAt(origin), sequence);
  assert.equal(memory.hostileSightings().length, 0);
});

test("repeated or older sequence numbers are ignored so retries cannot double count", () => {
  const memory = new WorldMemory();
  const state = observationAt(origin, { nearbyBlocks: [block("oak_log", 1, 64, 0)] });
  memory.observe(state, 4);
  const repeat = memory.observe(state, 4);
  const older = memory.observe(state, 2);
  assert.deepEqual(repeat, { added: 0, removed: 0 });
  assert.deepEqual(older, { added: 0, removed: 0 });
  assert.equal(memory.observations, 1);
});

test("a truncated scan without loaded-chunk metadata does not mark coverage as explored", () => {
  const memory = new WorldMemory();
  memory.observe(observationAt(origin, {
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: true },
  }), 0);
  assert.equal(memory.exploredCellCount, 0);
});

test("coverage marks cells whose centers lie inside the wide scan disk, not beyond it", () => {
  const explored = new Set<string>();
  markCoverage(explored, { x: 0, z: 0 }, 24);
  const memory = WorldMemory.fromObservation(observationAt(origin));
  assert.ok(memory.isPointExplored({ x: 0, z: 0 }));
  assert.ok(memory.exploredCellCount > 0);
  assert.equal(explored.has("10,0"), false, "cells centred beyond the radius stay unexplored");
});

test("exploration prefers an unexplored leg, avoids recently seen hostiles, and respects the origin radius", () => {
  const memory = WorldMemory.fromObservation(observationAt(origin));
  const request = {
    from: origin,
    origin,
    maxRadius: 48,
    minLeg: 12,
    maxLeg: 40,
    hostileAvoidRadius: 10,
    excludedKeys: new Set<string>(),
  };
  const waypoint = chooseExplorationWaypoint(memory, request);
  assert.ok(waypoint, "an unexplored frontier exists beyond the initial scan");
  assert.ok(waypoint.distance >= 12 && waypoint.distance <= 40);
  assert.ok(!memory.isPointExplored(waypoint));
  assert.equal(waypoint.key, explorationWaypointKey(Math.floor(waypoint.x / 8), Math.floor(waypoint.z / 8)));

  // Excluding the chosen waypoint must select a different one.
  const alternative = chooseExplorationWaypoint(memory, {
    ...request,
    excludedKeys: new Set([waypoint.key]),
  });
  assert.ok(alternative);
  assert.notEqual(alternative.key, waypoint.key);

  // A hostile sitting on the chosen waypoint rejects it.
  const hostile = {
    id: "creeper-1",
    name: "creeper",
    type: "hostile",
    position: { x: waypoint.x, y: 64, z: waypoint.z },
    distance: waypoint.distance,
    health: 20,
  };
  const withHostile = WorldMemory.fromObservation(observationAt(origin, { entities: [hostile] }));
  const avoided = chooseExplorationWaypoint(withHostile, request);
  assert.ok(avoided);
  assert.notEqual(avoided.key, waypoint.key);
});

test("exploration stops when the bounded search radius contains no unexplored frontier", () => {
  const memory = WorldMemory.fromObservation(observationAt(origin));
  const result = chooseExplorationWaypoint(memory, {
    from: origin,
    origin,
    maxRadius: 10,
    minLeg: 12,
    maxLeg: 40,
    hostileAvoidRadius: 10,
    excludedKeys: new Set(),
  });
  assert.equal(result, null);
});
