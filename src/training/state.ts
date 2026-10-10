import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/atomic-file.js";

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
  /** What the comparison actually established; see `EvaluationConclusion`. Absent in older reports. */
  conclusion: z.string().optional(),
  learnedContexts: z.number().int().min(0).optional(),
  behaviourChangedRuns: z.number().int().min(0).optional(),
  pairedRuns: z.number().int().min(0).optional(),
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
  /** Wall-clock time spent inside episodes across all invocations. Pauses and waits are not counted. */
  activeMs: z.number().min(0).default(0),
  /** Optional time budget for the whole run, in minutes. Checked between episodes. */
  maxMinutes: z.number().positive().nullable().default(null),
  /** Why the run last stopped, for the operator. Null while running. */
  stopReason: z.string().nullable().default(null),
  /**
   * Ids of the curriculum stages this run was started with, in order. `stageIndex` indexes into this list, so a run
   * can only be resumed with the same stages. Absent in runs written before stage selection existed (the default stages).
   */
  stageIds: z.array(z.string()).optional(),
  /** Exploration rate this run last used, so the operator can see how its experience was collected. */
  explorationRate: z.number().min(0).max(1).optional(),
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
  readonly lock: string;
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
    lock: join(root, "training.lock"),
  };
}

/** SHA-256 over a canonical (key-sorted) JSON encoding, so the digest survives re-serialisation. */
export function canonicalDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export interface ArchiveResult {
  readonly archiveDir: string | null;
  readonly moved: readonly string[];
}

/**
 * Moves the existing training artifacts (state, control file, experience, checkpoints, evaluations) into a new
 * timestamped archive directory with a manifest. Nothing is deleted: a fresh start is a new run, and the old run
 * stays inspectable and can be restored by moving it back.
 */
export async function archiveTrainingArtifacts(paths: TrainingPaths, now: Date, reason: string): Promise<ArchiveResult> {
  const candidates = [paths.state, paths.control, paths.experience, paths.checkpoints, paths.evaluations];
  const present: string[] = [];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      present.push(candidate);
    } catch {
      // absent: nothing to archive for this artifact
    }
  }
  if (present.length === 0) return { archiveDir: null, moved: [] };
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(paths.root, "archive", `${stamp}-before-fresh`);
  await mkdir(archiveDir, { recursive: true });
  const moved: string[] = [];
  for (const source of present) {
    const target = join(archiveDir, basename(source));
    await rename(source, target);
    moved.push(basename(source));
  }
  await writeJsonAtomic(join(archiveDir, "manifest.json"), {
    schemaVersion: 1,
    archivedAt: now.toISOString(),
    reason,
    moved,
  });
  return { archiveDir, moved };
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
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
