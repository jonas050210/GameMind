/**
 * The memory view is built from up to 40 stored world snapshots on disk, and the page polls the memory tab
 * every 1.5 s while it is open. A short window reuses the parsed view instead of re-reading and re-folding
 * every file per poll; the live section of the answer (this session's counters) is never cached.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryViewCache, buildMemoryQuery } from "../src/app/queries.js";
import { defaultRedactionContext } from "../src/app/redact.js";

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gamemind-memory-view-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One stored world snapshot in the shape `persistent-world-memory.ts` writes. */
function storedWorld(observations: number): string {
  return JSON.stringify({
    worldKey: "world-a",
    savedAt: "2026-10-11T10:00:00.000Z",
    observations,
    blocks: [{ name: "oak_log", position: { x: 1, y: 64, z: 2 }, lastSeenAt: "2026-10-11T09:59:00.000Z" }],
    minable: [],
    exploredCells: ["0,0", "1,0"],
    landmarks: [],
  });
}

function summary(observations: number) {
  return { worldKey: "world-a", observations, exploredCells: 2, resourceBlocks: { oak_log: 1 }, landmarks: 0 };
}

test("the stored view is built once per window while the live counters stay fresh", async () => {
  await withDirectory(async (directory) => {
    await writeFile(path.join(directory, "world-a.json"), storedWorld(5), "utf8");
    let clock = 1_000;
    const cache = new MemoryViewCache({ ttlMs: 3_000, now: () => clock });
    const query = (live: number) =>
      buildMemoryQuery({ directory, currentWorldKey: "world-a", liveSummary: summary(live), redaction: defaultRedactionContext(directory), cache });

    const first = (await query(1)) as { worlds: Array<{ observations: number }>; live: { observations: number } };
    assert.equal(first.worlds[0]?.observations, 5);

    // The file changes, but the window has not passed: the parsed view is reused, not re-read.
    await writeFile(path.join(directory, "world-a.json"), storedWorld(99), "utf8");
    const reused = (await query(7)) as { worlds: Array<{ observations: number }>; live: { observations: number } };
    assert.equal(reused.worlds[0]?.observations, 5, "the disk view is served from the cache inside the window");
    assert.equal(reused.live.observations, 7, "the live counters are never cached");

    // Once the window passes, the changed file is read again.
    clock += 3_001;
    const refreshed = (await query(9)) as { worlds: Array<{ observations: number }> };
    assert.equal(refreshed.worlds[0]?.observations, 99, "the next poll after the window sees the saved file");
  });
});

test("the current world is part of the cache key, so two sessions cannot share a view", async () => {
  await withDirectory(async (directory) => {
    await writeFile(path.join(directory, "world-a.json"), storedWorld(5), "utf8");
    const cache = new MemoryViewCache({ ttlMs: 60_000, now: () => 1_000 });
    const query = (worldKey: string | null) =>
      buildMemoryQuery({ directory, currentWorldKey: worldKey, liveSummary: null, redaction: defaultRedactionContext(directory), cache });

    const mine = (await query("world-a")) as { worlds: Array<{ current: boolean }> };
    assert.equal(mine.worlds[0]?.current, true);
    const other = (await query("world-b")) as { worlds: Array<{ current: boolean }> };
    assert.equal(other.worlds[0]?.current, false, "another world key is a different question, not a cached answer");
  });
});
