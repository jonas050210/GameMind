import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateCheckpoint } from "../src/training/evaluate.js";
import { assertSeedSplit, curriculumScenarios, TRAINING_SEED_BASE, TRAINING_STAGES, trainingSeed, type CurriculumStage } from "../src/training/curriculum.js";
import { readTrainingState, trainingPaths, writeControlCommand } from "../src/training/state.js";
import { runTraining, type EpisodeRunner } from "../src/training/trainer.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { evaluationSeeds, type EvaluationRun } from "../src/testing/eval/harness.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gamemind-training-"));
}

function fakeRun(success: boolean, actions = 4): EvaluationRun {
  return {
    scenarioId: "fake",
    seed: 0,
    status: success ? "succeeded" : "failed",
    success,
    safe: true,
    died: false,
    simulatedMs: 4_000,
    metrics: {
      actions,
      wastedActions: success ? 0 : 2,
      unsafeActions: 0,
      unverifiedConfirmations: 0,
      progressEvents: success ? 1 : 0,
    } as unknown as EvaluationRun["metrics"],
    worldStats: { damageTaken: 0, minHealth: 20, starvationTicks: 0 },
    actionGoals: [],
    actionChoices: [],
    failureCode: success ? null : "CONSECUTIVE_ACTION_FAILURES",
  };
}

const TWO_STAGES: CurriculumStage[] = [
  { id: "a", label: "a", scenarioIds: ["explore-remote-log"], minEpisodes: 2, passRate: 0.5 },
  { id: "b", label: "b", scenarioIds: ["food-remote-berries"], minEpisodes: 2, passRate: 0.5 },
];

test("curriculum: every scenario it names exists, and training seeds never collide with evaluation seeds", () => {
  assert.doesNotThrow(() => curriculumScenarios(TRAINING_STAGES));
  for (const stage of TRAINING_STAGES) assert.ok(stage.scenarioIds.length > 0, `${stage.id} has scenarios`);
  assert.throws(() => curriculumScenarios([{ ...TRAINING_STAGES[0]!, scenarioIds: ["no-such-scenario"] }]), /unknown scenario/);
  assert.doesNotThrow(() => assertSeedSplit(200, 5_000));
  assert.equal(trainingSeed(0), TRAINING_SEED_BASE);
  assert.ok(evaluationSeeds(200).every((seed) => seed < TRAINING_SEED_BASE));
});

test("training advances through stages, writes a checkpoint per passed stage and finishes", async () => {
  const root = await tempRoot();
  try {
    const seeds: number[] = [];
    const runner: EpisodeRunner = async (scenario, seed) => {
      seeds.push(seed);
      assert.ok(scenario.id.length > 0);
      return fakeRun(true);
    };
    const state = await runTraining({ root, stages: TWO_STAGES, maxEpisodes: 10, episodeRunner: runner, evaluationSeedCount: 10 });
    assert.equal(state.status, "completed");
    assert.equal(state.totalEpisodes, 4, "two stages of two passing episodes each");
    assert.deepEqual(state.checkpoints.map((checkpoint) => checkpoint.stageId), ["a", "b"]);
    assert.deepEqual(seeds, [0, 1, 2, 3].map((index) => trainingSeed(index)), "training seeds are monotonic and training-only");
    const checkpoint = JSON.parse(await readFile(state.checkpoints[0]!.path, "utf8")) as { weights: { id: string; entries: object } };
    assert.equal(checkpoint.weights.id, state.checkpoints[0]!.weightsId, "the checkpoint holds the weight table it reports");
    const persisted = await readTrainingState(trainingPaths(root));
    assert.equal(persisted?.totalEpisodes, 4, "state is persisted after the run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("training resumes from saved state without repeating a seed or losing progress", async () => {
  const root = await tempRoot();
  try {
    const seeds: number[] = [];
    const runner: EpisodeRunner = async (_scenario, seed) => {
      seeds.push(seed);
      return fakeRun(false);
    };
    const first = await runTraining({ root, stages: TWO_STAGES, maxEpisodes: 3, episodeRunner: runner });
    assert.equal(first.totalEpisodes, 3);
    assert.equal(first.status, "completed", "the episode budget ended the run");

    const second = await runTraining({ root, stages: TWO_STAGES, maxEpisodes: 6, episodeRunner: runner });
    assert.equal(second.totalEpisodes, 6, "the second run continues from the saved count");
    assert.deepEqual(seeds, [0, 1, 2, 3, 4, 5].map((index) => trainingSeed(index)), "no training seed is repeated across the resume");
    assert.ok(second.checkpoints.length >= first.checkpoints.length, "checkpoints accumulate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stop request ends training after the current episode and keeps a checkpoint", async () => {
  const root = await tempRoot();
  try {
    const paths = trainingPaths(root);
    const runner: EpisodeRunner = async (_scenario, seed) => {
      if (seed === trainingSeed(1)) await writeControlCommand(paths, "stop");
      return fakeRun(false);
    };
    const state = await runTraining({ root, stages: TWO_STAGES, maxEpisodes: 10, episodeRunner: runner });
    assert.equal(state.status, "stopped");
    assert.equal(state.totalEpisodes, 2, "the episode that was running finished; the next one did not start");
    assert.equal(state.checkpoints.at(-1)?.episodes, 2, "what was learned so far is checkpointed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pause holds training between episodes until it is resumed", async () => {
  const root = await tempRoot();
  try {
    const paths = trainingPaths(root);
    let observedPaused = false;
    const runner: EpisodeRunner = async (_scenario, seed) => {
      if (seed === trainingSeed(0)) {
        await writeControlCommand(paths, "pause");
        setTimeout(() => {
          void readTrainingState(paths).then(async (current) => {
            observedPaused = current?.status === "paused";
            await writeControlCommand(paths, "stop");
          });
        }, 150);
      }
      return fakeRun(false);
    };
    const state = await runTraining({ root, stages: TWO_STAGES, maxEpisodes: 10, episodeRunner: runner, pollMs: 20 });
    assert.equal(observedPaused, true, "the state reported paused while the trainer waited");
    assert.equal(state.totalEpisodes, 1, "no episode started while paused");
    assert.equal(state.status, "stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real simulator episode records a reward and a checkpoint, and evaluation stays on held-out seeds", async () => {
  const root = await tempRoot();
  try {
    const stages: CurriculumStage[] = [{ id: "smoke", label: "smoke", scenarioIds: ["explore-remote-log"], minEpisodes: 2, passRate: 0 }];
    const state = await runTraining({ root, stages, maxEpisodes: 2, evaluationSeedCount: 10 });
    assert.equal(state.status, "completed");
    assert.equal(state.recent.length, 2);
    for (const episode of state.recent) {
      assert.equal(typeof episode.reward, "number", "per-task reward comes from the learner, not a guess");
      assert.ok(episode.seed >= TRAINING_SEED_BASE);
    }
    assert.ok(state.checkpoints.length >= 1);

    const scenarios = evaluationScenarios().filter((scenario) => scenario.id === "explore-remote-log");
    const report = await evaluateCheckpoint({ root, seeds: 1, scenarios });
    assert.equal(report.heldOut.disjointSeeds, true);
    assert.deepEqual(report.heldOut.evaluationSeeds, evaluationSeeds(1));
    assert.ok(report.heldOut.evaluationSeeds.every((seed) => seed < TRAINING_SEED_BASE));
    assert.ok(["promotable", "not-promotable"].includes(report.verdict));
    assert.equal(report.baseline.metrics.runs, 1);
    assert.equal(report.candidate.metrics.runs, 1);
    const after = await readTrainingState(trainingPaths(root));
    assert.equal(after?.lastEvaluation?.checkpointId, report.checkpointId, "the verdict is recorded in the state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
