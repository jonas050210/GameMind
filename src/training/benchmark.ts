/**
 * Headless training benchmark, offline simulator only. Several exploration settings are trained under the same
 * budget, each as one reproducible experiment, and then compared on the same held-out seeds against the untrained
 * baseline. A candidate can become the default only when the existing gate says it is promotable AND it beats the
 * baseline by at least the configured margin. Otherwise the benchmark names no winner and the baseline stays.
 *
 * The benchmark never overwrites an earlier benchmark or experiment name.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runHeadlessExperiment, type HeadlessExperimentReport } from "./experiment.js";

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
  readonly logger?: { info(obj: unknown, msg?: string): void };
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
  readonly entries: readonly BenchmarkEntry[];
  readonly winner: string | null;
  readonly decision: string;
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

/** Runs every candidate under the same budget and writes one benchmark report. Never overwrites an existing name. */
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

  const outDir = options.outDir ?? "data/experiments";
  const reportPath = join(outDir, "benchmarks", `${options.name}.json`);
  try {
    await stat(reportPath);
    throw new Error(`Benchmark ${reportPath} already exists. Choose a new name; earlier benchmarks are never overwritten.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }

  const entries: BenchmarkEntry[] = [];
  for (const candidate of options.candidates) {
    const experimentName = `${options.name}--${candidate.id}`;
    const directory = join(outDir, experimentName);
    options.logger?.info({ candidate: candidate.id, experiment: experimentName }, "benchmark candidate started");
    try {
      const report = await runHeadlessExperiment({
        name: experimentName,
        outDir,
        episodesPerStage: options.episodesPerStage,
        maxEpisodes: options.maxEpisodes,
        explorationRate: candidate.explorationRate,
        evaluationSeeds: options.evaluationSeeds,
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
  const { logger: _logger, ...config } = options;
  const report: BenchmarkReport = {
    name: options.name,
    createdAt: new Date().toISOString(),
    config,
    entries,
    winner,
    decision,
  };
  await mkdir(join(outDir, "benchmarks"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}
