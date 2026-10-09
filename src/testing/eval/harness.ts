import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../../core/trace.js";
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

export async function runEvaluationOnce(scenario: EvaluationScenario, seed: number): Promise<EvaluationRun> {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(seed) });
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
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
    meanPlanRevisions: round(mean(runs.map((run) => run.metrics.planRevisions))),
    meanDamageTaken: round(mean(runs.map((run) => run.worldStats.damageTaken))),
    statusCounts,
    gates,
    passed: gates.every((gate) => gate.passed),
  };
}

export async function runEvaluationSuite(
  scenarios: readonly EvaluationScenario[],
  seeds: readonly number[],
  onProgress?: (scenarioId: string, completed: number, total: number) => void,
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
    passed: aggregates.every((aggregate) => aggregate.passed),
  };
}

/** Deterministic evaluation seeds: stable across runs so that results are comparable. */
export function evaluationSeeds(count: number): number[] {
  return Array.from({ length: count }, (_, index) => 101 + index * 37);
}
