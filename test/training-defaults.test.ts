/** The saved training default: read, write, archive, and the rule that picks the worker count from a probe. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTrainingArgs } from "../src/training/cli.js";
import { readTrainingDefaults, saveTrainingDefaults, type TrainingDefaults } from "../src/training/defaults.js";
import { chooseWorkerCount, type ProbeResult } from "../src/training/throughput-probe.js";

function defaults(overrides: Partial<TrainingDefaults> = {}): TrainingDefaults {
  return {
    schemaVersion: 1,
    workers: 2,
    explorationRate: 0.15,
    savedAt: "2026-10-10T10:00:00.000Z",
    benchmark: "gui-1",
    decision: "test",
    probe: null,
    machine: { platform: "linux", cpus: 2, memoryGb: 4, node: "v22" },
    ...overrides,
  };
}

test("no saved default reads as null; a saved one reads back unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "defaults-"));
  try {
    const path = join(dir, "training-defaults.json");
    assert.equal(await readTrainingDefaults(path), null);
    await saveTrainingDefaults(path, defaults());
    assert.deepEqual(await readTrainingDefaults(path), defaults());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saving a new default archives the previous one instead of overwriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "defaults-"));
  try {
    const path = join(dir, "training-defaults.json");
    await saveTrainingDefaults(path, defaults({ workers: 1, savedAt: "2026-10-09T09:00:00.000Z" }));
    const result = await saveTrainingDefaults(path, defaults({ workers: 3 }));
    assert.ok(result.archivedAs, "the old default was archived");
    const archived = JSON.parse(await readFile(result.archivedAs!, "utf8")) as TrainingDefaults;
    assert.equal(archived.workers, 1);
    assert.equal((await readTrainingDefaults(path))?.workers, 3);
    assert.equal((await readdir(join(dir, "training-defaults-history"))).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a damaged default is an explicit error, not a silent fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "defaults-"));
  try {
    const path = join(dir, "training-defaults.json");
    await writeFile(path, "{ not json");
    await assert.rejects(() => readTrainingDefaults(path), /not valid JSON/);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, workers: 99 }));
    await assert.rejects(() => readTrainingDefaults(path), /does not match the expected format/);
    // Saving over a damaged file archives it first, so nothing is lost.
    const saved = await saveTrainingDefaults(path, defaults());
    assert.ok(saved.archivedAs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function probe(workers: number, episodesPerMinute: number, eligible = true): ProbeResult {
  return {
    workers,
    status: "measured",
    episodesMeasured: 10,
    measuredSeconds: 15,
    episodesPerMinute,
    cpuPercent: 50,
    peakRssMb: 300,
    respawns: 0,
    error: null,
    eligible,
    reason: "",
  };
}

test("the worker count is the smallest one within 10 % of the best eligible throughput", () => {
  // 3 workers is the fastest, but 2 is within 10 %: prefer 2 (less memory, fewer processes).
  assert.equal(chooseWorkerCount([probe(1, 1000), probe(2, 1800), probe(3, 1950), probe(4, 1200)]), 2);
  // Clear winner.
  assert.equal(chooseWorkerCount([probe(1, 1000), probe(2, 1500), probe(3, 1900), probe(4, 1200)]), 3);
  // An unstable count is never chosen, even if it was fastest.
  assert.equal(chooseWorkerCount([probe(1, 1000), probe(4, 5000, false)]), 1);
  // Nothing eligible: no recommendation.
  assert.equal(chooseWorkerCount([probe(1, 1000, false)]), null);
});

test("the training CLI takes --workers and --defaults-file and refuses out-of-range workers", () => {
  const args = parseTrainingArgs(["train", "--workers", "3", "--defaults-file", "x.json"]);
  assert.equal(args.workers, 3);
  assert.equal(args.defaultsFile, "x.json");
  assert.equal(parseTrainingArgs(["train"]).workers, undefined);
  assert.throws(() => parseTrainingArgs(["train", "--workers", "9"]), /--workers must be an integer from 1 through 8/);
});
