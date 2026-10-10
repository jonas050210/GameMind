import assert from "node:assert/strict";
import test from "node:test";
import { EnhancedLearner, type EnhancedEpisodeDraft } from "../src/core/learning/enhanced-learner.js";
import { ExperienceLearner } from "../src/core/learning/learner.js";

function baseDraft(overrides: Partial<EnhancedEpisodeDraft> = {}): EnhancedEpisodeDraft {
  return {
    runId: "test-run-1",
    taskId: "test-task-1",
    sessionId: null,
    sequence: 0,
    worldKey: "test-world",
    policyVersion: null,
    targetKey: "oak_log@10,64,0",
    features: {
      goalClass: "collect",
      skillId: "minecraft.gather_resource",
      band: 4,
      distance: 12,
      distanceBand: "medium",
      health: 20,
      hunger: 18,
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKind: "oak_log",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "succeeded",
      confirmed: true,
      verified: true,
      progress: true,
      failureCode: null,
      itemsGained: 1,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 1000,
      distanceAfter: 5,
      safetyDenied: false,
    },
    ...overrides,
  };
}

test("EnhancedLearner: records episodes with reward", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  enhanced.beginRun({ runId: "run-1", taskId: "task-1", worldKey: "world-1" });
  const { reward } = enhanced.recordEpisodeWithReward(baseDraft());
  assert.ok(reward.total > 0);
  assert.ok(reward.progress > 0);
});

test("EnhancedLearner: tracks reward statistics", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  enhanced.beginRun({ runId: "run-1", taskId: "task-1", worldKey: "world-1" });
  enhanced.recordEpisodeWithReward(baseDraft());
  enhanced.recordEpisodeWithReward(baseDraft({
    outcome: {
      ...baseDraft().outcome,
      status: "failed",
      progress: false,
      confirmed: false,
      itemsGained: 0,
    },
  }));
  const snap = enhanced.snapshot();
  assert.equal(snap.rewardStats.totalEpisodes, 2);
  assert.notEqual(snap.rewardStats.meanReward, 0);
});

test("EnhancedLearner: updates class failure memory on failure", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  enhanced.beginRun({ runId: "run-1", taskId: "task-1", worldKey: "world-1" });
  enhanced.recordEpisodeWithReward(baseDraft({
    outcome: {
      ...baseDraft().outcome,
      status: "failed",
      progress: false,
      confirmed: false,
      failureCode: "stuck",
      itemsGained: 0,
    },
  }));
  assert.ok(enhanced.classFailureMemory.size > 0);
});

test("EnhancedLearner: provides access to checkpoint store", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  assert.ok(enhanced.checkpointStore);
  assert.equal(enhanced.checkpointStore.all.length, 0);
});

test("EnhancedLearner: provides access to experiment store", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  assert.ok(enhanced.experimentStore);
  assert.equal(enhanced.experimentStore.all.length, 0);
});

test("EnhancedLearner: saves checkpoints on finishRun", async () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  enhanced.beginRun({ runId: "run-1", taskId: "task-1", worldKey: "world-1" });
  enhanced.recordEpisodeWithReward(baseDraft());
  const report = await enhanced.finishRun();
  assert.ok(report.rewardStats);
  assert.ok(typeof report.classFailurePatterns === "number");
});

test("EnhancedLearner: returns enhanced snapshot with all sections", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  const snap = enhanced.snapshot();
  assert.ok(snap.base);
  assert.ok(snap.rewardStats);
  assert.ok(snap.classFailure);
  assert.ok(snap.checkpoints);
  assert.ok(snap.experiments);
});

test("EnhancedLearner: delegates advisor()", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  const advisor = enhanced.advisor();
  assert.ok(advisor);
  assert.equal(advisor.source, "baseline");
});

test("EnhancedLearner: reports enabled state", () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });
  assert.equal(enhanced.enabled, true);
});
