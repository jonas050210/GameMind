import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../../core/trace.js";
import { ExperienceLearner } from "../../core/learning/learner.js";
import { createMinecraftAgent } from "../../games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../../games/minecraft/decision-model.js";
import { MinecraftTaskRunner, type MinecraftTaskResult } from "../../games/minecraft/task-runner.js";
import { SimulatedMinecraftAdapter } from "../simulated-minecraft/adapter.js";
import type { EvaluationScenario } from "./scenarios.js";

export interface EvaluationRun {
  readonly scenarioId: string;
  readonly seed: number;
  readonly status: MinecraftTaskResult["status"];
  readonly success: boolean;
  /** Safe outcome: no unsafe action, no death, no contradicted confirmation. */
  readonly safe: boolean;
  readonly died: boolean;
  readonly simulatedMs: number;
  readonly metrics: MinecraftTaskResult["metrics"];
  readonly worldStats: { readonly damageTaken: number; readonly minHealth: number; readonly starvationTicks: number };
  readonly actionGoals: readonly string[];
  readonly failureCode: string | null;
}

export interface ScenarioAggregate {
  readonly scenarioId: string;
  readonly family: EvaluationScenario["family"];
  readonly expectation: EvaluationScenario["expectation"];
  readonly seeds: number;
  readonly successRate: number;
  readonly safeRate: number;
  readonly deaths: number;
  readonly unsafeActions: number;
  readonly unverifiedConfirmations: number;
  readonly medianActions: number;
  readonly medianSimulatedSeconds: number;
  readonly meanExplorationLegs: number;
  readonly meanFoodSourcesUsed: number;
  readonly meanRestSeconds: number;
  readonly meanRecoveryAttempts: number;
  readonly meanSuccessfulRecoveries: number;
  readonly meanStuckActions: number;
  readonly meanWastedActions: number;
  readonly meanSafetyDenials: number;
  readonly meanMinedBlocks: number;
  readonly meanCombatActions: number;
  readonly meanPlanRevisions: number;
  readonly meanDamageTaken: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly gates: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
  readonly passed: boolean;
}

export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly model: string;
  readonly seedCount: number;
  readonly scenarios: readonly ScenarioAggregate[];
  /** Repeat-run efficiency measurements; empty when no learning scenarios were requested. */
  readonly learning?: readonly LearningComparison[];
  readonly totals: {
    readonly runs: number;
    readonly successRate: number;
    readonly unsafeActions: number;
    readonly unverifiedConfirmations: number;
    readonly deaths: number;
  };
  readonly passed: boolean;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Optional knobs for one evaluation run. `learner` turns the experience system on: the same seeded
 * world then remembers its own failures, which is what the repeat-run comparison measures.
 */
export interface EvaluationRunOptions {
  readonly learner?: ExperienceLearner | null;
  readonly worldKey?: string | null;
  readonly runId?: string;
  /** Overrides the scenario's own combat opt-in (used by the policy comparison). */
  readonly allowCombat?: boolean;
}

export async function runEvaluationOnce(
  scenario: EvaluationScenario,
  seed: number,
  options: EvaluationRunOptions = {},
): Promise<EvaluationRun> {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(seed) });
  const allowCombat = options.allowCombat ?? scenario.agent?.allowCombat ?? false;
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger, {
    ...(allowCombat ? { optedInCapabilities: ["minecraft.attack_hostile"] } : {}),
  });
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
    ...(options.learner ? { learner: options.learner } : {}),
    ...(options.worldKey ? { worldKey: options.worldKey } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(allowCombat ? { allowCombat: true } : {}),
  });
  const task = scenario.task();
  let result: MinecraftTaskResult;
  try {
    result = await runner.run(task);
  } finally {
    await runtime.shutdown(`evaluation ${scenario.id} seed ${seed} finished`);
  }
  const world = adapter.world;
  const died = world.stats.minHealth <= 0;
  const success = result.status === "succeeded";
  const expectedSafe = result.metrics.unsafeActions === 0 && !died && result.metrics.unverifiedConfirmations === 0;
  return {
    scenarioId: scenario.id,
    seed,
    status: result.status,
    success,
    safe: expectedSafe,
    died,
    simulatedMs: adapter.simulatedNowMs,
    metrics: result.metrics,
    worldStats: {
      damageTaken: world.stats.damageTaken,
      minHealth: world.stats.minHealth,
      starvationTicks: world.stats.starvationTicks,
    },
    actionGoals: result.actions.map((action) => action.goalId),
    failureCode: result.failure?.code ?? null,
  };
}

export function aggregateScenario(
  scenario: EvaluationScenario,
  runs: readonly EvaluationRun[],
): ScenarioAggregate {
  const seeds = runs.length;
  const successes = runs.filter((run) => run.success).length;
  const safe = runs.filter((run) => run.safe).length;
  const deaths = runs.filter((run) => run.died).length;
  const unsafeActions = runs.reduce((sum, run) => sum + run.metrics.unsafeActions, 0);
  const unverifiedConfirmations = runs.reduce((sum, run) => sum + run.metrics.unverifiedConfirmations, 0);
  const successRate = seeds === 0 ? 0 : successes / seeds;
  const statusCounts: Record<string, number> = {};
  for (const run of runs) statusCounts[run.status] = (statusCounts[run.status] ?? 0) + 1;

  const gates: ScenarioAggregate["gates"][number][] = [];
  if (scenario.expectation === "success") {
    gates.push({
      name: "success-rate",
      passed: successRate >= scenario.minSuccessRate,
      detail: `${successes}/${seeds} seeds succeeded (threshold ${scenario.minSuccessRate}).`,
    });
  }
  gates.push({
    name: "no-unsafe-actions",
    passed: unsafeActions === 0,
    detail: `${unsafeActions} action(s) started while a hostile was within the danger radius.`,
  });
  gates.push({
    name: "no-deaths",
    passed: deaths === 0,
    detail: `${deaths} seed(s) reached zero health.`,
  });
  gates.push({
    name: "no-contradicted-confirmations",
    passed: unverifiedConfirmations === 0,
    detail: `${unverifiedConfirmations} adapter confirmation(s) were not supported by the next observation.`,
  });
  if (scenario.expectation === "safe") {
    gates.push({
      name: "safe-outcome",
      passed: safe === seeds,
      detail: `${safe}/${seeds} seeds ended safely.`,
    });
  }
  const matches = (goal: string, prefixes: readonly string[]): boolean =>
    prefixes.some((prefix) => goal === prefix || goal.startsWith(prefix));
  if (scenario.requiredGoals && scenario.requiredGoals.length > 0) {
    const satisfied = runs.filter((run) => matches(run.actionGoals.join(","), scenario.requiredGoals ?? [])).length;
    gates.push({
      name: "required-goal",
      passed: satisfied === seeds,
      detail: `${satisfied}/${seeds} seed(s) executed one of ${scenario.requiredGoals.join(", ")}; goals are read from executed actions, not from the plan.`,
    });
  }
  if (scenario.forbiddenGoals && scenario.forbiddenGoals.length > 0) {
    const violations = runs.filter((run) => matches(run.actionGoals.join(","), scenario.forbiddenGoals ?? [])).length;
    gates.push({
      name: "forbidden-goal",
      passed: violations === 0,
      detail: `${violations}/${seeds} seed(s) executed a forbidden goal (${scenario.forbiddenGoals.join(", ")}).`,
    });
  }

  return {
    scenarioId: scenario.id,
    family: scenario.family,
    expectation: scenario.expectation,
    seeds,
    successRate: round(successRate),
    safeRate: round(seeds === 0 ? 0 : safe / seeds),
    deaths,
    unsafeActions,
    unverifiedConfirmations,
    medianActions: median(runs.map((run) => run.metrics.actions)),
    medianSimulatedSeconds: round(median(runs.map((run) => run.simulatedMs / 1000)), 1),
    meanExplorationLegs: round(mean(runs.map((run) => run.metrics.explorationLegs))),
    meanFoodSourcesUsed: round(mean(runs.map((run) => run.metrics.foodSourcesUsed))),
    meanRestSeconds: round(mean(runs.map((run) => run.metrics.restMs / 1000)), 1),
    meanRecoveryAttempts: round(mean(runs.map((run) => run.metrics.recoveryAttempts))),
    meanSuccessfulRecoveries: round(mean(runs.map((run) => run.metrics.successfulRecoveries))),
    meanStuckActions: round(mean(runs.map((run) => run.metrics.stuckActions))),
    meanWastedActions: round(mean(runs.map((run) => run.metrics.wastedActions))),
    meanSafetyDenials: round(mean(runs.map((run) => run.metrics.safetyDenials))),
    meanMinedBlocks: round(mean(runs.map((run) => run.metrics.minedBlocks))),
    meanCombatActions: round(mean(runs.map((run) => run.metrics.combatActions))),
    meanPlanRevisions: round(mean(runs.map((run) => run.metrics.planRevisions))),
    meanDamageTaken: round(mean(runs.map((run) => run.worldStats.damageTaken))),
    statusCounts,
    gates,
    passed: gates.every((gate) => gate.passed),
  };
}

/** One repetition inside a repeat-run comparison; `repetition` 0 is the cold run. */
export interface LearningRepetition {
  readonly repetition: number;
  readonly seed: number;
  readonly actions: number;
  readonly wastedActions: number;
  readonly success: boolean;
  readonly status: MinecraftTaskResult["status"];
}

export interface LearningComparison {
  readonly scenarioId: string;
  readonly seeds: readonly number[];
  readonly repetitions: number;
  readonly cold: { readonly actions: number; readonly wastedActions: number; readonly successRate: number };
  readonly repeated: { readonly actions: number; readonly wastedActions: number; readonly successRate: number };
  /** Fraction of wasted actions removed by the remembered failures; 0 means the learner changed nothing. */
  readonly wastedActionReduction: number;
  readonly successRateDelta: number;
  readonly gates: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
  readonly passed: boolean;
  readonly repetitionsDetail: readonly LearningRepetition[];
}

/**
 * Runs the same seeded worlds back to back with one shared in-memory learner. The question it answers is
 * narrow and falsifiable: after a world's failures have been experienced once, does the agent spend
 * fewer actions on them **without** giving up success? Everything else stays identical, so any change is
 * attributable to the experience memory alone.
 */
export async function runLearningComparison(
  scenario: EvaluationScenario,
  seeds: readonly number[],
  repetitions = 2,
): Promise<LearningComparison> {
  const detail: LearningRepetition[] = [];
  for (const seed of seeds) {
    // One learner per world, so cross-world contamination cannot make the numbers look better.
    const learner = new ExperienceLearner();
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const run = await runEvaluationOnce(scenario, seed, {
        learner,
        worldKey: `${scenario.id}#${seed}`,
        runId: `${scenario.id}#${seed}#${repetition}`,
      });
      detail.push({
        repetition,
        seed,
        actions: run.metrics.actions,
        wastedActions: run.metrics.wastedActions,
        success: run.success,
        status: run.status,
      });
    }
  }
  const meanOf = (filter: (entry: LearningRepetition) => boolean, pick: (entry: LearningRepetition) => number): number => {
    const picked = detail.filter(filter);
    return picked.length === 0 ? 0 : picked.reduce((sum, entry) => sum + pick(entry), 0) / picked.length;
  };
  const coldActions = meanOf((entry) => entry.repetition === 0, (entry) => entry.actions);
  const repeatedActions = meanOf((entry) => entry.repetition === repetitions - 1, (entry) => entry.actions);
  const coldWasted = meanOf((entry) => entry.repetition === 0, (entry) => entry.wastedActions);
  const repeatedWasted = meanOf((entry) => entry.repetition === repetitions - 1, (entry) => entry.wastedActions);
  const coldSuccess = meanOf((entry) => entry.repetition === 0, (entry) => (entry.success ? 1 : 0));
  const repeatedSuccess = meanOf((entry) => entry.repetition === repetitions - 1, (entry) => (entry.success ? 1 : 0));
  const reduction = coldWasted === 0 ? 0 : round((coldWasted - repeatedWasted) / coldWasted);
  const successDelta = round(repeatedSuccess - coldSuccess);
  const gates = [
    {
      name: "no-success-regression",
      passed: successDelta >= 0,
      detail: `success rate ${(coldSuccess * 100).toFixed(0)}% → ${(repeatedSuccess * 100).toFixed(0)}% after repeats`,
    },
    {
      name: "repeated-failures-shrink",
      passed: repeatedWasted <= coldWasted,
      detail: `${coldWasted.toFixed(2)} → ${repeatedWasted.toFixed(2)} wasted actions per run (median actions ${coldActions.toFixed(2)} → ${repeatedActions.toFixed(2)})`,
    },
  ];
  return {
    scenarioId: scenario.id,
    seeds,
    repetitions,
    cold: { actions: round(coldActions, 2), wastedActions: round(coldWasted, 2), successRate: round(coldSuccess) },
    repeated: {
      actions: round(repeatedActions, 2),
      wastedActions: round(repeatedWasted, 2),
      successRate: round(repeatedSuccess),
    },
    wastedActionReduction: reduction,
    successRateDelta: successDelta,
    gates,
    passed: gates.every((gate) => gate.passed),
    repetitionsDetail: detail,
  };
}

export async function runEvaluationSuite(
  scenarios: readonly EvaluationScenario[],
  seeds: readonly number[],
  onProgress?: (scenarioId: string, completed: number, total: number) => void,
  options: { readonly learningScenarioIds?: readonly string[]; readonly learningRepetitions?: number } = {},
): Promise<EvaluationReport> {
  const aggregates: ScenarioAggregate[] = [];
  const allRuns: EvaluationRun[] = [];
  for (const scenario of scenarios) {
    const runs: EvaluationRun[] = [];
    for (const seed of seeds) {
      runs.push(await runEvaluationOnce(scenario, seed));
      onProgress?.(scenario.id, runs.length, seeds.length);
    }
    allRuns.push(...runs);
    aggregates.push(aggregateScenario(scenario, runs));
  }
  const learningIds = options.learningScenarioIds ?? [];
  const learning: LearningComparison[] = [];
  for (const id of learningIds) {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    if (!scenario) continue;
    learning.push(await runLearningComparison(scenario, seeds.slice(0, 6), options.learningRepetitions ?? 2));
  }
  const successes = allRuns.filter((run) => run.success).length;
  const totals = {
    runs: allRuns.length,
    successRate: round(allRuns.length === 0 ? 0 : successes / allRuns.length),
    unsafeActions: allRuns.reduce((sum, run) => sum + run.metrics.unsafeActions, 0),
    unverifiedConfirmations: allRuns.reduce((sum, run) => sum + run.metrics.unverifiedConfirmations, 0),
    deaths: allRuns.filter((run) => run.died).length,
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: new MinecraftTaskDecisionModel().modelId,
    seedCount: seeds.length,
    scenarios: aggregates,
    totals,
    learning,
    passed:
      aggregates.every((aggregate) => aggregate.passed) && learning.every((comparison) => comparison.passed),
  };
}

/** Deterministic evaluation seeds: stable across runs so that results are comparable. */
export function evaluationSeeds(count: number): number[] {
  return Array.from({ length: count }, (_, index) => 101 + index * 37);
}
