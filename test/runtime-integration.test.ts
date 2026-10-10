import assert from "node:assert/strict";
import test from "node:test";
import { ExperienceLearner, type EpisodeDraft } from "../src/core/learning/learner.js";
import type { ControlCenterLearning } from "../src/control-center/types.js";

/**
 * Validates that the base ExperienceLearner now computes rewards, tracks class failure patterns,
 * saves checkpoints, and exposes all data through its snapshot() — so the task runner and
 * Control Center receive complete learning data without needing a separate EnhancedLearner wrapper.
 */

function draft(overrides: Partial<EpisodeDraft> = {}): EpisodeDraft {
  return {
    runId: "runtime-run",
    taskId: "runtime-task",
    sessionId: null,
    sequence: 0,
    worldKey: "runtime-world",
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

test("runtime integration: recordEpisode computes reward", () => {
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "r1", taskId: "t1", worldKey: "w1" });
  learner.recordEpisode(draft());

  const snap = learner.snapshot();
  assert.ok(snap.reward.totalEpisodes === 1, `Expected 1 reward episode, got ${snap.reward.totalEpisodes}`);
  assert.ok(snap.reward.meanReward > 0, "Successful episode should produce positive mean reward");
});

test("runtime integration: multiple episodes update reward statistics", () => {
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "r1", taskId: "t1", worldKey: "w1" });
  learner.recordEpisode(draft({ sequence: 0 }));
  learner.recordEpisode(draft({ sequence: 1 }));
  learner.recordEpisode(draft({
    sequence: 2,
    outcome: {
      status: "failed",
      confirmed: false,
      verified: false,
      progress: false,
      failureCode: "stuck",
      itemsGained: 0,
      itemsConsumed: 0,
      healthDelta: -2,
      foodDelta: 0,
      durationMs: 3000,
      distanceAfter: 12,
      safetyDenied: false,
    },
  }));

  const snap = learner.snapshot();
  assert.equal(snap.reward.totalEpisodes, 3);
  // 2 positive + 1 negative → mean should be moderate
  assert.ok(snap.reward.meanReward !== 0);
  assert.ok(snap.reward.positiveRate > 0 && snap.reward.positiveRate < 1);
});

test("runtime integration: failures create class-level patterns", () => {
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "r1", taskId: "t1", worldKey: "w1" });
  learner.recordEpisode(draft({
    outcome: {
      status: "failed",
      confirmed: false,
      verified: false,
      progress: false,
      failureCode: "stuck",
      itemsGained: 0,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 2000,
      distanceAfter: 12,
      safetyDenied: false,
    },
  }));

  const snap = learner.snapshot();
  assert.ok(snap.classPatterns.length > 0, "A failure should create a class pattern");
});

test("runtime integration: finishRun creates checkpoint", async () => {
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "r1", taskId: "t1", worldKey: "w1" });
  learner.recordEpisode(draft());
  await learner.finishRun();

  const snap = learner.snapshot();
  assert.ok(snap.checkpoints.total > 0, "finishRun should create a checkpoint");
  assert.ok(snap.checkpoints.recent.length > 0, "Recent checkpoints should be listed");
});

test("runtime integration: snapshot includes RL readiness", () => {
  const learner = new ExperienceLearner();
  const snap = learner.snapshot();
  assert.ok(snap.rlReadiness);
  assert.equal(typeof snap.rlReadiness.score, "number");
  assert.ok(snap.rlReadiness.maxScore > 0);
  assert.ok(snap.rlReadiness.ready.length > 0);
  assert.ok(snap.rlReadiness.blockers.length > 0);
});

test("runtime integration: snapshot includes experiments (empty by default)", () => {
  const learner = new ExperienceLearner();
  const snap = learner.snapshot();
  assert.ok(Array.isArray(snap.experiments));
  assert.equal(snap.experiments.length, 0);
});

test("runtime integration: full snapshot shape matches ControlCenterLearning type", () => {
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "r1", taskId: "t1", worldKey: "w1" });
  learner.recordEpisode(draft());
  const snap = learner.snapshot();

  // Verify all fields the ControlCenterLearning type expects are present
  assert.ok(typeof snap.enabled === "boolean");
  assert.ok(typeof snap.runs === "number");
  assert.ok(typeof snap.episodes === "number");
  assert.ok(Array.isArray(snap.contexts));
  assert.ok(snap.activePolicy === null || typeof snap.activePolicy === "object");
  assert.ok(typeof snap.candidatePolicy === "object");
  assert.ok(Array.isArray(snap.failureMemory));
  assert.ok(Array.isArray(snap.history));
  assert.ok(snap.reward !== undefined);
  assert.ok(Array.isArray(snap.classPatterns));
  assert.ok(snap.checkpoints !== undefined);
  assert.ok(Array.isArray(snap.experiments));
  assert.ok(snap.rlReadiness !== undefined);
});

test("runtime integration: disabled learner has zero reward data", () => {
  const learner = new ExperienceLearner({ enabled: false });
  learner.beginRun({ runId: "r1", taskId: "t1", worldKey: "w1" });
  learner.recordEpisode(draft());
  const snap = learner.snapshot();
  assert.equal(snap.reward.totalEpisodes, 0);
  assert.equal(snap.reward.meanReward, 0);
});

test("runtime integration: safety denials produce negative safety reward", () => {
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "r1", taskId: "t1", worldKey: "w1" });
  learner.recordEpisode(draft({
    outcome: {
      status: "rejected",
      confirmed: false,
      verified: null,
      progress: false,
      failureCode: "SAFETY_LAVA_AHEAD",
      itemsGained: 0,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 100,
      distanceAfter: null,
      safetyDenied: true,
    },
  }));
  const snap = learner.snapshot();
  // Safety denial should result in a lower reward than a successful action
  assert.ok(snap.reward.meanReward <= 0, "Safety denial should produce non-positive reward");
});
