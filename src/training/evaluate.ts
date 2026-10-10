import { readFile } from "node:fs/promises";
import { ExperienceLearner } from "../core/learning/learner.js";
import { comparePolicyMetrics, DEFAULT_POLICY_GATE_THRESHOLDS, type PolicyGateDecision, type PolicyGateMetricSet, type PolicyGateThresholds } from "../core/learning/policy-gate.js";
import type { PolicyWeights } from "../core/learning/policy-weights.js";
import { runEvaluationOnce, evaluationSeeds, type EvaluationRun, type EvaluationRunOptions } from "../testing/eval/harness.js";
import { evaluationScenarios, type EvaluationScenario } from "../testing/eval/scenarios.js";
import { assertSeedSplit, TRAINING_SEED_BASE } from "./curriculum.js";
import { readTrainingState, trainingPaths, writeJsonAtomic, type TrainingEvaluationSummary, type TrainingPaths } from "./state.js";
import type { EpisodeRunner } from "./trainer.js";

export interface PolicyMeasurement {
  readonly label: string;
  readonly metrics: PolicyGateMetricSet;
  readonly meanWastedActions: number;
  readonly medianSimulatedSeconds: number;
  readonly failureCodes: Readonly<Record<string, number>>;
}

export interface TrainingEvaluationReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly checkpointId: string;
  readonly weightsId: string;
  readonly heldOut: {
    readonly evaluationSeeds: readonly number[];
    readonly trainingSeedBase: number;
    /** Always true when the report is written: the split is asserted before any run. */
    readonly disjointSeeds: true;
    readonly note: string;
  };
  readonly scenarioIds: readonly string[];
  readonly baseline: PolicyMeasurement;
  readonly candidate: PolicyMeasurement;
  readonly decision: PolicyGateDecision;
  readonly deltas: {
    readonly successRate: number;
    readonly medianActions: number;
    readonly meanWastedActions: number;
    readonly unsafeActions: number;
    readonly deaths: number;
  };
  readonly verdict: "promotable" | "not-promotable";
}

export interface EvaluateCheckpointOptions {
  readonly root: string;
  /** Checkpoint to score; defaults to the most recent one. */
  readonly checkpointId?: string;
  /** Number of held-out seeds per scenario. */
  readonly seeds?: number;
  readonly thresholds?: Partial<PolicyGateThresholds>;
  readonly episodeRunner?: EpisodeRunner;
  readonly scenarios?: readonly EvaluationScenario[];
  readonly now?: () => Date;
}

export const DEFAULT_TRAINING_EVAL_SEEDS = 10;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/**
 * Scores one policy on every scenario and seed. A weight set is promoted into a throwaway in-memory learner,
 * exactly as the offline gate does, so measuring never writes the persisted policy.
 */
export async function measurePolicy(
  label: string,
  weights: PolicyWeights | null,
  scenarios: readonly EvaluationScenario[],
  seeds: readonly number[],
  episodeRunner: EpisodeRunner = runEvaluationOnce,
): Promise<PolicyMeasurement> {
  let learner: ExperienceLearner | null = null;
  if (weights) {
    learner = new ExperienceLearner();
    await learner.promote(weights, "training evaluation (not persisted)");
  }
  const runs: EvaluationRun[] = [];
  const perScenario: PolicyGateMetricSet["scenarios"][number][] = [];
  for (const scenario of scenarios) {
    const scenarioRuns: EvaluationRun[] = [];
    for (const seed of seeds) {
      const options: EvaluationRunOptions = learner ? { learner, worldKey: null } : {};
      scenarioRuns.push(await episodeRunner(scenario, seed, options));
    }
    runs.push(...scenarioRuns);
    perScenario.push({
      scenarioId: scenario.id,
      successRate: scenarioRuns.filter((run) => run.success).length / Math.max(1, scenarioRuns.length),
      unsafeActions: scenarioRuns.reduce((sum, run) => sum + run.metrics.unsafeActions, 0),
      deaths: scenarioRuns.filter((run) => run.died).length,
      unverifiedConfirmations: scenarioRuns.reduce((sum, run) => sum + run.metrics.unverifiedConfirmations, 0),
      medianActions: median(scenarioRuns.map((run) => run.metrics.actions)),
    });
  }
  const failureCodes: Record<string, number> = {};
  for (const run of runs) {
    if (run.failureCode) failureCodes[run.failureCode] = (failureCodes[run.failureCode] ?? 0) + 1;
  }
  const count = runs.length;
  const metrics: PolicyGateMetricSet = {
    label,
    runs: count,
    successRate: count === 0 ? 0 : runs.filter((run) => run.success).length / count,
    unsafeActions: runs.reduce((sum, run) => sum + run.metrics.unsafeActions, 0),
    deaths: runs.filter((run) => run.died).length,
    unverifiedConfirmations: runs.reduce((sum, run) => sum + run.metrics.unverifiedConfirmations, 0),
    medianActions: median(runs.map((run) => run.metrics.actions)),
    scenarios: perScenario,
  };
  return {
    label,
    metrics,
    meanWastedActions: count === 0 ? 0 : runs.reduce((sum, run) => sum + run.metrics.wastedActions, 0) / count,
    medianSimulatedSeconds: median(runs.map((run) => run.simulatedMs / 1000)),
    failureCodes,
  };
}

async function loadCheckpoint(paths: TrainingPaths, checkpointId: string | undefined): Promise<{ id: string; weights: PolicyWeights }> {
  const state = await readTrainingState(paths);
  if (!state) throw new Error(`No training state in ${paths.root}; run "train" first.`);
  const record = checkpointId
    ? state.checkpoints.find((entry) => entry.id === checkpointId)
    : state.checkpoints.at(-1);
  if (!record) throw new Error(checkpointId ? `No checkpoint ${checkpointId}.` : "No checkpoint has been written yet.");
  const parsed = JSON.parse(await readFile(record.path, "utf8")) as { weights?: PolicyWeights };
  if (!parsed.weights || typeof parsed.weights.id !== "string" || typeof parsed.weights.entries !== "object") {
    throw new Error(`Checkpoint ${record.id} does not hold a weight table.`);
  }
  return { id: record.id, weights: parsed.weights };
}

/**
 * Scores a checkpoint against the unchanged baseline on held-out evaluation seeds, writes a JSON report and
 * records the verdict in the training state. The verdict is the existing gate's decision; this function does
 * not promote anything.
 */
export async function evaluateCheckpoint(options: EvaluateCheckpointOptions): Promise<TrainingEvaluationReport> {
  const paths = trainingPaths(options.root);
  const now = options.now ?? (() => new Date());
  const state = await readTrainingState(paths);
  if (state && (state.status === "running")) {
    throw new Error("Training is still running. Pause or stop it before evaluating a checkpoint.");
  }
  const checkpoint = await loadCheckpoint(paths, options.checkpointId);
  const seedCount = options.seeds ?? DEFAULT_TRAINING_EVAL_SEEDS;
  const seeds = evaluationSeeds(seedCount);
  assertSeedSplit(seedCount, state?.maxEpisodes ?? 0);
  const scenarios = options.scenarios ?? evaluationScenarios();
  const runner = options.episodeRunner ?? runEvaluationOnce;

  const baseline = await measurePolicy("baseline", null, scenarios, seeds, runner);
  const candidate = await measurePolicy(`checkpoint:${checkpoint.id}`, checkpoint.weights, scenarios, seeds, runner);
  const decision = comparePolicyMetrics(baseline.metrics, candidate.metrics, { ...DEFAULT_POLICY_GATE_THRESHOLDS, ...options.thresholds });
  const verdict = decision.promote ? "promotable" : "not-promotable";
  const generatedAt = now().toISOString();
  const report: TrainingEvaluationReport = {
    schemaVersion: 1,
    generatedAt,
    checkpointId: checkpoint.id,
    weightsId: checkpoint.weights.id,
    heldOut: {
      evaluationSeeds: seeds,
      trainingSeedBase: TRAINING_SEED_BASE,
      disjointSeeds: true,
      note: "Training used seeds from the training base upward; these evaluation seeds never overlap them. Scenario families are shared with the training curriculum, so this measures held-out worlds, not new task types.",
    },
    scenarioIds: scenarios.map((scenario) => scenario.id),
    baseline,
    candidate,
    decision,
    deltas: {
      successRate: round(candidate.metrics.successRate - baseline.metrics.successRate),
      medianActions: round(candidate.metrics.medianActions - baseline.metrics.medianActions),
      meanWastedActions: round(candidate.meanWastedActions - baseline.meanWastedActions),
      unsafeActions: candidate.metrics.unsafeActions - baseline.metrics.unsafeActions,
      deaths: candidate.metrics.deaths - baseline.metrics.deaths,
    },
    verdict,
  };
  const reportPath = `${paths.evaluations}/${checkpoint.id}-${generatedAt.replace(/[:.]/g, "-")}.json`;
  await writeJsonAtomic(reportPath, report);

  if (state) {
    const summary: TrainingEvaluationSummary = {
      checkpointId: checkpoint.id,
      generatedAt,
      reportPath,
      verdict,
      reasons: [...decision.reasons, ...decision.blocking],
      successRate: { baseline: baseline.metrics.successRate, candidate: candidate.metrics.successRate },
    };
    await writeJsonAtomic(paths.state, { ...state, lastEvaluation: summary, updatedAt: generatedAt });
  }
  return report;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
