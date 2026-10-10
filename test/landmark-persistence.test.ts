import assert from "node:assert/strict";
import test from "node:test";
import { WorldMemory } from "../src/games/minecraft/world-memory.js";
import { LandmarkMemory } from "../src/games/minecraft/landmark-memory.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PersistentWorldMemory } from "../src/games/minecraft/persistent-world-memory.js";

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

test("persistence: WorldMemory exports and restores landmarks in v2 snapshot", () => {
  const memory = new WorldMemory();
  memory.landmarks.record({
    type: "resource-vein",
    position: { x: 20, y: 60, z: 15 },
    label: "Iron deposit",
    sequence: 42,
    metadata: { resourceName: "iron_ore", quantity: 8 },
  });
  memory.landmarks.record({
    type: "shelter",
    position: { x: 5, y: 64, z: -3 },
    label: "Cardinal shelter",
    sequence: 100,
  });
  memory.landmarks.record({
    type: "danger-zone",
    position: { x: -10, y: 30, z: 5 },
    label: "Spawner cave",
    sequence: 55,
    metadata: { hazardType: "spawner" },
  });

  const snapshot = memory.exportSnapshot("test-world");
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.landmarks.length, 3);

  // Restore into a fresh memory
  const memory2 = new WorldMemory();
  const ok = memory2.restoreSnapshot(snapshot, "test-world");
  assert.equal(ok, true);
  assert.equal(memory2.landmarks.size, 3);
  assert.equal(memory2.landmarks.getByType("resource-vein").length, 1);
  assert.equal(memory2.landmarks.getByType("shelter").length, 1);
  assert.equal(memory2.landmarks.getByType("danger-zone").length, 1);

  const iron = memory2.landmarks.getByType("resource-vein")[0]!;
  assert.equal(iron.metadata?.resourceName, "iron_ore");
  assert.equal(iron.position.x, 20);

  const danger = memory2.landmarks.getByType("danger-zone")[0]!;
  assert.equal(danger.metadata?.hazardType, "spawner");
});

test("persistence: v1 snapshot (no landmarks) restores cleanly with empty landmarks", () => {
  const memory = new WorldMemory();
  const v1Snapshot = {
    schemaVersion: 1 as const,
    worldKey: "test-world",
    savedAt: new Date().toISOString(),
    observations: 5,
    blocks: [],
    minable: [],
    exploredCells: [],
  };

  const ok = memory.restoreSnapshot(v1Snapshot, "test-world");
  assert.equal(ok, true);
  assert.equal(memory.landmarks.size, 0, "v1 snapshot should have no landmarks");
});

test("persistence: wrong world key rejects landmark restore", () => {
  const memory = new WorldMemory();
  memory.landmarks.record({
    type: "shelter",
    position: { x: 5, y: 64, z: 0 },
    label: "My shelter",
    sequence: 1,
  });
  const snapshot = memory.exportSnapshot("world-A");

  const memory2 = new WorldMemory();
  const ok = memory2.restoreSnapshot(snapshot, "world-B");
  assert.equal(ok, false, "should reject snapshot from different world");
  assert.equal(memory2.landmarks.size, 0, "should not restore any landmarks");
});

test("persistence: corrupted landmark data is handled safely", () => {
  const memory = new WorldMemory();
  // Create a snapshot with malformed landmark data
  const corruptedSnapshot = {
    schemaVersion: 2 as const,
    worldKey: "test-world",
    savedAt: new Date().toISOString(),
    observations: 1,
    blocks: [],
    minable: [],
    exploredCells: [],
    landmarks: [
      { id: "lm-1", type: "invalid-type", position: { x: 1, y: 2, z: 3 }, label: "Bad", createdAt: new Date().toISOString(), lastConfirmedSequence: 1 },
    ],
  };

  // The zod schema rejects invalid landmark types, so the whole snapshot fails
  const ok = memory.restoreSnapshot(corruptedSnapshot, "test-world");
  assert.equal(ok, false, "corrupted landmarks should cause snapshot rejection");
});

test("persistence: PersistentWorldMemory saves and restores landmarks across restarts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gamemind-lm-test-"));
  try {
    // Phase 1: Create memory, record landmarks, flush
    const mem1 = await PersistentWorldMemory.open(dir, "test-world-lm");
    mem1.landmarks.record({
      type: "resource-vein",
      position: { x: 50, y: 40, z: 30 },
      label: "Diamond vein",
      sequence: 42,
      metadata: { resourceName: "diamond_ore", quantity: 4 },
    });
    mem1.landmarks.record({
      type: "danger-zone",
      position: { x: -20, y: 20, z: 10 },
      label: "Lava pool",
      sequence: 100,
      metadata: { hazardType: "lava" },
    });
    mem1.observe(minimalState(), 1);
    await mem1.flush();

    // Phase 2: Re-open memory (simulating restart)
    const mem2 = await PersistentWorldMemory.open(dir, "test-world-lm");
    assert.equal(mem2.landmarks.size, 2, "landmarks should survive restart");
    assert.equal(mem2.landmarks.getByType("resource-vein").length, 1);
    assert.equal(mem2.landmarks.getByType("danger-zone").length, 1);

    const vein = mem2.landmarks.getByType("resource-vein")[0]!;
    assert.equal(vein.position.x, 50);
    assert.equal(vein.metadata?.resourceName, "diamond_ore");
    assert.equal(vein.metadata?.quantity, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistence: restored landmarks influence exploration scoring", async () => {
  const { chooseExplorationWaypoint } = await import("../src/games/minecraft/exploration.js");

  // Create a memory with some explored cells
  const memory = new WorldMemory();
  memory.observe(minimalState({
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: false },
  }), 1);

  // Record a resource vein at a known location
  memory.landmarks.record({
    type: "resource-vein",
    position: { x: 30, y: 60, z: 0 },
    label: "Iron deposit",
    sequence: 10,
    metadata: { resourceName: "iron_ore" },
  });

  // Exploration with known resources should find a valid waypoint
  const wp = chooseExplorationWaypoint(memory, {
    from: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    maxRadius: 64,
    minLeg: 8,
    maxLeg: 48,
    hostileAvoidRadius: 8,
    excludedKeys: new Set(),
    knownResourceLocations: memory.landmarks.getByType("resource-vein").map((lm) => ({
      position: { x: lm.position.x, z: lm.position.z },
      ...(lm.metadata?.resourceName ? { resourceName: lm.metadata.resourceName } : {}),
    })),
  });

  assert.ok(wp !== null, "exploration should find a waypoint");
  assert.ok(typeof wp.score === "number");
});

test("persistence: summary includes landmark count", () => {
  const memory = new WorldMemory();
  memory.landmarks.record({
    type: "shelter",
    position: { x: 0, y: 64, z: 0 },
    label: "Shelter",
    sequence: 1,
  });
  memory.landmarks.record({
    type: "danger-zone",
    position: { x: 10, y: 64, z: 10 },
    label: "Danger",
    sequence: 2,
  });

  const summary = memory.summary();
  assert.equal(summary.landmarks, 2);
});

test("persistence: snapshot file on disk includes landmarks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gamemind-lm-disk-"));
  try {
    const mem = await PersistentWorldMemory.open(dir, "disk-world");
    mem.landmarks.record({
      type: "village",
      position: { x: 100, y: 64, z: 200 },
      label: "Plains village",
      sequence: 50,
    });
    mem.observe(minimalState(), 1);
    await mem.flush();

    // Read the file directly to verify landmarks are persisted
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    assert.ok(files.length > 0, "snapshot file should exist");
    const content = await readFile(path.join(dir, files[0]!), "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.schemaVersion, 2);
    assert.ok(Array.isArray(parsed.landmarks));
    assert.equal(parsed.landmarks.length, 1);
    assert.equal(parsed.landmarks[0].type, "village");
    assert.equal(parsed.landmarks[0].label, "Plains village");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
