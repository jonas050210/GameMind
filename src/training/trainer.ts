import { mkdir, rm } from "node:fs/promises";
import type { Logger } from "pino";
import { ExperienceLearner } from "../core/learning/learner.js";
import type { PolicyWeights } from "../core/learning/policy-weights.js";
import { runEvaluationOnce, type EvaluationRun, type EvaluationRunOptions } from "../testing/eval/harness.js";
import type { EvaluationScenario } from "../testing/eval/scenarios.js";
import {
  TRAINING_SEED_BASE,
  TRAINING_STAGES,
  assertSeedSplit,
  curriculumScenarios,
  trainingSeed,
  type CurriculumStage,
} from "./curriculum.js";
import {
  TRAINING_SCHEMA_VERSION,
  readControlCommand,
  readTrainingState,
  trainingPaths,
  writeControlCommand,
  writeJsonAtomic,
  type TrainingCheckpointRecord,
  type TrainingEpisodeRecord,
  type TrainingPaths,
  type TrainingState,
} from "./state.js";

/** Runs one scenario episode. Injectable so tests can drive the state machine without the simulator. */
export type EpisodeRunner = (
  scenario: EvaluationScenario,
  seed: number,
  options: EvaluationRunOptions,
) => Promise<EvaluationRun>;

export interface TrainingRunOptions {
  readonly root: string;
  /** Minimum episodes per stage before the pass check; a stage is also capped at three times this. */
  readonly episodesPerStage?: number;
  /** Total episode budget across all stages. */
  readonly maxEpisodes?: number;
  /** Time budget for the whole run, counted as active episode time (pauses excluded). */
  readonly maxMinutes?: number;
  /** Start over: deletes the experience store and state. Without it, an existing run is resumed. */
  readonly fresh?: boolean;
  readonly stages?: readonly CurriculumStage[];
  readonly episodeRunner?: EpisodeRunner;
  /** How often a paused trainer re-reads its control file. */
  readonly pollMs?: number;
  /** Seed count the evaluation will later use; used to prove the seed split holds. */
  readonly evaluationSeedCount?: number;
  readonly logger?: Pick<Logger, "info" | "warn" | "error">;
  readonly now?: () => Date;
}

const DEFAULT_EPISODES_PER_STAGE = 8;
const RECENT_LIMIT = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initialState(
  options: Required<Pick<TrainingRunOptions, "episodesPerStage" | "maxEpisodes">> & { maxMinutes: number | null },
  now: string,
): TrainingState {
  return {
    schemaVersion: TRAINING_SCHEMA_VERSION,
    status: "running",
    control: "run",
    stageIndex: 0,
    stageEpisodes: 0,
    stageSuccesses: 0,
    totalEpisodes: 0,
    episodesPerStage: options.episodesPerStage,
    maxEpisodes: options.maxEpisodes,
    seedBase: TRAINING_SEED_BASE,
    startedAt: now,
    updatedAt: now,
    pid: process.pid,
    lastError: null,
    recent: [],
    checkpoints: [],
    lastEvaluation: null,
    activeMs: 0,
    maxMinutes: options.maxMinutes,
    stopReason: null,
  };
}

/**
 * Runs the curriculum. The loop is:
 *   pick the next episode of the current stage → run it on a training seed with the persisted learner →
 *   record the outcome → persist state → when the stage passes (or hits its cap) write a checkpoint of the
 *   candidate weights and move on.
 * It checks the control file between episodes, so pause and stop take effect after at most one episode.
 * Learning is the learner's own: experience is recorded per action and the candidate weights are derived from
 * it. Nothing here changes the active policy; promotion stays with the offline gate.
 */
export async function runTraining(options: TrainingRunOptions): Promise<TrainingState> {
  const paths = trainingPaths(options.root);
  const stages = options.stages ?? TRAINING_STAGES;
  const logger = options.logger;
  const now = options.now ?? (() => new Date());
  const episodeRunner: EpisodeRunner = options.episodeRunner ?? runEvaluationOnce;
  const pollMs = options.pollMs ?? 1_000;

  if (options.fresh) {
    await rm(paths.state, { force: true });
    await rm(paths.control, { force: true });
    await rm(paths.experience, { recursive: true, force: true });
    await rm(paths.checkpoints, { recursive: true, force: true });
  }
  await mkdir(paths.root, { recursive: true });

  const scenarios = curriculumScenarios(stages);
  const existing = await readTrainingState(paths);
  const episodesPerStage = options.episodesPerStage ?? existing?.episodesPerStage ?? DEFAULT_EPISODES_PER_STAGE;
  const maxEpisodes = options.maxEpisodes ?? existing?.maxEpisodes ?? episodesPerStage * stages.length * 2;
  const maxMinutes = options.maxMinutes ?? existing?.maxMinutes ?? null;
  // On resume the saved progress is kept, but the budget and stage size come from this invocation, so a run can
  // be extended with a larger --max-episodes.
  const state: TrainingState = existing
    ? {
        ...existing,
        status: "running",
        control: "run",
        pid: process.pid,
        lastError: null,
        episodesPerStage,
        maxEpisodes,
        maxMinutes,
        stopReason: null,
        updatedAt: now().toISOString(),
      }
    : initialState({ episodesPerStage, maxEpisodes, maxMinutes }, now().toISOString());
  if (options.evaluationSeedCount !== undefined) assertSeedSplit(options.evaluationSeedCount, maxEpisodes);
  await writeControlCommand(paths, "run");
  await persist(paths, state, now);

  const learner = ExperienceLearner.forDirectory(paths.experience);
  await learner.load();
  logger?.info({ episodes: state.totalEpisodes, stage: stages[state.stageIndex]?.id }, "Training started");

  let final: TrainingState["status"] = "completed";
  let stopReason: string | null = null;
  try {
    while (state.stageIndex < stages.length && state.totalEpisodes < state.maxEpisodes) {
      const command = await readControlCommand(paths);
      if (command === "stop") {
        final = "stopped";
        stopReason = "Stopped by the operator after the current episode.";
        break;
      }
      if (state.maxMinutes !== null && state.activeMs >= state.maxMinutes * 60_000) {
        stopReason = `Time budget of ${state.maxMinutes} min reached.`;
        break;
      }
      if (command === "pause") {
        if (state.status !== "paused") {
          state.status = "paused";
          await persist(paths, state, now);
          logger?.info({ episodes: state.totalEpisodes }, "Training paused");
        }
        await sleep(pollMs);
        continue;
      }
      if (state.status !== "running") {
        state.status = "running";
        logger?.info({ episodes: state.totalEpisodes }, "Training resumed");
      }

      const stage = stages[state.stageIndex]!;
      const scenarioId = stage.scenarioIds[state.stageEpisodes % stage.scenarioIds.length]!;
      const scenario = scenarios.get(scenarioId)!;
      const seed = trainingSeed(state.totalEpisodes);
      const before = learner.rewardTotals;
      const episodeStarted = performance.now();
      const run = await episodeRunner(scenario, seed, {
        learner,
        worldKey: `train:${scenario.id}:${seed}`,
        runId: `train-${String(state.totalEpisodes).padStart(6, "0")}`,
      });
      state.activeMs += performance.now() - episodeStarted;
      const after = learner.rewardTotals;
      const episodeReward = after.episodes > before.episodes ? after.sum - before.sum : null;

      const record: TrainingEpisodeRecord = {
        index: state.totalEpisodes,
        stageId: stage.id,
        scenarioId: scenario.id,
        seed,
        success: run.success,
        status: run.status,
        failureCode: run.failureCode,
        actions: run.metrics.actions,
        wastedActions: run.metrics.wastedActions,
        simulatedSeconds: Math.round(run.simulatedMs / 100) / 10,
        reward: episodeReward === null ? null : Math.round(episodeReward * 1000) / 1000,
        at: now().toISOString(),
      };
      state.recent = [record, ...state.recent].slice(0, RECENT_LIMIT);
      state.totalEpisodes += 1;
      state.stageEpisodes += 1;
      if (run.success) state.stageSuccesses += 1;
      state.updatedAt = now().toISOString();

      const successRate = state.stageEpisodes === 0 ? 0 : state.stageSuccesses / state.stageEpisodes;
      const passed = state.stageEpisodes >= stage.minEpisodes && successRate >= stage.passRate;
      const capped = state.stageEpisodes >= stage.minEpisodes * 3;
      if (passed || capped) {
        const checkpoint = await saveCheckpoint(paths, learner.candidateWeights, stage.id, state.totalEpisodes, now);
        state.checkpoints = [...state.checkpoints, checkpoint];
        logger?.info(
          { stage: stage.id, successRate, episodes: state.stageEpisodes, capped, checkpoint: checkpoint.id },
          passed ? "Stage passed; checkpoint written" : "Stage episode cap reached; checkpoint written",
        );
        state.stageIndex += 1;
        state.stageEpisodes = 0;
        state.stageSuccesses = 0;
      }
      await persist(paths, state, now);
    }
    if (final !== "stopped" && stopReason === null) {
      if (state.stageIndex >= stages.length) stopReason = "Curriculum complete.";
      else if (state.totalEpisodes >= state.maxEpisodes) stopReason = `Episode budget of ${state.maxEpisodes} reached.`;
    }
  } catch (error) {
    final = "failed";
    state.lastError = error instanceof Error ? error.message : String(error);
    logger?.error({ err: error }, "Training failed; state is kept so the run can be resumed");
  }

  // Stopping, pausing and finishing all leave a checkpoint of whatever has been learned since the last one.
  const lastCheckpointEpisodes = state.checkpoints.at(-1)?.episodes ?? 0;
  if (final !== "failed" && state.totalEpisodes > lastCheckpointEpisodes) {
    const stageLabel = stages[Math.min(state.stageIndex, stages.length - 1)]?.id ?? "final";
    const checkpoint = await saveCheckpoint(paths, learner.candidateWeights, `${stageLabel}-partial`, state.totalEpisodes, now);
    state.checkpoints = [...state.checkpoints, checkpoint];
  }
  state.status = final;
  state.stopReason = final === "failed" ? null : stopReason;
  state.pid = null;
  state.control = final === "stopped" ? "stop" : "run";
  state.updatedAt = now().toISOString();
  await persist(paths, state, now);
  logger?.info({ status: final, episodes: state.totalEpisodes }, "Training finished");
  return state;
}

async function persist(paths: TrainingPaths, state: TrainingState, now: () => Date): Promise<void> {
  state.updatedAt = now().toISOString();
  await writeJsonAtomic(paths.state, state);
}

async function saveCheckpoint(
  paths: TrainingPaths,
  weights: PolicyWeights,
  stageId: string,
  episodes: number,
  now: () => Date,
): Promise<TrainingCheckpointRecord> {
  const id = `ckpt-${String(episodes).padStart(6, "0")}`;
  const path = `${paths.checkpoints}/${id}.json`;
  const createdAt = now().toISOString();
  await writeJsonAtomic(path, { schemaVersion: 1, id, stageId, createdAt, episodes, weights });
  return {
    id,
    stageId,
    createdAt,
    episodes,
    weightsId: weights.id,
    weightedContexts: Object.keys(weights.entries).length,
    path,
  };
}
