import assert from "node:assert/strict";
import test from "node:test";
import {
  baselinePolicyMetricsFromReport,
  comparePolicyAgainstBaseline,
  evaluatePolicyMetricSet,
} from "../src/testing/eval/policy-comparison.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { runEvaluationSuite } from "../src/testing/eval/harness.js";
import { BASELINE_POLICY_WEIGHTS, derivePolicyWeights } from "../src/core/learning/policy-weights.js";
import { contextKeyFor } from "../src/core/learning/skill-statistics.js";
import { episodeFeaturesSchema } from "../src/core/learning/episode.js";

/** Two seeds on one fast scenario: enough to exercise the real loop without slowing the suite. */
const scenarioIds = ["explore-remote-log", "recovery-persistent-stall"];
const seeds = [101, 138];

function scenarios() {
  return evaluationScenarios().filter((scenario) => scenarioIds.includes(scenario.id));
}

test("the policy comparison measures a weight set by running the real decision loop", async () => {
  const baseline = await evaluatePolicyMetricSet({ scenarios: scenarios(), seeds, label: "baseline" });
  assert.equal(baseline.label, "baseline");
  assert.equal(baseline.runs, scenarioIds.length * seeds.length);
  assert.ok(baseline.successRate >= 0 && baseline.successRate <= 1);
  assert.equal(baseline.scenarios.length, scenarioIds.length);
  assert.equal(baseline.unsafeActions, 0);
  assert.equal(baseline.deaths, 0);
  assert.equal(baseline.unverifiedConfirmations, 0);
  for (const scenario of baseline.scenarios) {
    assert.ok(scenario.medianActions > 0 || scenario.successRate === 0, `${scenario.scenarioId} has no actions`);
  }
});

test("a candidate gate can reuse the exact baseline aggregates from the main evaluation report", async () => {
  const report = await runEvaluationSuite(scenarios(), seeds, undefined, { learningScenarioIds: [] });
  const baseline = baselinePolicyMetricsFromReport(report);
  assert.equal(baseline.runs, report.totals.runs);
  assert.equal(baseline.successRate, report.totals.successRate);
  assert.equal(baseline.medianActions, report.totals.medianActions);
  assert.deepEqual(
    baseline.scenarios.map((scenario) => scenario.scenarioId),
    report.scenarios.map((scenario) => scenario.scenarioId),
  );
  assert.equal(baseline.unsafeActions, 0);
  assert.equal(baseline.deaths, 0);
  assert.equal(baseline.unverifiedConfirmations, 0);
});

test("a candidate that re-scales every context alike is not an improvement", async () => {
    // Uniform weights cannot change a ranking, so the gate has to refuse them: a policy that provably
    // changes nothing must never be promoted on the strength of noise.
    const features = episodeFeaturesSchema.parse({
      goalClass: "gather",
      skillId: "minecraft.collect-log",
      band: 2,
      distance: 4,
      distanceBand: "near",
      health: 20,
      hunger: 20,
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKind: "oak_log",
      actionIndex: 0,
      attemptsOnTarget: 0,
    });
    const key = contextKeyFor(features);
    const candidate = {
      ...BASELINE_POLICY_WEIGHTS,
      id: "uniform-scaling-v1",
      source: "experience" as const,
      entries: { [key]: { weight: 0.75, samples: 40, evidence: 0.4, successRate: 0.4 } },
    };
    const comparison = await comparePolicyAgainstBaseline(scenarios(), seeds, candidate);
    assert.equal(comparison.baseline.medianActions, comparison.candidate.medianActions);
    assert.equal(comparison.decision.promote, false);
    assert.equal(derivePolicyWeights({}, { episodes: 0, runs: 0 }).entries[key], undefined);
    assert.ok(
      comparison.decision.reasons.join(" ").length > 0,
      "the gate must explain what it compared",
    );
  });
