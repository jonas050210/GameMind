/**
 * Reads the benchmark reports written by `npm run train:benchmark` (data/experiments/benchmarks/<name>.json) for the
 * Training tab. Read-only; a damaged file is listed as unreadable instead of hiding the others.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readTrainingDefaults, type TrainingDefaults } from "../training/defaults.js";

export interface BenchmarkRow {
  readonly explorationRate: number | null;
  readonly id: string;
  readonly status: string;
  readonly baselineSuccess: number | null;
  readonly trainedSuccess: number | null;
  readonly deltaPoints: number | null;
  readonly gateVerdict: string | null;
  readonly error: string | null;
}

export interface BenchmarkProbeRow {
  readonly workers: number;
  readonly status: string;
  readonly episodesPerMinute: number | null;
  readonly cpuPercent: number | null;
  readonly peakRssMb: number | null;
  readonly eligible: boolean;
  readonly reason: string | null;
}

export interface BenchmarkSummary {
  readonly name: string;
  readonly file: string;
  readonly createdAt: string | null;
  readonly winner: string | null;
  readonly decision: string | null;
  /** Worker count every candidate ran with; null for reports written before the probe existed. */
  readonly workers: number | null;
  readonly probe: readonly BenchmarkProbeRow[] | null;
  readonly rows: readonly BenchmarkRow[];
  readonly unreadable: boolean;
}

export interface SavedDefaultView {
  readonly workers: number;
  readonly explorationRate: number;
  readonly savedAt: string;
  readonly benchmark: string | null;
  readonly decision: string;
}

export interface BenchmarkListing {
  readonly directory: string;
  readonly reports: readonly BenchmarkSummary[];
  /** What a run uses when it does not say otherwise; null when no benchmark has saved one yet. */
  readonly savedDefault: SavedDefaultView | null;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const bool = (value: unknown): boolean => value === true;

export function summarizeBenchmark(file: string, raw: unknown): BenchmarkSummary {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const probeEntries = Array.isArray(data.probe) ? data.probe : null;
  return {
    name: text(data.name) ?? path.basename(file, ".json"),
    file: path.basename(file),
    createdAt: text(data.createdAt),
    winner: text(data.winner),
    decision: text(data.decision),
    workers: num(data.workers),
    probe: probeEntries
      ? probeEntries.map((entry): BenchmarkProbeRow => {
          const p = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
          return {
            workers: num(p.workers) ?? 0,
            status: text(p.status) ?? "unknown",
            episodesPerMinute: num(p.episodesPerMinute),
            cpuPercent: num(p.cpuPercent),
            peakRssMb: num(p.peakRssMb),
            eligible: bool(p.eligible),
            reason: text(p.reason),
          };
        })
      : null,
    unreadable: false,
    rows: entries.map((entry): BenchmarkRow => {
      const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const candidate = (typeof e.candidate === "object" && e.candidate !== null ? e.candidate : {}) as Record<string, unknown>;
      const experiment = (typeof e.experiment === "object" && e.experiment !== null ? e.experiment : {}) as Record<string, unknown>;
      return {
        explorationRate: num(candidate.explorationRate),
        id: text(candidate.id) ?? "candidate",
        status: text(e.status) ?? "unknown",
        baselineSuccess: num(experiment.baselineSuccess),
        trainedSuccess: num(experiment.trainedSuccess),
        deltaPoints: num(experiment.deltaPoints),
        gateVerdict: text(experiment.gateVerdict),
        error: text(e.error),
      };
    }),
  };
}

function savedDefaultView(defaults: TrainingDefaults | null): SavedDefaultView | null {
  if (!defaults) return null;
  return {
    workers: defaults.workers,
    explorationRate: defaults.explorationRate,
    savedAt: defaults.savedAt,
    benchmark: defaults.benchmark,
    decision: defaults.decision,
  };
}

export async function readBenchmarkListing(experimentsDirectory: string, limit = 5, defaultsFile?: string): Promise<BenchmarkListing> {
  const directory = path.join(experimentsDirectory, "benchmarks");
  // A damaged default is shown as absent here; the training start itself reports the problem with a message.
  const savedDefault = defaultsFile ? savedDefaultView(await readTrainingDefaults(defaultsFile).catch(() => null)) : null;
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return { directory, reports: [], savedDefault };
  }
  const withTime = await Promise.all(
    names.map(async (name) => {
      const full = path.join(directory, name);
      const info = await stat(full).catch(() => null);
      return { full, mtime: info?.mtimeMs ?? 0 };
    }),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  const reports: BenchmarkSummary[] = [];
  for (const item of withTime.slice(0, limit)) {
    try {
      reports.push(summarizeBenchmark(item.full, JSON.parse(await readFile(item.full, "utf8"))));
    } catch {
      reports.push({ name: path.basename(item.full, ".json"), file: path.basename(item.full), createdAt: null, winner: null, decision: null, workers: null, probe: null, rows: [], unreadable: true });
    }
  }
  return { directory, reports, savedDefault };
}
