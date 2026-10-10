import assert from "node:assert/strict";
import test from "node:test";
import { LandmarkMemory } from "../src/games/minecraft/landmark-memory.js";

test("landmark memory: record and retrieve a shelter landmark", () => {
  const memory = new LandmarkMemory();
  const lm = memory.record({
    type: "shelter",
    position: { x: 10, y: 64, z: -5 },
    label: "Cardinal shelter",
    sequence: 42,
  });
  assert.equal(memory.size, 1);
  assert.equal(lm.type, "shelter");
  assert.equal(lm.position.x, 10);
  assert.equal(lm.label, "Cardinal shelter");
});

test("landmark memory: finds nearest landmark by type", () => {
  const memory = new LandmarkMemory();
  memory.record({
    type: "shelter",
    position: { x: 10, y: 64, z: 0 },
    label: "Shelter A",
    sequence: 1,
  });
  memory.record({
    type: "village",
    position: { x: 50, y: 64, z: 0 },
    label: "Village",
    sequence: 2,
  });
  memory.record({
    type: "shelter",
    position: { x: 100, y: 64, z: 0 },
    label: "Shelter B",
    sequence: 3,
  });

  const nearest = memory.getNearest({ x: 15, y: 64, z: 0 }, "shelter");
  assert.ok(nearest !== null);
  assert.equal(nearest!.label, "Shelter A");

  const village = memory.getNearest({ x: 0, y: 64, z: 0 }, "village");
  assert.ok(village !== null);
  assert.equal(village!.label, "Village");
});

test("landmark memory: merges nearby landmarks of same type", () => {
  const memory = new LandmarkMemory();
  memory.record({
    type: "resource-vein",
    position: { x: 10, y: 64, z: 0 },
    label: "Iron deposit",
    sequence: 1,
    metadata: { resourceName: "iron_ore", quantity: 5 },
  });
  // Record same type within tolerance (16 blocks)
  memory.record({
    type: "resource-vein",
    position: { x: 15, y: 64, z: 0 },
    label: "Iron deposit (updated)",
    sequence: 5,
    metadata: { resourceName: "iron_ore", quantity: 8 },
  });
  assert.equal(memory.size, 1, "should merge nearby landmarks of same type");
  const all = memory.getByType("resource-vein");
  assert.equal(all.length, 1);
  assert.equal(all[0]!.label, "Iron deposit (updated)");
  assert.equal(all[0]!.lastConfirmedSequence, 5);
});

test("landmark memory: does not merge different types at same position", () => {
  const memory = new LandmarkMemory();
  memory.record({
    type: "resource-vein",
    position: { x: 10, y: 64, z: 0 },
    label: "Iron deposit",
    sequence: 1,
  });
  memory.record({
    type: "danger-zone",
    position: { x: 10, y: 64, z: 0 },
    label: "Spawner",
    sequence: 2,
  });
  assert.equal(memory.size, 2, "different types should not merge");
});

test("landmark memory: max distance filter works", () => {
  const memory = new LandmarkMemory();
  memory.record({
    type: "shelter",
    position: { x: 1000, y: 64, z: 0 },
    label: "Distant shelter",
    sequence: 1,
  });
  const result = memory.getNearest({ x: 0, y: 64, z: 0 }, "shelter", 50);
  assert.equal(result, null, "should return null when landmark is beyond max distance");
});

test("landmark memory: removes landmark by ID", () => {
  const memory = new LandmarkMemory();
  const lm = memory.record({
    type: "shelter",
    position: { x: 0, y: 64, z: 0 },
    label: "Shelter",
    sequence: 1,
  });
  assert.equal(memory.size, 1);
  const removed = memory.remove(lm.id);
  assert.equal(removed, true);
  assert.equal(memory.size, 0);
});

test("landmark memory: serializes and restores", () => {
  const memory = new LandmarkMemory();
  memory.record({
    type: "village",
    position: { x: 100, y: 64, z: 200 },
    label: "Plains village",
    sequence: 42,
  });
  memory.record({
    type: "danger-zone",
    position: { x: -50, y: 30, z: -50 },
    label: "Cave with spawner",
    sequence: 99,
    metadata: { hazardType: "spawner" },
  });

  const serialized = memory.toJSON();
  const restored = LandmarkMemory.fromJSON(serialized);
  assert.equal(restored.size, 2);
  assert.equal(restored.getByType("village").length, 1);
  assert.equal(restored.getByType("danger-zone").length, 1);

  const villages = restored.getByType("village");
  assert.ok(villages.length === 1);
  const village = villages[0]!;
  assert.equal(village.position.x, 100);
  assert.equal(village.position.z, 200);
  assert.equal(village.label, "Plains village");

  const dangers = restored.getByType("danger-zone");
  assert.ok(dangers.length === 1);
  const danger = dangers[0]!;
  assert.equal(danger.metadata?.hazardType, "spawner");
});

test("landmark memory: getByType returns correct subset", () => {
  const memory = new LandmarkMemory();
  memory.record({ type: "shelter", position: { x: 0, y: 64, z: 0 }, label: "A", sequence: 1 });
  memory.record({ type: "shelter", position: { x: 100, y: 64, z: 100 }, label: "B", sequence: 2 });
  memory.record({ type: "cave", position: { x: 50, y: 20, z: 50 }, label: "C", sequence: 3 });

  assert.equal(memory.getByType("shelter").length, 2);
  assert.equal(memory.getByType("cave").length, 1);
  assert.equal(memory.getByType("village").length, 0);
});

test("landmark memory: restores from empty or malformed data", () => {
  const m1 = LandmarkMemory.fromJSON({});
  assert.equal(m1.size, 0);

  const m2 = LandmarkMemory.fromJSON({ landmarks: "not-an-array" });
  assert.equal(m2.size, 0);

  const m3 = LandmarkMemory.fromJSON(null);
  assert.equal(m3.size, 0);
});
