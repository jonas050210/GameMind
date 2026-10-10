import assert from "node:assert/strict";
import test from "node:test";
import { EnhancedLearner, type EnhancedEpisodeDraft } from "../src/core/learning/enhanced-learner.js";
import { ExperienceLearner } from "../src/core/learning/learner.js";
import { computeReward } from "../src/core/learning/reward.js";
import { assessRLReadiness } from "../src/core/learning/rl-readiness.js";
import { PolicyCheckpointStore } from "../src/core/learning/checkpoint.js";
import { ClassFailureMemory, deriveClassPatternKey } from "../src/core/learning/class-failure-memory.js";
import { equipmentTierOf, extendedContextKey, rewardConditionedWeight } from "../src/core/learning/episode-extended.js";
import { derivePolicyWeights } from "../src/core/learning/policy-weights.js";

/**
 * Integration test: full learning pipeline from episode recording through reward computation,
 * class failure memory, checkpoint creation, and policy assessment.
 *
 * This validates that all the new components work together correctly.
 */

function makeDraft(overrides: Partial<EnhancedEpisodeDraft> = {}): EnhancedEpisodeDraft {
  return {
    runId: "integration-run",
    taskId: "integration-task",
    sessionId: null,
    sequence: 0,
    worldKey: "integration-world",
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

test("integration: full episode → reward → failure memory → checkpoint pipeline", async () => {
  const base = new ExperienceLearner();
  const enhanced = new EnhancedLearner({ learner: base });

  // Run 1: successful episodes
  enhanced.beginRun({ runId: "run-1", taskId: "task-1", worldKey: "world-1" });

  const { reward: r1 } = enhanced.recordEpisodeWithReward(makeDraft({ sequence: 0 }));
  assert.ok(r1.total > 0, "Successful gathering should have positive reward");

  const { reward: r2 } = enhanced.recordEpisodeWithReward(makeDraft({
    sequence: 1,
    outcome: {
      status: "succeeded",
      confirmed: true,
      verified: true,
      progress: true,
      failureCode: null,
      itemsGained: 2,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 800,
      distanceAfter: 3,
      safetyDenied: false,
    },
  }));
  assert.ok(r2.total > r1.total, "Better outcome should have higher reward");

  const report1 = await enhanced.finishRun();
  assert.ok(report1.episodes === 2);
  assert.ok(report1.rewardStats.meanReward > 0);

  // Run 2: mix of success and failure
  enhanced.beginRun({ runId: "run-2", taskId: "task-2", worldKey: "world-1" });

  // A failure that should create a class-level pattern
  enhanced.recordEpisodeWithReward(makeDraft({
    sequence: 0,
    targetKey: "stone@20,64,5",
    features: {
      goalClass: "mine",
      skillId: "minecraft.mine_block",
      band: 2,
      distance: 6,
      distanceBand: "near",
      health: 18,
      hunger: 16,
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKind: "stone",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "failed",
      confirmed: false,
      verified: false,
      progress: false,
      failureCode: "no-progress",
      itemsGained: 0,
      itemsConsumed: 0,
      healthDelta: -2,
      foodDelta: 0,
      durationMs: 3000,
      distanceAfter: 6,
      safetyDenied: false,
    },
  }));

  const report2 = await enhanced.finishRun();
  assert.ok(report2.episodes === 1);
  assert.ok(enhanced.classFailureMemory.size > 0, "Failure should create class-level pattern");

  // Check snapshot completeness
  const snap = enhanced.snapshot();
  assert.ok(snap.base);
  assert.ok(snap.rewardStats.totalEpisodes > 0);
  assert.ok(snap.classFailure.patterns > 0);
  assert.ok(snap.checkpoints.total > 0);
});

test("integration: reward signal correctly reflects survival priority", () => {
  // Near-death should have strongly negative reward even if items were gained
  const nearDeath = computeReward({
    status: "succeeded",
    confirmed: true,
    progress: true,
    safetyDenied: false,
    itemsGained: 5,
    itemsConsumed: 0,
    healthDelta: -12,
    foodDelta: 0,
    durationMs: 1000,
    distanceAfter: 10,
    health: 4,
    hunger: 15,
    goalClass: "mine",
    skillId: "minecraft.mine_block",
  });
  assert.ok(nearDeath.survival < 0, "Near-death should penalise survival component");

  // Safe success should have positive reward
  const safeSuccess = computeReward({
    status: "succeeded",
    confirmed: true,
    progress: true,
    safetyDenied: false,
    itemsGained: 1,
    itemsConsumed: 0,
    healthDelta: 0,
    foodDelta: 0,
    durationMs: 1000,
    distanceAfter: 5,
    health: 20,
    hunger: 18,
    goalClass: "collect",
    skillId: "minecraft.gather_resource",
  });
  assert.ok(safeSuccess.total > 0, "Safe success should have positive reward");
  assert.ok(safeSuccess.total > nearDeath.total, "Safe success should outweigh dangerous success");
});

test("integration: class failure memory generalises across targets", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });

  // Mine stone at 5 different locations with the same failure code
  const targets = ["stone@10,64,0", "stone@20,64,5", "stone@30,64,-3", "stone@40,64,10", "stone@50,64,-8"];
  for (let i = 0; i < targets.length; i++) {
    memory.recordFailure({
      patternKey: deriveClassPatternKey("minecraft.mine_block", "mine", "no-progress", "wooden", null),
      skillId: "minecraft.mine_block",
      goalClass: "mine",
      condition: "eq:wooden",
      targetKey: targets[i]!,
      runIndex: i,
    });
  }

  // Should be blocked at the class level
  const patternKey = deriveClassPatternKey("minecraft.mine_block", "mine", "no-progress", "wooden", null);
  assert.ok(memory.isBlocked(patternKey, 5), "Should block after 5 failures at 5 different targets");

  // Should match on findBlockingPattern
  const blocking = memory.findBlockingPattern("minecraft.mine_block", "mine", "eq:wooden", 5);
  assert.ok(blocking !== null, "Should find matching blocking pattern");

  // Should NOT block for a different skill
  const otherBlocking = memory.findBlockingPattern("minecraft.gather_resource", "collect", null, 5);
  assert.equal(otherBlocking, null, "Should not block unrelated skill");
});

test("integration: extended context key prevents fragmentation", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";

  // Without extensions: just the base key
  const basic = extendedContextKey(base, {});
  assert.equal(basic, base);

  // With only relevant extensions: should be specific but not overly fragmented
  const withNight = extendedContextKey(base, { timeOfDay: "night" });
  assert.equal(withNight, `${base}|night`);

  // Unknown extensions should be skipped
  const withUnknown = extendedContextKey(base, { timeOfDay: "unknown", equipmentTier: "none" });
  assert.equal(withUnknown, base);
});

test("integration: RL readiness assessment is honest about blockers", () => {
  const assessment = assessRLReadiness();
  // Score should not be 100 — there are real blockers
  assert.ok(assessment.score < assessment.maxScore);
  // Should have at least 3 blockers
  assert.ok(assessment.blockers.length >= 3);
  // Should identify the critical ones
  const blockerText = assessment.blockers.join(" ");
  assert.ok(blockerText.includes("Fast training environment"));
  assert.ok(blockerText.includes("Sim-to-real transfer"));
  // Should identify what IS ready
  assert.ok(assessment.ready.includes("Continuous state representation"));
  assert.ok(assessment.ready.includes("Reward function"));
  assert.ok(assessment.ready.includes("Safety broker integration"));
});

test("integration: checkpoint store preserves policy history", () => {
  const store = new PolicyCheckpointStore();

  // Save two different policies
  const stats1 = { "ctx1": { attempts: 10, successes: 8, progressCount: 8, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: {}, ewmaDurationMs: 1000, ewmaGain: 1.0, totalDistance: 50, distanceSamples: 10, lastSequence: 10 } };
  const stats2 = { "ctx2": { attempts: 15, successes: 12, progressCount: 12, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: {}, ewmaDurationMs: 800, ewmaGain: 1.5, totalDistance: 80, distanceSamples: 15, lastSequence: 15 } };

  const w1 = derivePolicyWeights(stats1, { id: "policy-v1" });
  const w2 = derivePolicyWeights(stats2, { id: "policy-v2" });

  store.save(w1, { episodes: 50, runs: 5, contexts: 1, successes: 40, failures: 10, rewardStats: null }, "first policy");
  store.save(w2, { episodes: 100, runs: 10, contexts: 1, successes: 80, failures: 20, rewardStats: null }, "improved policy");

  assert.equal(store.all.length, 2);
  assert.equal(store.versions.length, 2);

  // Activate the second
  store.activate("policy-v2");
  assert.equal(store.active?.policyId, "policy-v2");

  // Rollback to first
  const previous = store.rollback();
  assert.equal(previous?.policyId, "policy-v1");

  // Mark the second as gate-passed
  store.activate("policy-v2");
  store.markGatePass("policy-v2", [{ scenarioId: "gather-logs", seeds: 20, successRate: 0.95, safeRate: 1.0, meanReward: 2.0 }]);
  const v2Record = store.versions.find((v: { id: string }) => v.id === "policy-v2");
  assert.ok(v2Record?.passedGate);
  assert.ok(v2Record?.evalResults);
});
