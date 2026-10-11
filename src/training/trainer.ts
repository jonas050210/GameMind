import { mkdir, readdir, readFile } from "node:fs/promises";
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
import { acquireTrainingLock, type LockEnvironment } from "./lock.js";
import { createProcessEpisodePool, type EpisodePool } from "./episode-pool.js";
import { replayCapture, type EpisodeJob, type WorkerTelemetry } from "./episode-job.js";
import { TRAINING_SCHEMA_VERSION, readControlCommand, readTrainingState, trainingPaths, writeControlCommand, writeJsonAtomic, type TrainingCheckpointRecord, type TrainingEpisodeRecord, type TrainingPaths, type TrainingState, archiveTrainingArtifacts, canonicalDigest } from "./state.js";

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
  /** Start over: archives (never deletes) the previous state, experience and checkpoints first. Without it, an existing run is resumed. */
  readonly fresh?: boolean;
  /** Probability that an eligible progress decision tries an alternative (0 = greedy, the default). Seeded per episode. */
  readonly explorationRate?: number;
  readonly stages?: readonly CurriculumStage[];
  readonly episodeRunner?: EpisodeRunner;
  /** How often a paused trainer re-reads its control file. */
  readonly pollMs?: number;
  /** Seed count the evaluation will later use; used to prove the seed split holds. */
  readonly evaluationSeedCount?: number;
  readonly logger?: Pick<Logger, "info" | "warn" | "error">;
  readonly now?: () => Date;
  /** Set false only for callers that already hold the directory lock. Default: take it, so two runs cannot share a directory. */
  readonly lock?: boolean;
  readonly lockEnvironment?: LockEnvironment;
  /**
   * Number of episodes that run at the same time, each in its own worker process. One brain: every worker plays
   * against the same learner state and the results are merged into the trainer's learner in job order. 1 (default)
   * runs the episodes one after another in this process.
   */
  readonly workers?: number;
  /** Test seam: an already-built pool (for example an in-process one). Overrides `workers` for the pool size. */
  readonly episodePool?: EpisodePool;
  /** Called once per finished episode, in order. Used for experiment logs and throughput measurement. */
  readonly onEpisode?: (event: TrainingEpisodeEvent) => void;
}

export interface TrainingEpisodeEvent {
  readonly record: TrainingEpisodeRecord;
  readonly run: EvaluationRun;
  readonly reward: number | null;
  readonly runId: string;
  readonly explorationRate: number;
  readonly workers: number;
  /** Worker-side numbers for this episode; null when it ran in the trainer process. */
  readonly telemetry: WorkerTelemetry | null;
}

/** Thrown when a directory holds training data that a new run would silently overwrite. */
export class TrainingDirectoryError extends Error {
  readonly code = "TRAINING_DIRECTORY_HAS_DATA";
  constructor(message: string) {
    super(message);
    this.name = "TrainingDirectoryError";
  }
}

async function countEntries(directory: string): Promise<number> {
  try {
    return (await readdir(directory)).filter((name) => !name.startsWith(".") && !name.endsWith(".tmp")).length;
  } catch {
    return 0;
  }
}

/** What a directory already holds, so a run can refuse to write over data it does not own. */
export async function describeTrainingArtifacts(paths: TrainingPaths): Promise<{ readonly checkpoints: number; readonly experienceFiles: number; readonly evaluations: number }> {
  const [checkpoints, experienceFiles, evaluations] = await Promise.all([
    countEntries(paths.checkpoints),
    countEntries(paths.experience),
    countEntries(paths.evaluations),
  ]);
  return { checkpoints, experienceFiles, evaluations };
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
  const lock = options.lock === false ? null : acquireTrainingLock(options.root, "train", options.lockEnvironment);
  try {
    return await runTrainingLocked(options);
  } finally {
    lock?.release();
  }
}

async function runTrainingLocked(options: TrainingRunOptions): Promise<TrainingState> {
  const paths = trainingPaths(options.root);
  const stages = options.stages ?? TRAINING_STAGES;
  const logger = options.logger;
  const now = options.now ?? (() => new Date());
  const episodeRunner: EpisodeRunner = options.episodeRunner ?? runEvaluationOnce;
  const pollMs = options.pollMs ?? 1_000;

  if (options.fresh) {
    // A fresh start archives the previous run rather than deleting it: its checkpoints, experience and evaluations
    // are learning data, and removing them silently would make a regression impossible to diagnose or undo.
    const archive = await archiveTrainingArtifacts(paths, now(), "fresh training start");
    if (archive.archiveDir) {
      logger?.info({ archiveDir: archive.archiveDir, moved: archive.moved }, "Archived the previous training run before a fresh start");
    }
  }
  await mkdir(paths.root, { recursive: true });

  const scenarios = curriculumScenarios(stages);
  const existing = await readTrainingState(paths);
  if (!existing) {
    // No state file but existing data: a new run would number its checkpoints from 1 again and replace the old files
    // that carry the same ids. Refuse and say how to proceed instead of overwriting learning data.
    const artifacts = await describeTrainingArtifacts(paths);
    if (artifacts.checkpoints > 0 || artifacts.experienceFiles > 0 || artifacts.evaluations > 0) {
      throw new TrainingDirectoryError(
        `This training directory already holds data (${artifacts.checkpoints} checkpoint(s), ${artifacts.experienceFiles} experience file(s), ${artifacts.evaluations} evaluation(s)) but no state file, so it cannot be resumed. ` +
          "Starting here would overwrite checkpoints that have the same ids. Choose a fresh start (the existing data is archived, never deleted) or use another directory.",
      );
    }
  } else {
    const wanted = stages.map((stage) => stage.id);
    if (existing.stageIds && (existing.stageIds.length !== wanted.length || existing.stageIds.some((id, index) => id !== wanted[index]))) {
      throw new TrainingDirectoryError(
        `This run was started with the stages [${existing.stageIds.join(", ")}]; resuming it with [${wanted.join(", ")}] would misplace its progress. Resume with the same stages, or start fresh to change the curriculum.`,
      );
    }
  }
  const configuredPerStage = options.episodesPerStage ?? existing?.episodesPerStage ?? null;
  const episodesPerStage = configuredPerStage ?? DEFAULT_EPISODES_PER_STAGE;
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
  state.stageIds = stages.map((stage) => stage.id);
  state.explorationRate = options.explorationRate ?? 0;
  if (options.evaluationSeedCount !== undefined) assertSeedSplit(options.evaluationSeedCount, maxEpisodes);
  await writeControlCommand(paths, "run");
  await persist(paths, state, now);

  const learner = ExperienceLearner.forDirectory(paths.experience);
  await learner.load();
  logger?.info({ episodes: state.totalEpisodes, stage: stages[state.stageIndex]?.id }, "Training started");

  const pool = await choosePool(options, learner, paths.experience, stages, logger);
  // A resumed run that now runs in one process must not keep the throughput of an earlier parallel run.
  if (!pool) delete state.parallel;
  const batchSize = (): number => (pool ? pool.size : 1);
  let runEpisodes = 0;
  let runActiveMs = 0;

  let final: TrainingState["status"] = "completed";
  let stopReason: string | null = null;
  const explorationRate = options.explorationRate ?? 0;

  /** Books one finished episode: the record, the counters, the stage pass check and the checkpoint. */
  const settle = async (
    job: EpisodeJob,
    run: EvaluationRun,
    reward: number | null,
    telemetry: WorkerTelemetry | null,
  ): Promise<void> => {
    const record: TrainingEpisodeRecord = {
      index: job.index,
      stageId: job.stageId,
      scenarioId: job.scenarioId,
      seed: job.seed,
      success: run.success,
      status: run.status,
      failureCode: run.failureCode,
      actions: run.metrics.actions,
      wastedActions: run.metrics.wastedActions,
      simulatedSeconds: Math.round(run.simulatedMs / 100) / 10,
      reward: reward === null ? null : Math.round(reward * 1000) / 1000,
      at: now().toISOString(),
    };
    state.recent = [record, ...state.recent].slice(0, RECENT_LIMIT);
    state.totalEpisodes += 1;
    runEpisodes += 1;
    // An episode that was already running when its stage passed still counts in the totals and the record, but not
    // toward the next stage's pass check: that stage was not the one it was planned for.
    const stage = stages[state.stageIndex];
    if (stage && job.stageId === stage.id) {
      state.stageEpisodes += 1;
      if (run.success) state.stageSuccesses += 1;
      const successRate = state.stageEpisodes === 0 ? 0 : state.stageSuccesses / state.stageEpisodes;
      // A configured episodes per stage is the minimum before the pass check; the curriculum's own minimum is a floor.
      // Without a configured value, the curriculum's minimum applies unchanged.
      const minimumEpisodes = configuredPerStage === null ? stage.minEpisodes : Math.max(stage.minEpisodes, configuredPerStage);
      const passed = state.stageEpisodes >= minimumEpisodes && successRate >= stage.passRate;
      const capped = state.stageEpisodes >= minimumEpisodes * 3;
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
    }
    state.updatedAt = now().toISOString();
    options.onEpisode?.({
      record,
      run,
      reward,
      runId: job.runId,
      explorationRate: job.explorationRate,
      workers: batchSize(),
      telemetry,
    });
    await persist(paths, state, now);
  };

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

      // A batch is the next few episodes of the current stage, one per worker. Seeds and scenarios depend only on the
      // episode index, so the same budget gives the same episodes whatever the worker count.
      const stage = stages[state.stageIndex]!;
      const size = Math.min(batchSize(), state.maxEpisodes - state.totalEpisodes);
      const jobs: EpisodeJob[] = [];
      for (let offset = 0; offset < size; offset += 1) {
        const index = state.totalEpisodes + offset;
        const scenarioId = stage.scenarioIds[(state.stageEpisodes + offset) % stage.scenarioIds.length]!;
        const seed = trainingSeed(index);
        jobs.push({
          index,
          stageId: stage.id,
          scenarioId,
          seed,
          worldKey: `train:${scenarioId}:${seed}`,
          runId: `train-${String(index).padStart(6, "0")}`,
          explorationRate,
        });
      }

      const batchStarted = performance.now();
      if (pool) {
        const results = await pool.runBatch(jobs);
        // Results come back in job order; replaying them in that order reproduces a sequential run's learner calls.
        for (const [position, result] of results.entries()) {
          await replayCapture(learner, result.capture);
          await settle(jobs[position]!, result.run, result.reward, result.telemetry);
        }
        const elapsedMs = performance.now() - batchStarted;
        state.activeMs += elapsedMs;
        runActiveMs += elapsedMs;
        const poolStats = pool.stats();
        const perMinute = runActiveMs > 0 ? (runEpisodes / runActiveMs) * 60_000 : 0;
        state.parallel = {
          workers: poolStats.workers,
          episodesPerMinute: Math.round(perMinute * 10) / 10,
          cpuPercent: runActiveMs > 0 ? Math.round((poolStats.totalCpuMs / (runActiveMs * poolStats.workers)) * 1000) / 10 : 0,
          rssMb: poolStats.rssMb,
          peakRssMb: poolStats.peakRssMb,
          respawns: poolStats.respawns,
        };
      } else {
        const job = jobs[0]!;
        const scenario = scenarios.get(job.scenarioId)!;
        const before = learner.rewardTotals;
        const run = await episodeRunner(scenario, job.seed, {
          learner,
          worldKey: job.worldKey,
          runId: job.runId,
          provenance: "training",
          explore: explorationRate > 0 ? { epsilon: explorationRate, seed: job.seed } : null,
        });
        const elapsedMs = performance.now() - batchStarted;
        state.activeMs += elapsedMs;
        runActiveMs += elapsedMs;
        const after = learner.rewardTotals;
        await settle(job, run, after.episodes > before.episodes ? after.sum - before.sum : null, null);
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
  } finally {
    await pool?.close();
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

/**
 * Decides how episodes run. Parallel workers need the simulator runner (the workers load it themselves), and they
 * rebuild the learner from the episode log, so a promoted policy cannot be reproduced there: that case falls back to one
 * worker and says so in the log instead of silently changing what the trainer learns from.
 */
async function choosePool(
  options: TrainingRunOptions,
  learner: ExperienceLearner,
  experienceDirectory: string,
  stages: readonly CurriculumStage[],
  logger: Pick<Logger, "info" | "warn"> | undefined,
): Promise<EpisodePool | null> {
  if (options.episodePool) return options.episodePool;
  const requested = options.workers ?? 1;
  if (!Number.isInteger(requested) || requested < 1 || requested > 8) {
    throw new Error("Workers must be a whole number from 1 through 8.");
  }
  if (requested === 1) return null;
  if (options.episodeRunner) {
    throw new Error("Parallel workers run the simulator in their own processes; a custom episode runner can only run with one worker.");
  }
  if (learner.activeWeights !== null) {
    logger?.warn({ workers: requested }, "A promoted policy is in force; parallel workers cannot reproduce it, so this run uses one worker.");
    return null;
  }
  return createProcessEpisodePool({ workers: requested, stages, experienceDirectory });
}

async function persist(paths: TrainingPaths, state: TrainingState, now: () => Date): Promise<void> {
  state.updatedAt = now().toISOString();
  await writeJsonAtomic(paths.state, state);
}

export async function saveCheckpoint(
  paths: TrainingPaths,
  weights: PolicyWeights,
  stageId: string,
  episodes: number,
  now: () => Date,
): Promise<TrainingCheckpointRecord> {
  const id = `ckpt-${String(episodes).padStart(6, "0")}`;
  const path = `${paths.checkpoints}/${id}.json`;
  const createdAt = now().toISOString();
  const body = { schemaVersion: 1, id, stageId, createdAt, episodes, weights };
  // Never replace an existing checkpoint with different content: it may be the only record of an earlier run.
  const previous = await readFile(path, "utf8").then((text) => JSON.parse(text) as { weights?: unknown }, () => null);
  if (previous !== null && canonicalDigest(previous.weights) !== canonicalDigest(weights)) {
    throw new TrainingDirectoryError(`Checkpoint ${id} already exists with different contents; refusing to overwrite it. Use a fresh start (which archives the old run) or another directory.`);
  }
  // The digest lets evaluation refuse a checkpoint that was edited after it was written.
  await writeJsonAtomic(path, { ...body, digest: canonicalDigest(body) });
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
