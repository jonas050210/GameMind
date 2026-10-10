import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ExperienceLearner } from "../core/learning/learner.js";
import { comparePolicyMetrics, DEFAULT_POLICY_GATE_THRESHOLDS, type PolicyGateDecision, type PolicyGateMetricSet, type PolicyGateThresholds } from "../core/learning/policy-gate.js";
import type { PolicyWeights } from "../core/learning/policy-weights.js";
import { runEvaluationOnce, evaluationSeeds, type EvaluationRun, type EvaluationRunOptions } from "../testing/eval/harness.js";
import { evaluationScenarios, type EvaluationScenario } from "../testing/eval/scenarios.js";
import { MinecraftTaskDecisionModel } from "../games/minecraft/decision-model.js";
import { DEFAULT_POLICY_WEIGHT_CONFIG } from "../core/learning/policy-weights.js";
import { acquireTrainingLock, type LockEnvironment } from "./lock.js";
import { assertSeedSplit, TRAINING_SEED_BASE } from "./curriculum.js";
import { canonicalDigest, readTrainingState, trainingPaths, writeJsonAtomic, type TrainingEvaluationSummary, type TrainingPaths } from "./state.js";
import type { EpisodeRunner } from "./trainer.js";

/** One scenario/seed run reduced to what a paired comparison needs. `choices` is a hash of the goals it executed. */
export interface PairedRunRecord {
  readonly scenarioId: string;
  readonly seed: number;
  readonly success: boolean;
  readonly actions: number;
  readonly wastedActions: number;
  readonly choices: string;
}

export interface PolicyMeasurement {
  readonly label: string;
  readonly metrics: PolicyGateMetricSet;
  readonly meanWastedActions: number;
  readonly medianSimulatedSeconds: number;
  readonly failureCodes: Readonly<Record<string, number>>;
  /** Per-run records, in scenario-then-seed order, so a candidate can be compared with the baseline run by run. */
  readonly runs?: readonly PairedRunRecord[];
}

/**
 * What a candidate-versus-baseline comparison actually established. It exists because "no change" has several very
 * different meanings, and reporting them all as "0 deltas, not promotable" hid which one was true.
 */
export type EvaluationConclusion =
  /** The checkpoint holds no learned weights, so it *is* the baseline; the comparison measures nothing. */
  | "no-learned-contexts"
  /** Weights exist but never changed a single decision in any paired run; outcomes cannot differ. */
  | "identical-behaviour"
  /** Choices changed and the gate found a measured improvement without a safety regression. */
  | "improved"
  /** Choices changed and success or safety got worse. */
  | "regressed"
  /** Choices changed, but the outcome is not measurably better. */
  | "behaviour-changed-no-gain";

export interface WilsonInterval {
  readonly low: number;
  readonly high: number;
}

export interface TrainingEvaluationReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly checkpointId: string;
  /** "verified" when the checkpoint's digest matched; "unverified-legacy" for checkpoints written before digests. */
  readonly checkpointIntegrity?: "verified" | "unverified-legacy";
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
  /** What the comparison established; absent in reports written before it existed. */
  readonly conclusion?: EvaluationConclusion;
  /** Identity of the held-out set (scenarios, seeds, decision model): two reports are comparable only when it matches. */
  readonly evaluationSet?: { readonly id: string; readonly scenarios: number; readonly seedsPerScenario: number; readonly runs: number; readonly decisionModel: string };
  /** What the candidate holds. Weights only exist for contexts with at least `minSamples` verified attempts. */
  readonly candidateContent?: { readonly learnedContexts: number; readonly minSamples: number };
  /** How often the candidate chose differently from the baseline on the same world. */
  readonly behaviour?: { readonly pairedRuns: number; readonly runsWithDifferentChoices: number; readonly scenariosWithDifferentChoices: number };
  /** Paired outcomes on identical worlds: where the candidate and the baseline differ in success. */
  readonly paired?: { readonly candidateBetter: number; readonly baselineBetter: number; readonly tied: number };
  readonly confidence?: { readonly method: "wilson-95"; readonly baseline: WilsonInterval; readonly candidate: WilsonInterval };
  /** Whether the baseline measured now equals the one first recorded for this evaluation set. */
  readonly baselineStability?: { readonly evaluationSetId: string; readonly stable: boolean; readonly firstRecordedAt: string; readonly note: string };
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
  /** Set false only for callers that already hold the directory lock. */
  readonly lock?: boolean;
  readonly lockEnvironment?: LockEnvironment;
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
  const records: PairedRunRecord[] = [];
  const perScenario: PolicyGateMetricSet["scenarios"][number][] = [];
  for (const scenario of scenarios) {
    const scenarioRuns: EvaluationRun[] = [];
    for (const seed of seeds) {
      const options: EvaluationRunOptions = learner ? { learner, worldKey: null } : {};
      scenarioRuns.push(await episodeRunner(scenario, seed, options));
    }
    runs.push(...scenarioRuns);
    for (const run of scenarioRuns) {
      records.push({
        scenarioId: scenario.id,
        seed: run.seed,
        success: run.success,
        actions: run.metrics.actions,
        wastedActions: run.metrics.wastedActions,
        choices: createHash("sha1").update(run.actionChoices.join("|")).digest("hex").slice(0, 12),
      });
    }
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
    runs: records,
  };
}

/** 95% Wilson score interval for a proportion; honest about how little a small sample says. */
export function wilsonInterval(successes: number, total: number, z = 1.96): WilsonInterval {
  if (total <= 0) return { low: 0, high: 1 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: round(Math.max(0, centre - margin)), high: round(Math.min(1, centre + margin)) };
}

function evaluationSetId(scenarios: readonly EvaluationScenario[], seeds: readonly number[], decisionModel: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ scenarios: scenarios.map((scenario) => scenario.id), seeds, decisionModel }))
    .digest("hex")
    .slice(0, 12);
}

/** Compares the candidate with the baseline run by run on identical worlds. Exported for tests. */
export function analyseComparison(
  baseline: PolicyMeasurement,
  candidate: PolicyMeasurement,
  learnedContexts: number,
  decision: PolicyGateDecision,
  deltas: TrainingEvaluationReport["deltas"],
): { readonly behaviour: NonNullable<TrainingEvaluationReport["behaviour"]>; readonly paired: NonNullable<TrainingEvaluationReport["paired"]>; readonly conclusion: EvaluationConclusion; readonly explanation: string } {
  const baselineRuns = baseline.runs ?? [];
  const candidateRuns = candidate.runs ?? [];
  let different = 0;
  let better = 0;
  let worse = 0;
  let tied = 0;
  const changedScenarios = new Set<string>();
  const count = Math.min(baselineRuns.length, candidateRuns.length);
  for (let index = 0; index < count; index += 1) {
    const base = baselineRuns[index]!;
    const cand = candidateRuns[index]!;
    if (base.choices !== cand.choices) {
      different += 1;
      changedScenarios.add(base.scenarioId);
    }
    if (cand.success && !base.success) better += 1;
    else if (!cand.success && base.success) worse += 1;
    else tied += 1;
  }
  const behaviour = { pairedRuns: count, runsWithDifferentChoices: different, scenariosWithDifferentChoices: changedScenarios.size };
  const paired = { candidateBetter: better, baselineBetter: worse, tied };
  let conclusion: EvaluationConclusion;
  let explanation: string;
  if (learnedContexts === 0) {
    conclusion = "no-learned-contexts";
    explanation = `This checkpoint holds no learned weights (a context needs ${DEFAULT_POLICY_WEIGHT_CONFIG.minSamples} verified attempts before it is weighted), so it is the baseline policy. The comparison measured nothing and cannot show learning. Train for more episodes.`;
  } else if (count > 0 && different === 0) {
    conclusion = "identical-behaviour";
    explanation = `The ${learnedContexts} learned context(s) never changed a decision: the candidate chose exactly what the baseline chose in all ${count} paired runs, so identical results are expected and do not mean the weights were tested and found equal. Learning can only matter where a decision has competing candidates.`;
  } else if (decision.promote) {
    conclusion = "improved";
    explanation = `The candidate chose differently in ${different} of ${count} paired runs and the gate measured an improvement without a safety regression.`;
  } else if (deltas.successRate < 0 || deltas.unsafeActions > 0 || deltas.deaths > 0) {
    conclusion = "regressed";
    explanation = `The candidate chose differently in ${different} of ${count} paired runs and did worse (success ${deltas.successRate >= 0 ? "+" : ""}${(deltas.successRate * 100).toFixed(1)} points, unsafe actions ${deltas.unsafeActions >= 0 ? "+" : ""}${deltas.unsafeActions}, deaths ${deltas.deaths >= 0 ? "+" : ""}${deltas.deaths}).`;
  } else {
    conclusion = "behaviour-changed-no-gain";
    explanation = `The candidate chose differently in ${different} of ${count} paired runs, but the change did not measurably improve the outcome (${better} better, ${worse} worse, ${tied} tied).`;
  }
  return { behaviour, paired, conclusion, explanation };
}

export async function loadCheckpoint(
  paths: TrainingPaths,
  checkpointId: string | undefined,
): Promise<{ id: string; weights: PolicyWeights; integrity: "verified" | "unverified-legacy" }> {
  const state = await readTrainingState(paths);
  if (!state) throw new Error(`No training state in ${paths.root}; run "train" first.`);
  const record = checkpointId
    ? state.checkpoints.find((entry) => entry.id === checkpointId)
    : state.checkpoints.at(-1);
  if (!record) throw new Error(checkpointId ? `No checkpoint ${checkpointId}.` : "No checkpoint has been written yet.");
  const parsed = JSON.parse(await readFile(record.path, "utf8")) as {
    weights?: PolicyWeights;
    digest?: string;
    [key: string]: unknown;
  };
  if (!parsed.weights || typeof parsed.weights.id !== "string" || typeof parsed.weights.entries !== "object") {
    throw new Error(`Checkpoint ${record.id} does not hold a weight table.`);
  }
  // Checkpoints written before digests existed load as "unverified"; a digest that does not match is refused.
  const { digest, ...body } = parsed;
  if (typeof digest === "string" && canonicalDigest(body) !== digest) {
    throw new Error(
      `Checkpoint ${record.id} failed its integrity check: its contents no longer match the digest written with it. Refusing to evaluate an edited checkpoint.`,
    );
  }
  return { id: record.id, weights: parsed.weights, integrity: typeof digest === "string" ? "verified" : "unverified-legacy" };
}

/**
 * Scores a checkpoint against the unchanged baseline on held-out evaluation seeds, writes a JSON report and
 * records the verdict in the training state. The verdict is the existing gate's decision; this function does
 * not promote anything.
 */
export async function evaluateCheckpoint(options: EvaluateCheckpointOptions): Promise<TrainingEvaluationReport> {
  const lock = options.lock === false ? null : acquireTrainingLock(options.root, "evaluate", options.lockEnvironment);
  try {
    return await evaluateCheckpointLocked(options);
  } finally {
    lock?.release();
  }
}

async function evaluateCheckpointLocked(options: EvaluateCheckpointOptions): Promise<TrainingEvaluationReport> {
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
  const deltas = {
    successRate: round(candidate.metrics.successRate - baseline.metrics.successRate),
    medianActions: round(candidate.metrics.medianActions - baseline.metrics.medianActions),
    meanWastedActions: round(candidate.meanWastedActions - baseline.meanWastedActions),
    unsafeActions: candidate.metrics.unsafeActions - baseline.metrics.unsafeActions,
    deaths: candidate.metrics.deaths - baseline.metrics.deaths,
  };
  const learnedContexts = Object.keys(checkpoint.weights.entries).length;
  const analysis = analyseComparison(baseline, candidate, learnedContexts, decision, deltas);
  const decisionModel = new MinecraftTaskDecisionModel().modelId;
  const setId = evaluationSetId(scenarios, seeds, decisionModel);
  const baselineStability = await recordBaseline(paths, setId, baseline, generatedAt);
  const report: TrainingEvaluationReport = {
    schemaVersion: 1,
    generatedAt,
    checkpointId: checkpoint.id,
    checkpointIntegrity: checkpoint.integrity,
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
    deltas,
    verdict,
    conclusion: analysis.conclusion,
    evaluationSet: { id: setId, scenarios: scenarios.length, seedsPerScenario: seeds.length, runs: baseline.metrics.runs, decisionModel },
    candidateContent: { learnedContexts, minSamples: DEFAULT_POLICY_WEIGHT_CONFIG.minSamples },
    behaviour: analysis.behaviour,
    paired: analysis.paired,
    confidence: {
      method: "wilson-95",
      baseline: wilsonInterval(Math.round(baseline.metrics.successRate * baseline.metrics.runs), baseline.metrics.runs),
      candidate: wilsonInterval(Math.round(candidate.metrics.successRate * candidate.metrics.runs), candidate.metrics.runs),
    },
    baselineStability,
  };
  const reportPath = `${paths.evaluations}/${checkpoint.id}-${generatedAt.replace(/[:.]/g, "-")}.json`;
  await writeJsonAtomic(reportPath, report);

  if (state) {
    const summary: TrainingEvaluationSummary = {
      checkpointId: checkpoint.id,
      generatedAt,
      reportPath,
      verdict,
      reasons: [analysis.explanation, ...decision.reasons, ...decision.blocking],
      successRate: { baseline: baseline.metrics.successRate, candidate: candidate.metrics.successRate },
      conclusion: analysis.conclusion,
      learnedContexts,
      behaviourChangedRuns: analysis.behaviour.runsWithDifferentChoices,
      pairedRuns: analysis.behaviour.pairedRuns,
    };
    await writeJsonAtomic(paths.state, { ...state, lastEvaluation: summary, updatedAt: generatedAt });
  }
  return report;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The first baseline measured for an evaluation set is kept next to the reports. A later measurement of the same set
 * must reproduce it exactly (the simulator and the decision model are deterministic); when it does not, the code or
 * the scenarios changed underneath the comparison and the report says so instead of silently moving the goalposts.
 */
async function recordBaseline(
  paths: TrainingPaths,
  setId: string,
  baseline: PolicyMeasurement,
  generatedAt: string,
): Promise<NonNullable<TrainingEvaluationReport["baselineStability"]>> {
  const file = `${paths.evaluations}/baseline-${setId}.baseline.json`;
  const digest = canonicalDigest(baseline.runs ?? []);
  interface RecordedBaseline {
    readonly digest?: string;
    readonly recordedAt?: string;
    readonly successRate?: number;
  }
  let previous: RecordedBaseline | null = null;
  try {
    previous = JSON.parse(await readFile(file, "utf8")) as RecordedBaseline;
  } catch {
    previous = null;
  }
  if (!previous || typeof previous.digest !== "string") {
    await writeJsonAtomic(file, { schemaVersion: 1, evaluationSetId: setId, recordedAt: generatedAt, digest, successRate: baseline.metrics.successRate, runs: baseline.metrics.runs });
    return { evaluationSetId: setId, stable: true, firstRecordedAt: generatedAt, note: "First baseline recorded for this evaluation set; later evaluations must reproduce it." };
  }
  const stable = previous.digest === digest;
  return {
    evaluationSetId: setId,
    stable,
    firstRecordedAt: previous.recordedAt ?? generatedAt,
    note: stable
      ? "The baseline reproduced the one first recorded for this evaluation set, run for run."
      : "The baseline no longer matches the one first recorded for this evaluation set: the agent code or the scenarios changed since then, so results before and after this point are not directly comparable.",
  };
}
