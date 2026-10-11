/**
 * Short throughput test for each worker count: one headless training run per count, a fixed wall-clock time, the first
 * seconds discarded as warm-up. It measures speed and stability only. Learning quality is decided by the benchmark's
 * gated experiments, not by this probe.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cpus, totalmem } from "node:os";
import type { Logger } from "pino";
import { DEFAULT_TRAINING_EXPLORATION_RATE, TRAINING_STAGES, type CurriculumStage } from "./curriculum.js";
import { runTraining, type TrainingEpisodeEvent } from "./trainer.js";

export interface ProbeOptions {
  readonly workerCounts: readonly number[];
  /** Total wall-clock time per count, warm-up included. */
  readonly seconds: number;
  /** Leading seconds that are not measured (process start, first episodes, scenario loading). */
  readonly warmupSeconds: number;
  readonly workDir: string;
  readonly stages?: readonly CurriculumStage[];
  /** Share of total system memory a probe may use before it counts as unstable. */
  readonly memoryLimitShare?: number;
  readonly logger?: Pick<Logger, "info" | "warn" | "error">;
}

export interface ProbeResult {
  readonly workers: number;
  readonly status: "measured" | "failed";
  readonly episodesMeasured: number;
  readonly measuredSeconds: number;
  readonly episodesPerMinute: number;
  readonly cpuPercent: number;
  /** Workers plus this process, the highest resident memory seen during the probe. */
  readonly peakRssMb: number;
  readonly respawns: number;
  readonly error: string | null;
  readonly eligible: boolean;
  readonly reason: string;
}

/** Share of a worker's throughput we accept from a smaller count before preferring it (fewer processes, less memory). */
export const WORKER_TOLERANCE = 0.9;
const MEMORY_LIMIT_SHARE = 0.8;

export async function probeWorkerCounts(options: ProbeOptions): Promise<ProbeResult[]> {
  if (!(options.seconds > 0) || !(options.warmupSeconds >= 0) || options.warmupSeconds >= options.seconds) {
    throw new Error("The probe needs a positive time and a warm-up shorter than that time.");
  }
  const results: ProbeResult[] = [];
  for (const workers of options.workerCounts) {
    options.logger?.info({ workers, seconds: options.seconds }, "throughput probe started");
    results.push(await probeOne(workers, options));
  }
  return results;
}

async function probeOne(workers: number, options: ProbeOptions): Promise<ProbeResult> {
  const root = join(options.workDir, `probe-${workers}-workers`);
  await rm(root, { recursive: true, force: true });
  const stages = options.stages ?? TRAINING_STAGES;
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const samples: { readonly at: number }[] = [];
  let mainPeakMb = 0;
  let error: string | null = null;
  let parallel: { cpuPercent: number; peakRssMb: number; respawns: number } | null = null;

  try {
    const state = await runTraining({
      root,
      stages,
      // A stage that could pass within the probe window would end it early, so the probe runs one stage's worth of
      // episodes at its steady state.
      episodesPerStage: 1000,
      maxEpisodes: 100_000,
      maxMinutes: options.seconds / 60,
      explorationRate: DEFAULT_TRAINING_EXPLORATION_RATE,
      workers,
      pollMs: 50,
      ...(options.logger ? { logger: options.logger } : {}),
      onEpisode: (event: TrainingEpisodeEvent) => {
        samples.push({ at: performance.now() });
        mainPeakMb = Math.max(mainPeakMb, process.memoryUsage().rss / 1048576);
      },
    });
    if (state.status === "failed") error = state.lastError ?? "The probe run failed.";
    if (state.parallel) parallel = { cpuPercent: state.parallel.cpuPercent, peakRssMb: state.parallel.peakRssMb, respawns: state.parallel.respawns };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const ended = performance.now();
  const mainCpu = process.cpuUsage(cpuStart);
  // With workers, the pool reports its own CPU share. A single worker runs in this process, so measure it here.
  const processCpuPercent = Math.round(((mainCpu.user + mainCpu.system) / 1000 / Math.max(1, ended - started) / cpus().length) * 1000) / 10;
  const warmupEnd = started + options.warmupSeconds * 1000;
  let measured = samples.filter((sample) => sample.at >= warmupEnd);
  let windowStart = warmupEnd;
  if (measured.length < 2) {
    // Too few episodes after the warm-up to measure: use the whole window and say so in the reason.
    measured = samples;
    windowStart = started;
  }
  const measuredSeconds = Math.max(0.001, (ended - windowStart) / 1000);
  const episodesPerMinute = Math.round((measured.length / measuredSeconds) * 600) / 10;
  const peakRssMb = Math.round(((parallel?.peakRssMb ?? 0) + mainPeakMb) * 10) / 10;
  const respawns = parallel?.respawns ?? 0;
  const memoryLimitMb = totalmem() / 1048576 * (options.memoryLimitShare ?? MEMORY_LIMIT_SHARE);

  let reason: string;
  let eligible = true;
  if (error) {
    eligible = false;
    reason = `Failed: ${error}`;
  } else if (measured.length === 0) {
    eligible = false;
    reason = "No episode finished within the probe window.";
  } else if (respawns > 0) {
    eligible = false;
    reason = `${respawns} worker(s) crashed and had to be replaced; not stable enough to use.`;
  } else if (peakRssMb > memoryLimitMb) {
    eligible = false;
    reason = `Peak memory ${Math.round(peakRssMb)} MB is above the ${Math.round(memoryLimitMb)} MB limit.`;
  } else {
    reason = windowStart === started ? "Measured without warm-up discard (too few episodes after it)." : "Measured after warm-up.";
  }

  return {
    workers,
    status: error ? "failed" : "measured",
    episodesMeasured: measured.length,
    measuredSeconds: Math.round(measuredSeconds * 10) / 10,
    episodesPerMinute,
    cpuPercent: parallel?.cpuPercent ?? processCpuPercent,
    peakRssMb,
    respawns,
    error,
    eligible,
    reason,
  };
}

/**
 * The smallest worker count whose throughput is within `tolerance` of the best eligible one. Fewer workers with nearly
 * the same speed are the better choice: less memory, fewer processes, less to go wrong. Null when nothing is eligible.
 */
export function chooseWorkerCount(results: readonly ProbeResult[], tolerance = WORKER_TOLERANCE): number | null {
  const eligible = results.filter((result) => result.eligible && result.episodesPerMinute > 0);
  if (eligible.length === 0) return null;
  const best = Math.max(...eligible.map((result) => result.episodesPerMinute));
  const acceptable = eligible.filter((result) => result.episodesPerMinute >= best * tolerance);
  return Math.min(...acceptable.map((result) => result.workers));
}
