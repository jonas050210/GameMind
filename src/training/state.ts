import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Persisted training state. It is written after every episode with an atomic rename, so the Control Center
 * and a resumed run both see either the previous or the next state, never a partial file.
 */

export const TRAINING_SCHEMA_VERSION = 1;

export const TRAINING_STATUSES = ["idle", "running", "paused", "stopped", "completed", "failed"] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

const episodeRecordSchema = z.object({
  index: z.number().int().min(0),
  stageId: z.string(),
  scenarioId: z.string(),
  seed: z.number().int(),
  success: z.boolean(),
  status: z.string(),
  failureCode: z.string().nullable(),
  actions: z.number().int().min(0),
  wastedActions: z.number().int().min(0),
  simulatedSeconds: z.number().min(0),
  /** Sum of the per-action reward over the task; null when the learner recorded nothing for it. */
  reward: z.number().nullable(),
  at: z.string(),
});

const checkpointRecordSchema = z.object({
  id: z.string(),
  stageId: z.string(),
  createdAt: z.string(),
  episodes: z.number().int().min(0),
  weightsId: z.string(),
  weightedContexts: z.number().int().min(0),
  path: z.string(),
});

const evaluationSummarySchema = z.object({
  checkpointId: z.string(),
  generatedAt: z.string(),
  reportPath: z.string(),
  verdict: z.enum(["promotable", "not-promotable"]),
  reasons: z.array(z.string()),
  successRate: z.object({ baseline: z.number(), candidate: z.number() }),
});

export const trainingStateSchema = z.object({
  schemaVersion: z.literal(TRAINING_SCHEMA_VERSION),
  status: z.enum(TRAINING_STATUSES),
  /** Operator intent written by the Control Center or CLI; the trainer reads it between episodes. */
  control: z.enum(["run", "pause", "stop"]),
  stageIndex: z.number().int().min(0),
  stageEpisodes: z.number().int().min(0),
  stageSuccesses: z.number().int().min(0),
  totalEpisodes: z.number().int().min(0),
  episodesPerStage: z.number().int().min(1),
  maxEpisodes: z.number().int().min(1),
  seedBase: z.number().int(),
  startedAt: z.string(),
  updatedAt: z.string(),
  pid: z.number().int().nullable(),
  lastError: z.string().nullable(),
  recent: z.array(episodeRecordSchema).max(50),
  checkpoints: z.array(checkpointRecordSchema),
  lastEvaluation: evaluationSummarySchema.nullable(),
});

export type TrainingState = z.infer<typeof trainingStateSchema>;
export type TrainingEpisodeRecord = z.infer<typeof episodeRecordSchema>;
export type TrainingCheckpointRecord = z.infer<typeof checkpointRecordSchema>;
export type TrainingEvaluationSummary = z.infer<typeof evaluationSummarySchema>;

export interface TrainingPaths {
  readonly root: string;
  readonly state: string;
  readonly control: string;
  readonly experience: string;
  readonly checkpoints: string;
  readonly evaluations: string;
  readonly log: string;
}

export function trainingPaths(root: string): TrainingPaths {
  return {
    root,
    state: join(root, "state.json"),
    control: join(root, "control.json"),
    experience: join(root, "experience"),
    checkpoints: join(root, "checkpoints"),
    evaluations: join(root, "evaluations"),
    log: join(root, "logs", "train.log"),
  };
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function readTrainingState(paths: TrainingPaths): Promise<TrainingState | null> {
  let raw: string;
  try {
    raw = await readFile(paths.state, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return trainingStateSchema.parse(JSON.parse(raw));
}

export async function readControlCommand(paths: TrainingPaths): Promise<"run" | "pause" | "stop"> {
  try {
    const parsed = JSON.parse(await readFile(paths.control, "utf8")) as { command?: unknown };
    return parsed.command === "pause" || parsed.command === "stop" ? parsed.command : "run";
  } catch {
    return "run";
  }
}

export async function writeControlCommand(paths: TrainingPaths, command: "run" | "pause" | "stop"): Promise<void> {
  await writeJsonAtomic(paths.control, { command, requestedAt: new Date().toISOString() });
}
