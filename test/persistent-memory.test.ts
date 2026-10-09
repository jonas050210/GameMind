import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentWorldMemory } from "../src/games/minecraft/persistent-world-memory.js";
import { WorldMemory } from "../src/games/minecraft/world-memory.js";
import { observationAt } from "./support/observations.js";

const origin = { x: 12.5, y: 64, z: 4.5 };

function logAt(x: number, z: number) {
  return {
    name: "oak_log",
    position: { x, y: 64, z },
    distance: Math.hypot(x + 0.5 - origin.x, z + 0.5 - origin.z),
  };
}

test("exploration coverage only marks client-loaded chunks and stops using a saturated scan as negative evidence", () => {
  const memory = new WorldMemory();
  const state = observationAt(origin, {
    resourceScan: {
      radius: 24,
      limit: 192,
      center: { x: 12, y: 64, z: 4 },
      truncated: false,
      loadedChunks: [{ x: 0, z: 0 }],
    },
  });
  memory.observe(state, 0);
  assert.equal(memory.isCellExplored(1, 0), true, "coverage inside the loaded chunk is known");
  assert.equal(memory.isCellExplored(2, 0), false, "adjacent, unloaded chunk remains unexplored");

  const saturated = new WorldMemory();
  saturated.observe({
    ...state,
    resourceScan: { ...state.resourceScan, truncated: true },
  }, 0);
  assert.equal(saturated.exploredCellCount, 0, "a saturated scan cannot establish empty coverage");
});

test("snapshot validation rejects a foreign world key, stale data, and malformed explored cells", () => {
  const snapshot = new WorldMemory().exportSnapshot("world-a");
  const target = new WorldMemory();
  assert.equal(target.restoreSnapshot(snapshot, "world-b"), false);
  assert.equal(target.restoreSnapshot({ ...snapshot, savedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString() }, "world-a"), false);
  assert.equal(target.restoreSnapshot({ ...snapshot, exploredCells: ["not-a-cell"] }, "world-a"), false);
  assert.equal(target.restoreSnapshot({ ...snapshot, schemaVersion: 99 }, "world-a"), false);
  const validPosition = { x: 1, y: 64, z: 2 };
  assert.equal(target.restoreSnapshot({
    ...snapshot,
    blocks: [{ key: "0,64,0", name: "oak_log", position: validPosition, ripe: null, lastSeenSequence: 0 }],
  }, "world-a"), false, "a position/key mismatch cannot redirect a stored target");
  assert.equal(target.restoreSnapshot({
    ...snapshot,
    blocks: [{ key: "1,64,2", name: "diamond_block", position: validPosition, ripe: null, lastSeenSequence: 0 }],
  }, "world-a"), false, "unknown resource classes cannot be injected into world memory");
  assert.equal(target.restoreSnapshot({
    ...snapshot,
    blocks: [{ key: "1,64,2", name: "oak_log", position: validPosition, ripe: true, lastSeenSequence: 0 }],
  }, "world-a"), false, "berry ripeness metadata cannot be attached to other blocks");
});

test("persistent world memory restores only same-world, fresh block and exploration knowledge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gamemind-memory-"));
  try {
    const worldKey = "test-server:25565:overworld";
    const memory = await PersistentWorldMemory.open(directory, worldKey, { debounceMs: 0 });
    memory.observe(observationAt(origin, {
      resourceSightings: [logAt(20, 4)],
      resourceScan: {
        radius: 24,
        limit: 192,
        center: { x: 12, y: 64, z: 4 },
        truncated: false,
        loadedChunks: [{ x: 0, z: 0 }, { x: 1, z: 0 }],
      },
    }), 0);
    await memory.flush();

    const restored = await PersistentWorldMemory.open(directory, worldKey, { debounceMs: 0 });
    assert.equal(restored.blockSightings(new Set(["oak_log"])).length, 1);
    assert.ok(restored.exploredCellCount > 0);
    assert.equal(restored.hostileSightings().length, 0, "transient hostile locations are not restored");
    assert.equal(restored.foodItemSightings().length, 0, "despawnable item drops are not restored");

    const otherWorld = await PersistentWorldMemory.open(directory, "different-world", { debounceMs: 0 });
    assert.equal(otherWorld.blockSightings().length, 0, "different server/world identity starts fresh");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
