/**
 * Training data safety, offline unit tests: a fresh start archives the previous run instead of deleting it, and a
 * checkpoint edited after it was written is refused by evaluation. The episode runner is a stub here, so these tests
 * check persistence and integrity only; they are not evidence that the policy learns (see headless-training tests and
 * the training report for that).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CurriculumStage } from "../src/training/curriculum.js";
import { loadCheckpoint } from "../src/training/evaluate.js";
import { archiveTrainingArtifacts, canonicalDigest, readTrainingState, trainingPaths } from "../src/training/state.js";
import { runTraining, type EpisodeRunner } from "../src/training/trainer.js";
import type { EvaluationRun } from "../src/testing/eval/harness.js";

const STAGES: CurriculumStage[] = [
  { id: "a", label: "a", scenarioIds: ["explore-remote-log"], minEpisodes: 2, passRate: 0.5 },
];

function passing(): EvaluationRun {
  return {
    scenarioId: "fake",
    seed: 0,
    status: "succeeded",
    success: true,
    safe: true,
    died: false,
    simulatedMs: 4_000,
    metrics: { actions: 4, wastedActions: 0, unsafeActions: 0, unverifiedConfirmations: 0, progressEvents: 1 } as unknown as EvaluationRun["metrics"],
    worldStats: { damageTaken: 0, minHealth: 20, starvationTicks: 0 },
    actionGoals: [],
    failureCode: null,
  };
}

const stubRunner: EpisodeRunner = async () => passing();

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gamemind-integrity-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a fresh start archives the previous run, keeps its files byte-for-byte, and writes a manifest", async () => {
  await withRoot(async (root) => {
    await runTraining({ root, stages: STAGES, maxEpisodes: 4, episodeRunner: stubRunner });
    const paths = trainingPaths(root);
    const before = await readFile(paths.state, "utf8");
    const checkpointsBefore = await readdir(paths.checkpoints);
    assert.ok(checkpointsBefore.length >= 1, "the first run wrote at least one checkpoint");

    await runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: stubRunner, fresh: true });

    const archives = await readdir(join(root, "archive"));
    assert.equal(archives.length, 1, "exactly one archive was created");
    const archiveDir = join(root, "archive", archives[0]!);
    const manifest = JSON.parse(await readFile(join(archiveDir, "manifest.json"), "utf8")) as { moved: string[]; reason: string };
    assert.ok(manifest.moved.includes("state.json"));
    assert.ok(manifest.moved.includes("checkpoints"));
    assert.match(manifest.reason, /fresh/);
    assert.equal(await readFile(join(archiveDir, "state.json"), "utf8"), before, "the archived state is the old state, unchanged");
    for (const name of checkpointsBefore) {
      await readFile(join(archiveDir, "checkpoints", name), "utf8");
    }
  });
});

test("a fresh start with nothing to archive creates no archive directory", async () => {
  await withRoot(async (root) => {
    const result = await archiveTrainingArtifacts(trainingPaths(root), new Date(), "test");
    assert.equal(result.archiveDir, null);
    assert.deepEqual(result.moved, []);
  });
});

test("the digest does not depend on key order, so re-serialised checkpoints still verify", () => {
  const a = { schemaVersion: 1, weights: { id: "w", entries: { x: 1, y: 2 } } };
  const b = { weights: { entries: { y: 2, x: 1 }, id: "w" }, schemaVersion: 1 };
  assert.equal(canonicalDigest(a), canonicalDigest(b));
  assert.notEqual(canonicalDigest(a), canonicalDigest({ ...a, schemaVersion: 2 }), "a changed value changes the digest");
});

test("a checkpoint written by training carries a digest and loads as verified; an edited one is refused", async () => {
  await withRoot(async (root) => {
    await runTraining({ root, stages: STAGES, maxEpisodes: 4, episodeRunner: stubRunner });
    const paths = trainingPaths(root);
    const state = await readTrainingState(paths);
    const record = state?.checkpoints.at(-1);
    assert.ok(record, "a checkpoint was recorded");

    const verified = await loadCheckpoint(paths, record.id);
    assert.equal(verified.integrity, "verified");

    const raw = JSON.parse(await readFile(record.path, "utf8")) as { episodes: number };
    await writeFile(record.path, JSON.stringify({ ...raw, episodes: raw.episodes + 999 }, null, 2));
    await assert.rejects(loadCheckpoint(paths, record.id), /failed its integrity check/);
  });
});

test("a checkpoint from before digests existed still loads, marked unverified rather than refused", async () => {
  await withRoot(async (root) => {
    await runTraining({ root, stages: STAGES, maxEpisodes: 4, episodeRunner: stubRunner });
    const paths = trainingPaths(root);
    const record = (await readTrainingState(paths))?.checkpoints.at(-1);
    assert.ok(record);
    const raw = JSON.parse(await readFile(record.path, "utf8")) as Record<string, unknown>;
    delete raw.digest;
    await mkdir(join(root, "checkpoints"), { recursive: true });
    await writeFile(record.path, JSON.stringify(raw, null, 2));
    const loaded = await loadCheckpoint(paths, record.id);
    assert.equal(loaded.integrity, "unverified-legacy");
  });
});
