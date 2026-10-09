import { ExperienceLearner } from "../../core/learning/learner.js";
import type { PolicyWeights } from "../../core/learning/policy-weights.js";
import {
  comparePolicyMetrics,
  type PolicyGateDecision,
  type PolicyGateMetricSet,
  type PolicyGateScenarioMetric,
  type PolicyGateThresholds,
} from "../../core/learning/policy-gate.js";
import { runEvaluationOnce } from "./harness.js";
import type { EvaluationScenario } from "./scenarios.js";

/**
 * Bridge between the learner's promotion rule and the evaluation harness. The gate in `core/learning`
 * only compares numbers, so nothing in the core has to know about Minecraft scenarios; this module is
 * what turns a candidate weight set into those numbers by running the real decision loop.
 */

export interface PolicyMetricOptions {
  readonly scenarios: readonly EvaluationScenario[];
  readonly seeds: readonly number[];
  /** Label used in the decision text, e.g. "baseline" or "candidate-v3". */
  readonly label?: string;
  /**
   * Weights to evaluate. They are promoted into a **throwaway in-memory learner**, so measuring a
   * candidate never touches the persisted policy state.
   */
  readonly weights?: PolicyWeights | null;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/** Runs the scenario set once per seed with the given weights active and folds the result for the gate. */
export async function evaluatePolicyMetricSet(options: PolicyMetricOptions): Promise<PolicyGateMetricSet> {
  const { scenarios, seeds } = options;
  let learner: ExperienceLearner | null = null;
  if (options.weights) {
    learner = new ExperienceLearner();
    await learner.promote(options.weights, "policy comparison (not persisted)");
  }
  const perScenario: PolicyGateScenarioMetric[] = [];
  let runs = 0;
  let successes = 0;
  let unsafeActions = 0;
  let deaths = 0;
  let unverifiedConfirmations = 0;
  const actionCounts: number[] = [];

  for (const scenario of scenarios) {
    let scenarioSuccesses = 0;
    let scenarioUnsafe = 0;
    let scenarioDeaths = 0;
    let scenarioUnverified = 0;
    const scenarioActions: number[] = [];
    for (const seed of seeds) {
      const run = await runEvaluationOnce(scenario, seed, {
        ...(learner ? { learner, worldKey: null } : {}),
      });
      runs += 1;
      if (run.success) successes += 1;
      if (run.success) scenarioSuccesses += 1;
      if (run.died) deaths += 1;
      unsafeActions += run.metrics.unsafeActions;
      unverifiedConfirmations += run.metrics.unverifiedConfirmations;
      scenarioUnsafe += run.metrics.unsafeActions;
      scenarioDeaths += run.died ? 1 : 0;
      scenarioUnverified += run.metrics.unverifiedConfirmations;
      actionCounts.push(run.metrics.actions);
      scenarioActions.push(run.metrics.actions);
    }
    perScenario.push({
      scenarioId: scenario.id,
      successRate: seeds.length === 0 ? 0 : scenarioSuccesses / seeds.length,
      unsafeActions: scenarioUnsafe,
      deaths: scenarioDeaths,
      unverifiedConfirmations: scenarioUnverified,
      medianActions: median(scenarioActions),
    });
  }

  return {
    label: options.label ?? (options.weights ? `weights:${options.weights.id}` : "baseline"),
    runs,
    successRate: runs === 0 ? 0 : successes / runs,
    unsafeActions,
    deaths,
    unverifiedConfirmations,
    medianActions: median(actionCounts),
    scenarios: perScenario,
  };
}

export interface PolicyComparisonResult {
  readonly baseline: PolicyGateMetricSet;
  readonly candidate: PolicyGateMetricSet;
  readonly decision: PolicyGateDecision;
}

/**
 * Measures a candidate weight set against the baseline on the same seeds. Promotion is the caller's
 * decision; this only answers "does this change make the agent better without making it less safe?".
 */
export async function comparePolicyAgainstBaseline(
  scenarios: readonly EvaluationScenario[],
  seeds: readonly number[],
  candidateWeights: PolicyWeights,
  thresholds: Partial<PolicyGateThresholds> = {},
): Promise<PolicyComparisonResult> {
  const baseline = await evaluatePolicyMetricSet({ scenarios, seeds, label: "baseline" });
  const candidate = await evaluatePolicyMetricSet({
    scenarios,
    seeds,
    label: `candidate:${candidateWeights.id}`,
    weights: candidateWeights,
  });
  return {
    baseline,
    candidate,
    decision: comparePolicyMetrics(baseline, candidate, thresholds),
  };
}
