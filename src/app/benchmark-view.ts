/**
 * Reads the benchmark reports written by `npm run train:benchmark` (data/experiments/benchmarks/<name>.json) for the
 * Training tab. Read-only; a damaged file is listed as unreadable instead of hiding the others.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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

export interface BenchmarkSummary {
  readonly name: string;
  readonly file: string;
  readonly createdAt: string | null;
  readonly winner: string | null;
  readonly decision: string | null;
  readonly rows: readonly BenchmarkRow[];
  readonly unreadable: boolean;
}

export interface BenchmarkListing {
  readonly directory: string;
  readonly reports: readonly BenchmarkSummary[];
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function summarizeBenchmark(file: string, raw: unknown): BenchmarkSummary {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return {
    name: text(data.name) ?? path.basename(file, ".json"),
    file: path.basename(file),
    createdAt: text(data.createdAt),
    winner: text(data.winner),
    decision: text(data.decision),
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

export async function readBenchmarkListing(experimentsDirectory: string, limit = 5): Promise<BenchmarkListing> {
  const directory = path.join(experimentsDirectory, "benchmarks");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return { directory, reports: [] };
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
      reports.push({ name: path.basename(item.full, ".json"), file: path.basename(item.full), createdAt: null, winner: null, decision: null, rows: [], unreadable: true });
    }
  }
  return { directory, reports };
}
