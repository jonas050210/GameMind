import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CurriculumStage } from "../src/training/curriculum.js";
import { runTraining } from "../src/training/trainer.js";
import type { EvaluationRun } from "../src/testing/eval/harness.js";

// Regression: the Control Center's "Episodes per stage" value was stored but never reached the pass check,
// so a stage always ended at the curriculum's own minimum (8 episodes).

const STAGES: CurriculumStage[] = [
  { id: "a", label: "a", scenarioIds: ["explore-remote-log"], minEpisodes: 2, passRate: 0.5 },
];

function successRun(): EvaluationRun {
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

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gm-stage-length-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a stage with episodesPerStage 5 does not pass before 5 episodes, even when every episode succeeds", async () => {
  await withRoot(async (root) => {
    const state = await runTraining({
      root,
      stages: STAGES,
      episodesPerStage: 5,
      maxEpisodes: 20,
      fresh: true,
      episodeRunner: async () => successRun(),
      pollMs: 5,
    });
    // The single stage ends at the first pass check after 5 episodes, so the run stops at 5 total.
    assert.equal(state.totalEpisodes, 5);
    assert.equal(state.status, "completed");
  });
});

test("the curriculum minimum is still a floor when episodesPerStage is lower", async () => {
  await withRoot(async (root) => {
    const state = await runTraining({
      root,
      stages: [{ ...STAGES[0]!, minEpisodes: 4 }],
      episodesPerStage: 1,
      maxEpisodes: 20,
      fresh: true,
      episodeRunner: async () => successRun(),
      pollMs: 5,
    });
    assert.equal(state.totalEpisodes, 4);
  });
});
