/**
 * Headless training benchmark, offline simulator only. Several exploration settings are trained under the same
 * budget, each as one reproducible experiment, and then compared on the same held-out seeds against the untrained
 * baseline. A candidate can become the default only when the existing gate says it is promotable AND it beats the
 * baseline by at least the configured margin. Otherwise the benchmark names no winner and the baseline stays.
 *
 * The benchmark never overwrites an earlier benchmark or experiment name.
 */
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { DEFAULT_TRAINING_EXPLORATION_RATE, TRAINING_SEED_BASE, TRAINING_STAGES, type CurriculumStage } from "./curriculum.js";
import { readTrainingDefaults, saveTrainingDefaults, type TrainingDefaults } from "./defaults.js";
import { runHeadlessExperiment, type HeadlessExperimentReport } from "./experiment.js";
import { chooseWorkerCount, probeWorkerCounts, type ProbeResult } from "./throughput-probe.js";
import { runTraining, type TrainingEpisodeEvent } from "./trainer.js";

export interface BenchmarkCandidate {
  /** Short identifier, used in the experiment directory name. Letters, digits, '.', '_' and '-'. */
  readonly id: string;
  /** Exploration rate between 0 and 1; 0 is the greedy control. */
  readonly explorationRate: number;
}

export interface BenchmarkOptions {
  readonly name: string;
  readonly outDir?: string;
  readonly candidates: readonly BenchmarkCandidate[];
  readonly episodesPerStage: number;
  readonly maxEpisodes: number;
  readonly evaluationSeeds: number;
  /** Minimum held-out success gain over the baseline, in fraction points (0.02 = two points). */
  readonly margin: number;
  /** Curriculum stages eligible for environment probing and candidate training. Defaults to the full curriculum. */
  readonly stageIds?: readonly string[];
  /** Number of deterministic environment cases to probe (1–256); every case is one isolated headless training run. */
  readonly environmentCases: number;
  /** Active training time per environment case. The operator-facing default is 20 seconds. */
  readonly environmentSecondsPerCase?: number;
  /** Workers for the candidate runs when no probe is requested. Default 1. */
  readonly workers?: number;
  /**
   * When set, first measure throughput for each worker count (a short timed run each) and use the chosen count for
   * every environment case and candidate. Omit to skip the probe.
   */
  readonly probe?: {
    readonly workerCounts: readonly number[];
    readonly seconds: number;
    readonly warmupSeconds: number;
  };
  /** Where the winning settings are saved as the default. Omit to report them without saving. */
  readonly defaultsFile?: string;
  readonly logger?: { info(obj: unknown, msg?: string): void; warn?(obj: unknown, msg?: string): void };
}

export interface EnvironmentProbeCase {
  readonly index: number;
  readonly stageId: string;
  readonly scenarioId: string;
  /** Training-only seed range; deliberately disjoint from held-out evaluation seeds. */
  readonly seedBase: number;
  readonly workers: number;
  readonly status: "completed" | "failed";
  readonly error: string | null;
  readonly episodes: number;
  readonly successes: number;
  readonly explorations: number;
  readonly wallSeconds: number;
  readonly episodesPerMinute: number;
  readonly rewardFirstQuartileMean: number | null;
  readonly rewardLastQuartileMean: number | null;
  readonly successFirstQuartile: number | null;
  readonly successLastQuartile: number | null;
  /** Proxy for learnability: late-minus-early success plus reward trend scaled by the reward's bounded range. */
  readonly learningSignal: number | null;
}

export interface EnvironmentStageScore {
  readonly stageId: string;
  readonly cases: number;
  readonly completedCases: number;
  readonly episodes: number;
  readonly meanLearningSignal: number | null;
  readonly recommended: boolean;
}

export interface BenchmarkEntry {
  readonly candidate: BenchmarkCandidate;
  readonly status: "completed" | "failed";
  readonly error: string | null;
  readonly experiment: {
    readonly directory: string;
    readonly episodes: number;
    readonly explorations: number;
    readonly wallSeconds: number;
    readonly baselineSuccess: number;
    readonly trainedSuccess: number;
    readonly deltaPoints: number;
    readonly gateVerdict: string;
  } | null;
}

export interface BenchmarkReport {
  readonly name: string;
  readonly createdAt: string;
  readonly config: Omit<BenchmarkOptions, "logger">;
  /** Throughput per worker count, or null when the probe was skipped. */
  readonly probe: readonly ProbeResult[] | null;
  /** Per-environment training signals. Probe seeds are never used as held-out evaluation seeds. */
  readonly environmentProbe: readonly EnvironmentProbeCase[];
  readonly environmentScores: readonly EnvironmentStageScore[];
  /** Stages selected from the environment sweep and used for every candidate run. */
  readonly recommendedStageIds: readonly string[];
  /** Workers used for every environment and candidate run. */
  readonly workers: number;
  readonly entries: readonly BenchmarkEntry[];
  readonly winner: string | null;
  readonly decision: string;
  /** The default that was saved (or would have been, without a defaults file). */
  readonly defaults: TrainingDefaults | null;
}

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Picks the winner from finished entries. Pure, so the rule can be tested without training anything.
 * Eligible: completed, gate verdict `promotable`, and a gain over the baseline of at least `margin`.
 * Among eligible entries the higher held-out success wins; ties go to the lower exploration rate (the simpler choice).
 */
export function chooseBenchmarkWinner(
  entries: readonly BenchmarkEntry[],
  margin: number,
): { winner: string | null; decision: string } {
  const eligible = entries.filter(
    (entry) =>
      entry.status === "completed" &&
      entry.experiment !== null &&
      entry.experiment.gateVerdict === "promotable" &&
      entry.experiment.deltaPoints >= margin,
  );
  if (eligible.length === 0) {
    return {
      winner: null,
      decision: `No candidate passed the gate with at least ${(margin * 100).toFixed(1)} points gain over the baseline. The baseline stays the default.`,
    };
  }
  const best = [...eligible].sort(
    (left, right) =>
      right.experiment!.trainedSuccess - left.experiment!.trainedSuccess ||
      left.candidate.explorationRate - right.candidate.explorationRate ||
      left.candidate.id.localeCompare(right.candidate.id),
  )[0]!;
  return {
    winner: best.candidate.id,
    decision: `'${best.candidate.id}' (exploration ${best.candidate.explorationRate}) passed the gate with ${(best.experiment!.deltaPoints * 100).toFixed(1)} points gain over the baseline on held-out seeds. It is the proposed default.`,
  };
}

function summarise(report: HeadlessExperimentReport, directory: string): BenchmarkEntry["experiment"] {
  return {
    directory,
    episodes: report.training.episodes,
    explorations: report.training.explorations,
    wallSeconds: report.training.wallSeconds,
    baselineSuccess: report.heldOut.baselineSuccess,
    trainedSuccess: report.heldOut.trainedSuccess,
    deltaPoints: report.heldOut.deltaPoints,
    gateVerdict: report.heldOut.verdict,
  };
}

/** Environment probes use an isolated high seed range, not `evaluationSeeds()`. */
export const ENVIRONMENT_PROBE_SEED_BASE = TRAINING_SEED_BASE + 49_000_000;
export const ENVIRONMENT_PROBE_SEED_STRIDE = 100_001;
const ENVIRONMENT_PROBE_MAX_EPISODES = 100_000;
// Reward totals are weighted sums of six capped components; their positive-to-negative range is about 33.4.
const ENVIRONMENT_REWARD_RANGE = 33.4;
const LEARNING_SCORE_TOLERANCE = 0.25;

export function buildEnvironmentCases(stages: readonly CurriculumStage[], count: number): Array<{
  readonly index: number;
  readonly stageId: string;
  readonly scenarioId: string;
  readonly seedBase: number;
}> {
  const scenariosByStage = stages
    .map((stage) => ({
      stageId: stage.id,
      scenarios: stage.scenarioIds.map((scenarioId) => ({ stageId: stage.id, scenarioId })),
    }))
    .filter((stage) => stage.scenarios.length > 0);
  const environments: Array<{ readonly stageId: string; readonly scenarioId: string }> = [];
  const longestStage = Math.max(0, ...scenariosByStage.map((stage) => stage.scenarios.length));
  // Interleave stages instead of exhausting the first stage before sampling the next one. Small manual sweeps
  // (for example one case per selected stage) now remain representative rather than silently favouring basics.
  for (let scenarioIndex = 0; scenarioIndex < longestStage; scenarioIndex += 1) {
    for (const stage of scenariosByStage) {
      const environment = stage.scenarios[scenarioIndex];
      if (environment) environments.push(environment);
    }
  }
  if (environments.length === 0) throw new Error("Choose at least one curriculum stage with an environment to probe.");
  return Array.from({ length: count }, (_, index) => {
    const environment = environments[index % environments.length]!;
    return {
      index: index + 1,
      ...environment,
      seedBase: ENVIRONMENT_PROBE_SEED_BASE + index * ENVIRONMENT_PROBE_SEED_STRIDE,
    };
  });
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function quartiles<T>(values: readonly T[]): { first: readonly T[]; last: readonly T[] } {
  const quarter = Math.max(1, Math.floor(values.length / 4));
  return { first: values.slice(0, quarter), last: values.slice(-quarter) };
}

async function runEnvironmentCase(
  environment: ReturnType<typeof buildEnvironmentCases>[number],
  stage: CurriculumStage,
  options: BenchmarkOptions,
  workers: number,
  seconds: number,
): Promise<EnvironmentProbeCase> {
  const root = await mkdtemp(join(tmpdir(), "gamemind-env-probe-"));
  const samples: Array<{ readonly success: boolean; readonly reward: number | null; readonly explorations: number }> = [];
  const started = performance.now();
  try {
    const state = await runTraining({
      root,
      // Repeating one scenario template with a disjoint seed stream isolates which environment type is teaching the
      // learner. The configured stage budget is deliberately much longer than this timed probe, so it cannot advance.
      stages: [{ ...stage, scenarioIds: [environment.scenarioId] }],
      episodesPerStage: ENVIRONMENT_PROBE_MAX_EPISODES,
      maxEpisodes: ENVIRONMENT_PROBE_MAX_EPISODES,
      maxMinutes: seconds / 60,
      explorationRate: DEFAULT_TRAINING_EXPLORATION_RATE,
      workers,
      seedBase: environment.seedBase,
      evaluationSeedCount: options.evaluationSeeds,
      pollMs: 25,
      ...(options.logger ? { logger: options.logger as never } : {}),
      onEpisode: (event: TrainingEpisodeEvent) => samples.push({
        success: event.run.success,
        reward: event.reward,
        explorations: event.run.metrics.explorations ?? 0,
      }),
    });
    const wallSeconds = Math.max(0.001, (performance.now() - started) / 1000);
    if (state.status === "failed") throw new Error(state.lastError ?? "The environment probe failed.");
    if (samples.length === 0) throw new Error("No episode finished within this environment's time budget.");

    // Keep success and reward quartiles paired: a missing learner reward is not evidence of zero reward.
    const measuredSamples = samples.filter((sample) => sample.reward !== null);
    const rewards = measuredSamples.map((sample) => sample.reward!);
    const rewardQuartiles = quartiles(rewards);
    const successQuartiles = quartiles(measuredSamples.map((sample) => sample.success ? 1 : 0));
    const rewardFirstQuartileMean = mean(rewardQuartiles.first);
    const rewardLastQuartileMean = mean(rewardQuartiles.last);
    const successFirstQuartile = mean(successQuartiles.first);
    const successLastQuartile = mean(successQuartiles.last);
    const learningSignal = measuredSamples.length < 4 || rewardFirstQuartileMean === null || rewardLastQuartileMean === null || successFirstQuartile === null || successLastQuartile === null
      ? null
      : rounded((successLastQuartile - successFirstQuartile) + (rewardLastQuartileMean - rewardFirstQuartileMean) / ENVIRONMENT_REWARD_RANGE);
    return {
      ...environment,
      workers,
      status: "completed",
      error: null,
      episodes: samples.length,
      successes: samples.filter((sample) => sample.success).length,
      explorations: samples.reduce((sum, sample) => sum + sample.explorations, 0),
      wallSeconds: rounded(wallSeconds, 1),
      episodesPerMinute: rounded((samples.length / wallSeconds) * 60, 1),
      rewardFirstQuartileMean: rewardFirstQuartileMean === null ? null : rounded(rewardFirstQuartileMean),
      rewardLastQuartileMean: rewardLastQuartileMean === null ? null : rounded(rewardLastQuartileMean),
      successFirstQuartile: successFirstQuartile === null ? null : rounded(successFirstQuartile),
      successLastQuartile: successLastQuartile === null ? null : rounded(successLastQuartile),
      learningSignal,
    };
  } catch (error) {
    const wallSeconds = Math.max(0.001, (performance.now() - started) / 1000);
    return {
      ...environment,
      workers,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      episodes: samples.length,
      successes: samples.filter((sample) => sample.success).length,
      explorations: samples.reduce((sum, sample) => sum + sample.explorations, 0),
      wallSeconds: rounded(wallSeconds, 1),
      episodesPerMinute: samples.length === 0 ? 0 : rounded((samples.length / wallSeconds) * 60, 1),
      rewardFirstQuartileMean: null,
      rewardLastQuartileMean: null,
      successFirstQuartile: null,
      successLastQuartile: null,
      learningSignal: null,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function scoreEnvironmentStages(
  probe: readonly EnvironmentProbeCase[],
  requestedStageIds: readonly string[],
): { scores: EnvironmentStageScore[]; recommendedStageIds: string[] } {
  const scoreByStage = requestedStageIds.map((stageId) => {
    const cases = probe.filter((item) => item.stageId === stageId);
    const useful = cases.filter((item) => item.status === "completed" && item.learningSignal !== null);
    return {
      stageId,
      cases: cases.length,
      completedCases: cases.filter((item) => item.status === "completed").length,
      episodes: cases.reduce((sum, item) => sum + item.episodes, 0),
      meanLearningSignal: mean(useful.map((item) => item.learningSignal!)),
    };
  });
  const scored = scoreByStage.filter((score) => score.meanLearningSignal !== null);
  let recommendedStageIds: string[];
  if (scored.length === 0) {
    // No reliable trend could be measured; retain the operator's chosen environment instead of inventing a winner.
    recommendedStageIds = [...requestedStageIds];
  } else {
    const best = Math.max(...scored.map((score) => score.meanLearningSignal!));
    const measuredRecommendations = new Set(
      scored
        .filter((score) => score.meanLearningSignal! >= best - LEARNING_SCORE_TOLERANCE)
        .map((score) => score.stageId),
    );
    const unmeasured = new Set(
      scoreByStage
        .filter((score) => score.meanLearningSignal === null)
        .map((score) => score.stageId),
    );
    // A missing or too-short learning signal is not evidence that a stage is unhelpful. Keep those stages in
    // candidate training until a later sweep can measure them, while still prioritising stages with good evidence.
    recommendedStageIds = requestedStageIds.filter(
      (stageId) => measuredRecommendations.has(stageId) || unmeasured.has(stageId),
    );
  }
  const recommended = new Set(recommendedStageIds);
  return {
    scores: scoreByStage.map((score) => ({ ...score, recommended: recommended.has(score.stageId) })),
    recommendedStageIds,
  };
}


export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  if (!NAME_PATTERN.test(options.name)) throw new Error("Benchmark name must use letters, digits, '.', '_' or '-'.");
  if (options.candidates.length < 2) throw new Error("A benchmark needs at least two candidates to compare.");
  const ids = new Set<string>();
  for (const candidate of options.candidates) {
    if (!NAME_PATTERN.test(candidate.id)) throw new Error(`Candidate id '${candidate.id}' has invalid characters.`);
    if (ids.has(candidate.id)) throw new Error(`Candidate id '${candidate.id}' is listed twice.`);
    ids.add(candidate.id);
    if (!(candidate.explorationRate >= 0 && candidate.explorationRate <= 1)) {
      throw new Error(`Exploration rate for '${candidate.id}' must be between 0 and 1.`);
    }
  }
  if (!(options.margin >= 0 && options.margin <= 1)) throw new Error("Margin must be between 0 and 1.");
  if (!Number.isInteger(options.environmentCases) || options.environmentCases < 1 || options.environmentCases > 256) {
    throw new Error("Environment cases must be a whole number from 1 through 256.");
  }
  const environmentSeconds = options.environmentSecondsPerCase ?? 20;
  if (!(environmentSeconds > 0 && environmentSeconds <= 600)) throw new Error("Seconds per environment case must be greater than 0 and at most 600.");
  const stageIds = options.stageIds ?? TRAINING_STAGES.map((stage) => stage.id);
  const knownStages = new Set(TRAINING_STAGES.map((stage) => stage.id));
  const unknownStages = stageIds.filter((id) => !knownStages.has(id));
  if (stageIds.length === 0 || unknownStages.length > 0) {
    throw new Error(stageIds.length === 0 ? "Choose at least one curriculum stage." : `Unknown curriculum stage(s): ${unknownStages.join(", ")}.`);
  }
  if (new Set(stageIds).size !== stageIds.length) throw new Error("Curriculum stages may not be listed more than once.");
  const stages = TRAINING_STAGES.filter((stage) => stageIds.includes(stage.id));
  const workers = options.workers ?? 1;
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error("Workers must be a whole number from 1 through 8.");
  if (options.probe) {
    if (options.probe.workerCounts.length === 0 || options.probe.workerCounts.some((count) => !Number.isInteger(count) || count < 1 || count > 8)) {
      throw new Error("Probe worker counts must be whole numbers from 1 through 8.");
    }
    if (new Set(options.probe.workerCounts).size !== options.probe.workerCounts.length) throw new Error("Probe worker counts may not be repeated.");
  }

  const outDir = options.outDir ?? "data/experiments";
  const reportPath = join(outDir, "benchmarks", `${options.name}.json`);
  try {
    await stat(reportPath);
    throw new Error(`Benchmark ${reportPath} already exists. Choose a new name; earlier benchmarks are never overwritten.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }

  // Step 1: select a worker count using a short throughput/stability run on the same curriculum stages.
  const probe = options.probe
    ? await probeWorkerCounts({
        workerCounts: options.probe.workerCounts,
        seconds: options.probe.seconds,
        warmupSeconds: options.probe.warmupSeconds,
        workDir: join(outDir, options.name, "worker-probe"),
        stages,
        ...(options.logger ? { logger: options.logger as never } : {}),
      })
    : null;
  const chosenWorkers = probe ? (chooseWorkerCount(probe) ?? workers) : workers;
  options.logger?.info({ workers: chosenWorkers, probed: probe !== null }, "benchmark worker count chosen");

  // Step 2: controlled environment sweep. Each case trains on one scenario with a disjoint training-only seed block.
  const environmentCases = buildEnvironmentCases(stages, options.environmentCases);
  const environmentProbe: EnvironmentProbeCase[] = [];
  for (const environment of environmentCases) {
    const stage = stages.find((item) => item.id === environment.stageId)!;
    options.logger?.info({ case: environment.index, cases: environmentCases.length, stage: stage.id, scenario: environment.scenarioId, seconds: environmentSeconds }, "environment probe started");
    const result = await runEnvironmentCase(environment, stage, options, chosenWorkers, environmentSeconds);
    environmentProbe.push(result);
    options.logger?.info({ case: environment.index, stage: stage.id, scenario: environment.scenarioId, status: result.status, episodes: result.episodes, learningSignal: result.learningSignal }, "environment probe finished");
  }
  const environmentSelection = scoreEnvironmentStages(environmentProbe, stageIds);
  const recommendedStages = TRAINING_STAGES.filter((stage) => environmentSelection.recommendedStageIds.includes(stage.id));

  // Step 3: compare exploration rates under the same budget and measured environment selection.
  const entries: BenchmarkEntry[] = [];
  for (const candidate of options.candidates) {
    const experimentName = `${options.name}--${candidate.id}`;
    const directory = join(outDir, experimentName);
    options.logger?.info({ candidate: candidate.id, experiment: experimentName, stageIds: environmentSelection.recommendedStageIds }, "benchmark candidate started");
    try {
      const report = await runHeadlessExperiment({
        name: experimentName,
        outDir,
        episodesPerStage: options.episodesPerStage,
        maxEpisodes: options.maxEpisodes,
        explorationRate: candidate.explorationRate,
        evaluationSeeds: options.evaluationSeeds,
        workers: chosenWorkers,
        stages: recommendedStages,
        ...(options.logger ? { logger: options.logger } : {}),
      });
      entries.push({ candidate, status: "completed", error: null, experiment: summarise(report, directory) });
    } catch (error) {
      // A failed candidate is recorded and excluded; it must not hide the others or be silently dropped.
      entries.push({
        candidate,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        experiment: null,
      });
    }
  }

  const { winner, decision } = chooseBenchmarkWinner(entries, options.margin);

  // Step 4: save what evidence supports. The environment sweep is a learnability signal; only the full held-out gate
  // can nominate an exploration winner. Neither result changes the live policy.
  const completed = entries.some((entry) => entry.status === "completed");
  let defaults: TrainingDefaults | null = null;
  if (completed) {
    const previous = options.defaultsFile ? await readTrainingDefaults(options.defaultsFile) : null;
    const winningCandidate = winner ? entries.find((entry) => entry.candidate.id === winner)?.candidate : undefined;
    const explorationRate = winningCandidate?.explorationRate ?? previous?.explorationRate ?? DEFAULT_TRAINING_EXPLORATION_RATE;
    const createdAt = new Date().toISOString();
    const environmentText = `Environment stages [${environmentSelection.recommendedStageIds.join(", ")}] selected from ${environmentProbe.length} probe case(s) by early/late reward and success trend; stages without a reliable signal are retained, and held-out evaluation remains the quality gate.`;
    defaults = {
      schemaVersion: 1,
      workers: chosenWorkers,
      explorationRate,
      savedAt: createdAt,
      benchmark: options.name,
      decision: `${decision} ${environmentText} Workers: ${chosenWorkers}${probe ? " (chosen by the throughput probe)" : " (set without a probe)"}.`,
      stageIds: environmentSelection.recommendedStageIds,
      probe: probe
        ? probe.map((result) => ({
            workers: result.workers,
            status: result.status,
            episodesPerMinute: result.episodesPerMinute,
            cpuPercent: result.cpuPercent,
            peakRssMb: result.peakRssMb,
            respawns: result.respawns,
            eligible: result.eligible,
            reason: result.reason,
          }))
        : null,
      machine: { platform: `${platform()} ${release()} ${arch()}`, cpus: cpus().length, memoryGb: Math.round((totalmem() / 1073741824) * 10) / 10, node: process.version },
    };
    if (options.defaultsFile) await saveTrainingDefaults(options.defaultsFile, defaults);
  }

  const { logger: _logger, ...config } = options;
  const report: BenchmarkReport = {
    name: options.name,
    createdAt: new Date().toISOString(),
    config: { ...config, stageIds, environmentCases: options.environmentCases, environmentSecondsPerCase: environmentSeconds },
    probe,
    environmentProbe,
    environmentScores: environmentSelection.scores,
    recommendedStageIds: environmentSelection.recommendedStageIds,
    workers: chosenWorkers,
    entries,
    winner,
    decision,
    defaults,
  };
  await mkdir(join(outDir, "benchmarks"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}
