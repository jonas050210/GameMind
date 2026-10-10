import assert from "node:assert/strict";
import test from "node:test";
import {
  PolicyCheckpointStore,
  ExperimentStore,
} from "../src/core/learning/checkpoint.js";
import { derivePolicyWeights } from "../src/core/learning/policy-weights.js";
import { emptySkillStatistics } from "../src/core/learning/skill-statistics.js";

test("PolicyCheckpointStore: starts with no checkpoints", () => {
  const store = new PolicyCheckpointStore();
  assert.equal(store.all.length, 0);
  assert.equal(store.active, null);
});

test("PolicyCheckpointStore: saves a checkpoint", () => {
  const store = new PolicyCheckpointStore();
  const weights = derivePolicyWeights(emptySkillStatistics(), { id: "test-v1" });
  const cp = store.save(weights, {
    episodes: 10, runs: 2, contexts: 3, successes: 8, failures: 2, rewardStats: null,
  }, "test checkpoint");
  assert.equal(cp.policyId, "test-v1");
  assert.equal(store.all.length, 1);
});

test("PolicyCheckpointStore: does not duplicate same fingerprint", () => {
  const store = new PolicyCheckpointStore();
  const weights = derivePolicyWeights(emptySkillStatistics(), { id: "test-v1" });
  store.save(weights, { episodes: 10, runs: 2, contexts: 0, successes: 8, failures: 2, rewardStats: null }, "first");
  store.save(weights, { episodes: 10, runs: 2, contexts: 0, successes: 8, failures: 2, rewardStats: null }, "second");
  assert.equal(store.all.length, 1);
});

test("PolicyCheckpointStore: activates a checkpoint", () => {
  const store = new PolicyCheckpointStore();
  const weights = derivePolicyWeights(emptySkillStatistics(), { id: "test-v1" });
  store.save(weights, { episodes: 10, runs: 2, contexts: 0, successes: 8, failures: 2, rewardStats: null }, "test");
  assert.equal(store.activate("test-v1"), true);
  assert.equal(store.active?.policyId, "test-v1");
});

test("PolicyCheckpointStore: fails to activate non-existent checkpoint", () => {
  const store = new PolicyCheckpointStore();
  assert.equal(store.activate("nonexistent"), false);
});

test("PolicyCheckpointStore: rolls back to previous checkpoint", () => {
  const store = new PolicyCheckpointStore();
  // Use weights with different entries so they have different fingerprints
  const stats1 = { "ctx1": { attempts: 10, successes: 8, progressCount: 8, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: {}, ewmaDurationMs: 1000, ewmaGain: 1.0, totalDistance: 50, distanceSamples: 10, lastSequence: 10 } };
  const stats2 = { "ctx2": { attempts: 15, successes: 12, progressCount: 12, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: {}, ewmaDurationMs: 800, ewmaGain: 1.5, totalDistance: 80, distanceSamples: 15, lastSequence: 15 } };
  const w1 = derivePolicyWeights(stats1, { id: "v1" });
  const w2 = derivePolicyWeights(stats2, { id: "v2" });
  store.save(w1, { episodes: 5, runs: 1, contexts: 1, successes: 4, failures: 1, rewardStats: null }, "first");
  store.save(w2, { episodes: 10, runs: 2, contexts: 1, successes: 8, failures: 2, rewardStats: null }, "second");
  store.activate("v1");
  store.activate("v2");
  const previous = store.rollback();
  assert.equal(previous?.policyId, "v1");
});

test("PolicyCheckpointStore: compares two checkpoints", () => {
  const store = new PolicyCheckpointStore();
  const stats1 = { "ctx1": { attempts: 10, successes: 8, progressCount: 8, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: {}, ewmaDurationMs: 1000, ewmaGain: 1.0, totalDistance: 50, distanceSamples: 10, lastSequence: 10 } };
  const stats2 = { "ctx2": { attempts: 15, successes: 12, progressCount: 12, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: {}, ewmaDurationMs: 800, ewmaGain: 1.5, totalDistance: 80, distanceSamples: 15, lastSequence: 15 } };
  const w1 = derivePolicyWeights(stats1, { id: "v1" });
  const w2 = derivePolicyWeights(stats2, { id: "v2" });
  store.save(w1, { episodes: 5, runs: 1, contexts: 1, successes: 4, failures: 1, rewardStats: null }, "first");
  store.save(w2, { episodes: 10, runs: 2, contexts: 1, successes: 8, failures: 2, rewardStats: null }, "second");
  const comparison = store.compare("v1", "v2");
  assert.notEqual(comparison, null);
  // v1 has ctx1, v2 has ctx2 — they share 0 keys
  assert.equal(comparison!.shared, 0);
  assert.equal(comparison!.leftOnly, 1);
  assert.equal(comparison!.rightOnly, 1);
});

test("PolicyCheckpointStore: returns null for missing comparison", () => {
  const store = new PolicyCheckpointStore();
  assert.equal(store.compare("v1", "v2"), null);
});

test("PolicyCheckpointStore: snapshots and restores", () => {
  const store = new PolicyCheckpointStore();
  const weights = derivePolicyWeights(emptySkillStatistics(), { id: "v1" });
  store.save(weights, { episodes: 5, runs: 1, contexts: 0, successes: 4, failures: 1, rewardStats: null }, "test");
  store.activate("v1");
  const snap = store.snapshot();
  assert.equal(snap.activeId, "v1");
  assert.equal(snap.checkpoints.length, 1);

  const store2 = new PolicyCheckpointStore();
  store2.restore(snap);
  assert.equal(store2.all.length, 1);
  assert.equal(store2.active?.policyId, "v1");
});

test("PolicyCheckpointStore: marks gate pass", () => {
  const store = new PolicyCheckpointStore();
  const weights = derivePolicyWeights(emptySkillStatistics(), { id: "v1" });
  store.save(weights, { episodes: 5, runs: 1, contexts: 0, successes: 4, failures: 1, rewardStats: null }, "test");
  store.markGatePass("v1", [{ scenarioId: "test", seeds: 20, successRate: 0.9, safeRate: 1.0, meanReward: 1.5 }]);
  const record = store.versions.find((v: { id: string }) => v.id === "v1");
  assert.equal(record?.passedGate, true);
  assert.notEqual(record?.evalResults, null);
});

test("ExperimentStore: creates an experiment", () => {
  const store = new ExperimentStore();
  const exp = store.create("test-experiment", { seeds: 20 }, "baseline-v1", "candidate-v1");
  assert.ok(exp.id);
  assert.equal(exp.status, "running");
  assert.equal(exp.result?.baselinePolicyId, "baseline-v1");
});

test("ExperimentStore: completes an experiment", () => {
  const store = new ExperimentStore();
  const exp = store.create("test", { seeds: 20 }, "baseline-v1", "candidate-v1");
  store.complete(exp.id, {
    baselinePolicyId: "baseline-v1",
    candidatePolicyId: "candidate-v1",
    promoted: true,
    scenarios: [],
    overallBaselineSuccessRate: 0.8,
    overallCandidateSuccessRate: 0.9,
    overallBaselineReward: 1.0,
    overallCandidateReward: 1.5,
  });
  const result = store.get(exp.id);
  assert.equal(result?.status, "completed");
  assert.equal(result?.result?.promoted, true);
});

test("ExperimentStore: fails an experiment", () => {
  const store = new ExperimentStore();
  const exp = store.create("test", { seeds: 20 }, "baseline-v1", "candidate-v1");
  store.fail(exp.id, "connection error");
  const result = store.get(exp.id);
  assert.equal(result?.status, "failed");
});

test("ExperimentStore: tracks recent experiments", () => {
  const store = new ExperimentStore();
  store.create("exp1", {}, "b", "c");
  store.create("exp2", {}, "b", "c");
  store.create("exp3", {}, "b", "c");
  assert.equal(store.recent.length, 3);
});

test("ExperimentStore: returns null for unknown", () => {
  const store = new ExperimentStore();
  assert.equal(store.get("nonexistent"), null);
});
