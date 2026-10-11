/**
 * Reproducible headless learning experiment, offline simulator only. It answers four questions with recorded evidence,
 * and reports negative or inconclusive results as such:
 *
 *  1. Do the policy parameters change during training? (compared with the untrained baseline, per weight entry)
 *  2. Does training produce experience about alternatives? (exploration count, per-episode reward and outcome log)
 *  3. Does the trained policy change behaviour on held-out worlds? (chosen-goal sequences vs baseline, same seeds)
 *  4. Is the held-out success rate better than the untrained baseline? (the existing gated evaluation, unchanged)
 *
 * It never writes to an existing directory, so previous datasets and checkpoints are not touched.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExperienceLearner } from "../core/learning/learner.js";
import { BASELINE_POLICY_WEIGHTS, type PolicyWeights } from "../core/learning/policy-weights.js";
import { evaluationSeeds, runEvaluationOnce } from "../testing/eval/harness.js";
import { evaluationScenarios } from "../testing/eval/scenarios.js";
import { evaluateCheckpoint, loadCheckpoint } from "./evaluate.js";
import { TRAINING_SEED_BASE } from "./curriculum.js";
import { trainingPaths, writeJsonAtomic } from "./state.js";
import { runTraining } from "./trainer.js";

export interface HeadlessExperimentOptions {
  /** Experiment name; becomes the directory name under `outDir`. Must not already exist. */
  readonly name: string;
  readonly outDir?: string;
  readonly episodesPerStage: number;
  readonly maxEpisodes: number;
  readonly explorationRate: number;
  readonly evaluationSeeds: number;
  /** Episodes that run at the same time (one worker process each). Default 1. */
  readonly workers?: number;
  readonly logger?: { info(obj: unknown, msg?: string): void };
}

export interface ParameterChange {
  readonly baselineEntries: number;
  readonly trainedEntries: number;
  readonly entriesChanged: number;
  readonly maxAbsDelta: number;
  readonly meanAbsDelta: number;
}

export interface HeadlessExperimentReport {
  readonly name: string;
  readonly directory: string;
  readonly gitCommit: string | null;
  readonly config: Omit<HeadlessExperimentOptions, "logger">;
  readonly training: {
    readonly status: string;
    readonly episodes: number;
    readonly envSteps: number;
    readonly explorations: number;
    readonly wallSeconds: number;
    readonly episodesPerSecond: number;
    readonly envStepsPerSecond: number;
    readonly rewardFirstQuartileMean: number | null;
    readonly rewardLastQuartileMean: number | null;
    readonly successFirstQuartile: number | null;
    readonly successLastQuartile: number | null;
  };
  readonly checkpoints: readonly { id: string; episodes: number; integrity: string; digest: string | null }[];
  readonly parameterChange: ParameterChange;
  readonly heldOut: {
    readonly seeds: number;
    readonly baselineSuccess: number;
    readonly trainedSuccess: number;
    readonly deltaPoints: number;
    readonly verdict: string;
    readonly reasons: readonly string[];
  };
  readonly behaviour: {
    readonly runsCompared: number;
    readonly runsWithDifferentGoalSequence: number;
    readonly differentFraction: number;
    /** Runs whose goal-and-target sequence differs (finer than the goal sequence above). */
    readonly runsWithDifferentChoiceSequence: number;
    readonly differentChoiceFraction: number;
    readonly runsWithDifferentOutcome: number;
  };
  readonly conclusion: string;
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round3(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function quartiles<T>(values: readonly T[]): { first: readonly T[]; last: readonly T[] } {
  const quarter = Math.max(1, Math.floor(values.length / 4));
  return { first: values.slice(0, quarter), last: values.slice(-quarter) };
}

function parameterChange(baseline: PolicyWeights, trained: PolicyWeights): ParameterChange {
  const keys = new Set([...Object.keys(baseline.entries), ...Object.keys(trained.entries)]);
  let changed = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  for (const key of keys) {
    const before = baseline.entries[key]?.weight ?? 1;
    const after = trained.entries[key]?.weight ?? 1;
    const delta = Math.abs(after - before);
    if (delta > 0) changed += 1;
    maxDelta = Math.max(maxDelta, delta);
    sumDelta += delta;
  }
  return {
    baselineEntries: Object.keys(baseline.entries).length,
    trainedEntries: Object.keys(trained.entries).length,
    entriesChanged: changed,
    maxAbsDelta: Math.round(maxDelta * 1000) / 1000,
    meanAbsDelta: keys.size === 0 ? 0 : Math.round((sumDelta / keys.size) * 1000) / 1000,
  };
}

/** Runs the whole experiment and writes `manifest.json` and `episodes.jsonl` into the experiment directory. */
export async function runHeadlessExperiment(options: HeadlessExperimentOptions): Promise<HeadlessExperimentReport> {
  const outDir = options.outDir ?? "data/experiments";
  const directory = join(outDir, options.name);
  try {
    await stat(directory);
    throw new Error(`Experiment directory ${directory} already exists. Choose a new --name; existing experiments are never overwritten.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }
  await mkdir(join(directory, "training"), { recursive: true });
  const episodeLog = join(directory, "episodes.jsonl");
  await writeFile(episodeLog, "");

  // Per episode: the reward the learner was credited with, the outcome, and the number of exploratory switches. The
  // trainer calls this in episode order, whether the episodes ran in this process or in workers.
  let explorations = 0;
  let envSteps = 0;
  const started = performance.now();
  const state = await runTraining({
    root: join(directory, "training"),
    episodesPerStage: options.episodesPerStage,
    maxEpisodes: options.maxEpisodes,
    explorationRate: options.explorationRate,
    workers: options.workers ?? 1,
    evaluationSeedCount: options.evaluationSeeds,
    onEpisode: (event) => {
      const { record, run, reward, runId } = event;
      explorations += run.metrics.explorations ?? 0;
      envSteps += run.metrics.actions;
      appendFileSync(
        episodeLog,
        `${JSON.stringify({
          runId,
          scenarioId: record.scenarioId,
          seed: record.seed,
          success: run.success,
          failureCode: run.failureCode,
          actions: run.metrics.actions,
          explorations: run.metrics.explorations ?? 0,
          reward: reward === null ? null : Math.round(reward * 1000) / 1000,
          workers: event.workers,
        })}\n`,
      );
    },
    ...(options.logger ? { logger: options.logger as never } : {}),
  });
  const wallSeconds = (performance.now() - started) / 1000;

  const paths = trainingPaths(join(directory, "training"));
  const lastCheckpoint = state.checkpoints.at(-1);
  if (!lastCheckpoint) throw new Error("Training produced no checkpoint; nothing to evaluate.");
  const loaded = await loadCheckpoint(paths, lastCheckpoint.id);
  const change = parameterChange(BASELINE_POLICY_WEIGHTS, loaded.weights);

  const episodes = (await readFile(episodeLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { success: boolean; reward: number | null });
  const rewards = episodes.map((episode) => episode.reward).filter((value): value is number => value !== null);
  const rewardQuartiles = quartiles(rewards);
  const successQuartiles = quartiles(episodes.map((episode) => (episode.success ? 1 : 0)));

  // Held-out evaluation: the existing gate, unchanged. Baseline and trained policy on the same disjoint seeds.
  const report = await evaluateCheckpoint({ root: join(directory, "training"), checkpointId: lastCheckpoint.id, seeds: options.evaluationSeeds });

  // Behaviour comparison: same scenario and seed, with and without the trained weights; compare the chosen goals.
  const scenarios = evaluationScenarios();
  const seeds = evaluationSeeds(options.evaluationSeeds);
  const trainedLearner = new ExperienceLearner();
  await trainedLearner.promote(loaded.weights, "headless experiment (not persisted)");
  let compared = 0;
  let differentGoals = 0;
  let differentChoices = 0;
  let differentOutcome = 0;
  for (const scenario of scenarios) {
    for (const seed of seeds) {
      const baseRun = await runEvaluationOnce(scenario, seed, { worldKey: null });
      const trainedRun = await runEvaluationOnce(scenario, seed, { learner: trainedLearner, worldKey: null });
      compared += 1;
      if (JSON.stringify(baseRun.actionGoals) !== JSON.stringify(trainedRun.actionGoals)) differentGoals += 1;
      if (JSON.stringify(baseRun.actionChoices) !== JSON.stringify(trainedRun.actionChoices)) differentChoices += 1;
      if (baseRun.success !== trainedRun.success) differentOutcome += 1;
    }
  }

  const deltaPoints = Math.round((report.candidate.metrics.successRate - report.baseline.metrics.successRate) * 1000) / 10;
  const improved = report.decision.promote && deltaPoints > 0;
  const conclusion = improved
    ? `Held-out success improved by ${deltaPoints} points and the gate passed. Simulator only; not live evidence.`
    : differentGoals === 0
      ? "Inconclusive/negative: the trained weights changed no chosen goal on any held-out run, so they cannot change held-out success."
      : `No held-out improvement (${deltaPoints} points). The weights changed chosen goals on ${differentGoals}/${compared} runs, but the gate did not promote them. Simulator only.`;

  const result: HeadlessExperimentReport = {
    name: options.name,
    directory,
    gitCommit: gitCommit(),
    config: { ...options, logger: undefined } as never,
    training: {
      status: state.status,
      episodes: state.totalEpisodes,
      envSteps,
      explorations,
      wallSeconds: Math.round(wallSeconds * 10) / 10,
      episodesPerSecond: Math.round((state.totalEpisodes / wallSeconds) * 10) / 10,
      envStepsPerSecond: Math.round((envSteps / wallSeconds) * 10) / 10,
      rewardFirstQuartileMean: round3(mean(rewardQuartiles.first)),
      rewardLastQuartileMean: round3(mean(rewardQuartiles.last)),
      successFirstQuartile: mean(successQuartiles.first),
      successLastQuartile: mean(successQuartiles.last),
    },
    checkpoints: await Promise.all(
      state.checkpoints.map(async (record) => {
        const checked = await loadCheckpoint(paths, record.id);
        const raw = JSON.parse(await readFile(record.path, "utf8")) as { digest?: string };
        return { id: record.id, episodes: record.episodes, integrity: checked.integrity, digest: raw.digest ?? null };
      }),
    ),
    parameterChange: change,
    heldOut: {
      seeds: options.evaluationSeeds,
      baselineSuccess: report.baseline.metrics.successRate,
      trainedSuccess: report.candidate.metrics.successRate,
      deltaPoints,
      verdict: report.verdict,
      reasons: report.decision.reasons,
    },
    behaviour: {
      runsCompared: compared,
      runsWithDifferentGoalSequence: differentGoals,
      differentFraction: compared === 0 ? 0 : Math.round((differentGoals / compared) * 1000) / 1000,
      runsWithDifferentChoiceSequence: differentChoices,
      differentChoiceFraction: compared === 0 ? 0 : Math.round((differentChoices / compared) * 1000) / 1000,
      runsWithDifferentOutcome: differentOutcome,
    },
    conclusion,
  };
  await writeJsonAtomic(join(directory, "manifest.json"), { ...result, trainingSeedBase: TRAINING_SEED_BASE });
  return result;
}
