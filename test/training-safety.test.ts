/**
 * Training must never touch data it does not own: one run per directory (enforced by a lock file), no silent
 * overwrite of checkpoints, a fresh start that is confirmed and archives instead of deleting, and an evaluation
 * that says what it actually established instead of presenting "no change" as a measurement.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BASELINE_POLICY_WEIGHTS } from "../src/core/learning/policy-weights.js";
import { acquireTrainingLock, readTrainingLock, TrainingLockError, TRAINING_LOCK_FILE } from "../src/training/lock.js";
import { TrainingManager } from "../src/training/manager.js";
import { saveTrainingDefaults } from "../src/training/defaults.js";
import { analyseComparison, evaluateCheckpoint, wilsonInterval, type PolicyMeasurement } from "../src/training/evaluate.js";
import { DEFAULT_TRAINING_EXPLORATION_RATE, type CurriculumStage } from "../src/training/curriculum.js";
import { readTrainingState, trainingPaths } from "../src/training/state.js";
import { runTraining, saveCheckpoint, TrainingDirectoryError, type EpisodeRunner } from "../src/training/trainer.js";
import type { EvaluationRun } from "../src/testing/eval/harness.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";

const STAGES: CurriculumStage[] = [
  { id: "a", label: "a", scenarioIds: ["explore-remote-log"], minEpisodes: 2, passRate: 0.5 },
  { id: "b", label: "b", scenarioIds: ["food-remote-berries"], minEpisodes: 2, passRate: 0.5 },
];

function fakeRun(success: boolean, choices: string[] = []): EvaluationRun {
  return {
    scenarioId: "fake",
    seed: 0,
    status: success ? "succeeded" : "failed",
    success,
    safe: true,
    died: false,
    simulatedMs: 1_000,
    metrics: { actions: 3, wastedActions: 0, unsafeActions: 0, unverifiedConfirmations: 0, progressEvents: 1 } as unknown as EvaluationRun["metrics"],
    worldStats: { damageTaken: 0, minHealth: 20, starvationTicks: 0 },
    actionGoals: [],
    actionChoices: choices,
    failureCode: success ? null : "CONSECUTIVE_ACTION_FAILURES",
  };
}

const passing: EpisodeRunner = async () => fakeRun(true);

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gamemind-training-safety-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the lock admits one holder, names it to the loser, and replaces a stale lock", async () => {
  await withRoot(async (root) => {
    const first = acquireTrainingLock(root, "train", { pid: 4_001, isAlive: () => true });
    assert.equal(readTrainingLock(root, { isAlive: () => true })?.pid, 4_001);

    assert.throws(
      () => acquireTrainingLock(root, "train", { pid: 4_002, isAlive: () => true }),
      (error: unknown) => {
        assert.ok(error instanceof TrainingLockError);
        assert.equal(error.holder.pid, 4_001);
        assert.match(error.message, /already in use by a training run \(process 4001/);
        assert.match(error.message, new RegExp(TRAINING_LOCK_FILE), "the message says which file to delete if the lock is wrong");
        return true;
      },
    );

    // The holder died without cleaning up: its lock is stale and does not wedge the directory.
    const second = acquireTrainingLock(root, "evaluate", { pid: 4_003, isAlive: (pid) => pid !== 4_001 });
    assert.equal(readTrainingLock(root, { isAlive: () => true })?.pid, 4_003);
    assert.equal(readTrainingLock(root, { isAlive: () => true })?.kind, "evaluate");

    // A late release by the dead holder must not remove the lock that replaced it.
    first.release();
    assert.equal(readTrainingLock(root, { isAlive: () => true })?.pid, 4_003, "only the owner's release removes the lock");
    second.release();
    assert.equal(readTrainingLock(root), null);
  });
});

test("a garbled lock file cannot wedge a directory", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, TRAINING_LOCK_FILE), "{ not json");
    const lock = acquireTrainingLock(root, "train", { pid: 4_010 });
    assert.equal(readTrainingLock(root, { isAlive: () => true })?.pid, 4_010);
    lock.release();
  });
});

test("two trainers cannot share a directory: the second is refused before it writes anything", async () => {
  await withRoot(async (root) => {
    const other = acquireTrainingLock(root, "train", { pid: 777_001, isAlive: () => true });
    await assert.rejects(
      runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: passing, lockEnvironment: { isAlive: () => true } }),
      (error: unknown) => error instanceof TrainingLockError && /process 777001/.test(error.message),
    );
    assert.equal(await readTrainingState(trainingPaths(root)), null, "the refused run wrote no state");
    other.release();
    const state = await runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: passing });
    assert.equal(state.totalEpisodes, 2, "once the other holder is gone the run proceeds");
    assert.equal(readTrainingLock(root), null, "the lock is released when the run ends");
  });
});

test("an evaluation takes the same lock, so it cannot run while a trainer holds the directory", async () => {
  await withRoot(async (root) => {
    await runTraining({ root, stages: STAGES, maxEpisodes: 4, episodeRunner: passing });
    const holder = acquireTrainingLock(root, "train", { pid: 777_002, isAlive: () => true });
    await assert.rejects(
      evaluateCheckpoint({ root, seeds: 1, scenarios: evaluationScenarios().slice(0, 1), episodeRunner: async () => fakeRun(true), lockEnvironment: { isAlive: () => true } }),
      TrainingLockError,
    );
    holder.release();
  });
});

test("a directory with data but no state file is refused instead of being overwritten", async () => {
  await withRoot(async (root) => {
    const paths = trainingPaths(root);
    await mkdir(paths.checkpoints, { recursive: true });
    await writeFile(join(paths.checkpoints, "ckpt-000008.json"), JSON.stringify({ weights: BASELINE_POLICY_WEIGHTS }));
    await assert.rejects(
      runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: passing }),
      (error: unknown) => error instanceof TrainingDirectoryError && /already holds data \(1 checkpoint/.test(error.message) && /archived, never deleted/.test(error.message),
    );
    assert.equal((await readdir(paths.checkpoints)).length, 1, "the existing checkpoint is untouched");

    // The explicit way forward archives the old data and starts clean.
    const state = await runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: passing, fresh: true });
    assert.equal(state.totalEpisodes, 2);
    const archives = await readdir(join(root, "archive"));
    assert.equal(archives.length, 1);
    assert.ok((await readdir(join(root, "archive", archives[0]!))).includes("checkpoints"), "the old checkpoint folder was moved, not deleted");
  });
});

test("saveCheckpoint never replaces an existing checkpoint with different weights", async () => {
  await withRoot(async (root) => {
    const paths = trainingPaths(root);
    const now = () => new Date("2026-01-01T00:00:00Z");
    const learned = { ...BASELINE_POLICY_WEIGHTS, id: "learned-1", source: "experience" as const, entries: { "k|a|b|c|d": { weight: 1.2, samples: 9, evidence: 0.8, successRate: 1 } } };
    await saveCheckpoint(paths, learned, "a", 8, now);
    // The same weights again are idempotent.
    await saveCheckpoint(paths, learned, "a", 8, now);
    const different = { ...learned, id: "learned-2", entries: { "k|a|b|c|d": { weight: 0.8, samples: 9, evidence: 0.1, successRate: 0 } } };
    await assert.rejects(saveCheckpoint(paths, different, "a", 8, now), (error: unknown) => error instanceof TrainingDirectoryError && /refusing to overwrite/.test(error.message));
    const stored = JSON.parse(await readFile(join(paths.checkpoints, "ckpt-000008.json"), "utf8")) as { weights: { id: string } };
    assert.equal(stored.weights.id, "learned-1", "the original checkpoint survived");
  });
});

test("a run records its stages and exploration rate, and cannot be resumed with other stages", async () => {
  await withRoot(async (root) => {
    const first = await runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: passing, explorationRate: 0.2 });
    assert.deepEqual(first.stageIds, ["a", "b"]);
    assert.equal(first.explorationRate, 0.2);
    await assert.rejects(
      runTraining({ root, stages: [STAGES[1]!], maxEpisodes: 6, episodeRunner: passing }),
      (error: unknown) => error instanceof TrainingDirectoryError && /resuming it with \[b\] would misplace its progress/.test(error.message),
    );
    const resumed = await runTraining({ root, stages: STAGES, maxEpisodes: 6, episodeRunner: passing });
    assert.ok(resumed.totalEpisodes > 2, "the same stages resume normally");
  });
});

function measurement(runs: Array<{ scenarioId: string; success: boolean; choices: string }>): PolicyMeasurement {
  return {
    label: "m",
    metrics: { label: "m", runs: runs.length, successRate: 0, unsafeActions: 0, deaths: 0, unverifiedConfirmations: 0, medianActions: 3, scenarios: [] },
    meanWastedActions: 0,
    medianSimulatedSeconds: 1,
    failureCodes: {},
    runs: runs.map((run, index) => ({ scenarioId: run.scenarioId, seed: index, success: run.success, actions: 3, wastedActions: 0, choices: run.choices })),
  };
}

const NO_DELTAS = { successRate: 0, medianActions: 0, meanWastedActions: 0, unsafeActions: 0, deaths: 0 };
const DECISION = (promote: boolean) => ({ promote, reasons: [], blocking: [] }) as unknown as Parameters<typeof analyseComparison>[3];

test("an evaluation says what it established: a checkpoint without learned weights is the baseline, not a tie", () => {
  const same = measurement([{ scenarioId: "s", success: true, choices: "x" }]);
  const result = analyseComparison(same, same, 0, DECISION(false), NO_DELTAS);
  assert.equal(result.conclusion, "no-learned-contexts");
  assert.match(result.explanation, /holds no learned weights/);
  assert.match(result.explanation, /8 verified attempts/);
});

test("weights that never changed a decision are reported as identical behaviour, not as a measured tie", () => {
  const base = measurement([{ scenarioId: "s", success: true, choices: "x" }, { scenarioId: "t", success: false, choices: "y" }]);
  const result = analyseComparison(base, base, 6, DECISION(false), NO_DELTAS);
  assert.equal(result.conclusion, "identical-behaviour");
  assert.deepEqual(result.behaviour, { pairedRuns: 2, runsWithDifferentChoices: 0, scenariosWithDifferentChoices: 0 });
  assert.match(result.explanation, /never changed a decision/);
});

test("changed behaviour is classified by what the gate and the deltas say", () => {
  const base = measurement([{ scenarioId: "s", success: false, choices: "x" }, { scenarioId: "t", success: true, choices: "y" }]);
  const better = measurement([{ scenarioId: "s", success: true, choices: "z" }, { scenarioId: "t", success: true, choices: "y" }]);
  const improved = analyseComparison(base, better, 3, DECISION(true), { ...NO_DELTAS, successRate: 0.5 });
  assert.equal(improved.conclusion, "improved");
  assert.deepEqual(improved.paired, { candidateBetter: 1, baselineBetter: 0, tied: 1 });
  assert.deepEqual(improved.behaviour, { pairedRuns: 2, runsWithDifferentChoices: 1, scenariosWithDifferentChoices: 1 });

  const worse = measurement([{ scenarioId: "s", success: false, choices: "z" }, { scenarioId: "t", success: false, choices: "y" }]);
  const regressed = analyseComparison(base, worse, 3, DECISION(false), { ...NO_DELTAS, successRate: -0.5 });
  assert.equal(regressed.conclusion, "regressed");

  const neutral = measurement([{ scenarioId: "s", success: false, choices: "z" }, { scenarioId: "t", success: true, choices: "y" }]);
  const flat = analyseComparison(base, neutral, 3, DECISION(false), NO_DELTAS);
  assert.equal(flat.conclusion, "behaviour-changed-no-gain");
});

test("Wilson intervals widen as the sample shrinks and never leave 0..1", () => {
  const small = wilsonInterval(3, 4);
  const large = wilsonInterval(192, 260);
  assert.ok(small.high - small.low > large.high - large.low);
  for (const interval of [small, large, wilsonInterval(0, 5), wilsonInterval(5, 5), wilsonInterval(0, 0)]) {
    assert.ok(interval.low >= 0 && interval.high <= 1 && interval.low <= interval.high);
  }
  assert.ok(large.low < 192 / 260 && large.high > 192 / 260);
});

test("evaluating a checkpoint with no learned weights is reported as no-learned-contexts end to end, and the baseline is recorded once", async () => {
  await withRoot(async (root) => {
    // Stop a run after very few episodes: its partial checkpoint has no context with 8 attempts.
    const state = await runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: passing });
    assert.equal(state.checkpoints.at(-1)?.weightedContexts, 0, "two stub episodes record no experience, so no context is weighted");
    const scenarios = evaluationScenarios().slice(0, 2);
    const runner: EpisodeRunner = async () => fakeRun(true, ["goal@target"]);
    const first = await evaluateCheckpoint({ root, seeds: 2, scenarios, episodeRunner: runner });
    assert.equal(first.conclusion, "no-learned-contexts");
    assert.equal(first.verdict, "not-promotable");
    assert.equal(first.candidateContent?.learnedContexts, 0);
    assert.equal(first.baselineStability?.stable, true);
    assert.match(first.baselineStability?.note ?? "", /First baseline recorded/);
    const after = await readTrainingState(trainingPaths(root));
    assert.equal(after?.lastEvaluation?.conclusion, "no-learned-contexts");
    assert.match(after?.lastEvaluation?.reasons[0] ?? "", /holds no learned weights/, "the explanation leads the reasons shown to the operator");

    const second = await evaluateCheckpoint({ root, seeds: 2, scenarios, episodeRunner: runner });
    assert.equal(second.baselineStability?.stable, true);
    assert.match(second.baselineStability?.note ?? "", /reproduced the one first recorded/);

    // A different baseline for the same evaluation set is flagged, not silently accepted.
    const drifting: EpisodeRunner = async () => fakeRun(true, ["a-different-choice"]);
    const third = await evaluateCheckpoint({ root, seeds: 2, scenarios, episodeRunner: drifting });
    assert.equal(third.baselineStability?.stable, false);
    assert.match(third.baselineStability?.note ?? "", /no longer matches/);
  });
});

test("the manager explains a fresh start before it happens, and refuses it without explicit confirmation", async () => {
  await withRoot(async (root) => {
    const manager = new TrainingManager({ root, displayRoot: "data/example", entry: join(root, "never-run.mjs") });
    const empty = await manager.preflight();
    assert.equal(empty.directory, "data/example");
    assert.equal(empty.fresh.needsConfirmation, false, "nothing to archive, so nothing to confirm");
    assert.equal(empty.existing.hasRun, false);

    await runTraining({ root, stages: STAGES, maxEpisodes: 4, episodeRunner: passing });
    const used = await manager.preflight();
    assert.equal(used.existing.hasRun, true);
    assert.equal(used.fresh.needsConfirmation, true);
    assert.ok(used.fresh.wouldArchive.some((line) => line.startsWith("state.json")));
    assert.ok(used.fresh.wouldArchive.some((line) => line.startsWith("checkpoints/")));
    assert.match(used.fresh.summary, /data\/example\/archive\//);
    assert.ok(used.fresh.consequences.some((line) => /archived, not deleted/.test(line)));
    assert.ok(used.fresh.consequences.some((line) => /not learning in a real Minecraft world/.test(line)));
    assert.ok(!JSON.stringify(used).includes(root), "no absolute path appears in what the operator is shown");

    const before = await readFile(trainingPaths(root).state, "utf8");
    const refused = await manager.start({ fresh: true });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /confirm it explicitly; nothing was changed/);
    assert.equal(await readFile(trainingPaths(root).state, "utf8"), before, "the refused fresh start changed nothing");
    assert.equal((await readdir(root)).includes("archive"), false, "and archived nothing");
  });
});

test("a start without its own settings uses the saved benchmark default for workers and exploration", async () => {
  await withRoot(async (root) => {
    const entry = join(root, "record-args.mjs");
    await writeFile(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
    const defaultsFile = join(root, "..", `${root.split(/[\\/]/).pop()}-defaults.json`);
    await saveTrainingDefaults(defaultsFile, {
      schemaVersion: 1,
      workers: 3,
      explorationRate: 0.3,
      savedAt: "2026-10-10T10:00:00.000Z",
      benchmark: "gui-test",
      decision: "test",
      probe: null,
      machine: { platform: "test", cpus: 1, memoryGb: 1, node: "test" },
    });
    try {
      const manager = new TrainingManager({ root, entry, defaultsFile });
      const started = await manager.start({ fresh: true, confirmFresh: true, maxEpisodes: 30, stageIds: ["basics"] });
      assert.equal(started.ok, true, started.message);
      const deadline = Date.now() + 8_000;
      let recorded: string[] | null = null;
      while (Date.now() < deadline && recorded === null) {
        recorded = await readFile(join(root, "args.json"), "utf8").then((text) => JSON.parse(text) as string[], () => null);
        if (recorded === null) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(recorded, "the child ran");
      assert.deepEqual(recorded!.slice(recorded!.indexOf("--explore"), recorded!.indexOf("--explore") + 2), ["--explore", "0.3"]);
      assert.deepEqual(recorded!.slice(recorded!.indexOf("--workers"), recorded!.indexOf("--workers") + 2), ["--workers", "3"]);
    } finally {
      await rm(defaultsFile, { force: true });
    }
  });
});

test("a confirmed fresh start passes its options to the child process, with the default exploration rate", async () => {
  await withRoot(async (root) => {
    await runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: passing });
    const entry = join(root, "record-args.mjs");
    await writeFile(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
    const manager = new TrainingManager({ root, entry });
    const started = await manager.start({ fresh: true, confirmFresh: true, maxEpisodes: 30, stageIds: ["basics"] });
    assert.equal(started.ok, true, started.message);
    const deadline = Date.now() + 8_000;
    let recorded: string[] | null = null;
    while (Date.now() < deadline && recorded === null) {
      recorded = await readFile(join(root, "args.json"), "utf8").then((text) => JSON.parse(text) as string[], () => null);
      if (recorded === null) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(recorded, "the child ran");
    assert.ok(recorded!.includes("--fresh"));
    assert.deepEqual(recorded!.slice(recorded!.indexOf("--explore"), recorded!.indexOf("--explore") + 2), ["--explore", String(DEFAULT_TRAINING_EXPLORATION_RATE)]);
    assert.deepEqual(recorded!.slice(recorded!.indexOf("--stages"), recorded!.indexOf("--stages") + 2), ["--stages", "basics"]);
  });
});

test("the manager validates exploration and stage input and refuses a start while another process holds the directory", async () => {
  await withRoot(async (root) => {
    const manager = new TrainingManager({ root, entry: join(root, "never-run.mjs") });
    assert.equal((await manager.start({ explorationRate: 2 })).ok, false);
    assert.match((await manager.start({ stageIds: ["nope"] })).message, /Unknown curriculum stage\(s\): nope/);
    assert.match((await manager.start({ stageIds: [] })).message, /at least one curriculum stage/);
    // The manager probes real process liveness, so the lock is held under a pid that really exists: the parent shell.
    const self = acquireTrainingLock(root, "train", { pid: process.ppid || 1 });
    const blocked = await manager.start({});
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /Another process \(\d+\) is using this training directory/);
    self.release();
  });
});
