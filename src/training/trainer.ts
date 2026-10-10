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
      const explorationRate = options.explorationRate ?? 0;
      const run = await episodeRunner(scenario, seed, {
        learner,
        worldKey: `train:${scenario.id}:${seed}`,
        runId: `train-${String(state.totalEpisodes).padStart(6, "0")}`,
        provenance: "training",
        explore: explorationRate > 0 ? { epsilon: explorationRate, seed } : null,
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
