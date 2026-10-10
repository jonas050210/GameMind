/**
 * The saved default for training: how many workers run episodes at once and which exploration rate to use. The
 * benchmark writes it when it finishes; the trainer and the Control Center read it when a run does not say otherwise.
 * It sits next to the training folders, so it is shared by all of them. Earlier versions are archived, never deleted.
 */
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "./state.js";

export const TRAINING_DEFAULTS_FILE = "training-defaults.json";

const probeSummarySchema = z.object({
  workers: z.number().int().min(1).max(8),
  status: z.enum(["measured", "failed"]),
  episodesPerMinute: z.number().min(0),
  cpuPercent: z.number().min(0),
  peakRssMb: z.number().min(0),
  respawns: z.number().int().min(0),
  eligible: z.boolean(),
  reason: z.string(),
});

export const trainingDefaultsSchema = z.object({
  schemaVersion: z.literal(1),
  workers: z.number().int().min(1).max(8),
  explorationRate: z.number().min(0).max(1),
  savedAt: z.string(),
  /** Benchmark that produced this default, or null when it was set by hand. */
  benchmark: z.string().nullable(),
  decision: z.string(),
  probe: z.array(probeSummarySchema).nullable(),
  machine: z.object({
    platform: z.string(),
    cpus: z.number().int().min(1),
    memoryGb: z.number().min(0),
    node: z.string(),
  }),
});

export type TrainingDefaults = z.infer<typeof trainingDefaultsSchema>;
export type ProbeSummary = z.infer<typeof probeSummarySchema>;

export function defaultsPathFor(dataDirectory: string): string {
  return join(dataDirectory, TRAINING_DEFAULTS_FILE);
}

/** Null when no default was saved yet. A file that exists but cannot be read is an error, not a silent fallback. */
export async function readTrainingDefaults(path: string): Promise<TrainingDefaults | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The saved training default in ${path} is not valid JSON. Run the benchmark again or delete the file.`);
  }
  const result = trainingDefaultsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`The saved training default in ${path} does not match the expected format. Run the benchmark again or delete the file.`);
  }
  return result.data;
}

/** Archives the previous default (never deletes it), then writes the new one atomically. */
export async function saveTrainingDefaults(path: string, defaults: TrainingDefaults): Promise<{ readonly archivedAs: string | null }> {
  trainingDefaultsSchema.parse(defaults);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  let archivedAs: string | null = null;
  // Archive whatever is there, even a file this version cannot parse: it may be the only record of an earlier choice.
  const existing = await stat(path).then(() => true, () => false);
  if (existing) {
    const historyDir = join(directory, "training-defaults-history");
    await mkdir(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    archivedAs = join(historyDir, `defaults-${stamp}.json`);
    await rename(path, archivedAs);
  }
  await writeJsonAtomic(path, defaults);
  return { archivedAs };
}

/** Lists archived defaults, newest first. Used by the Control Center to show what changed. */
export async function listArchivedDefaults(path: string): Promise<string[]> {
  const historyDir = join(dirname(path), "training-defaults-history");
  try {
    return (await readdir(historyDir)).filter((name) => name.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
}
