/**
 * npm run train:benchmark -- --name NAME [--candidates 0,0.05,0.15,0.3] [--episodes-per-stage N] [--max-episodes N]
 *   [--seeds N] [--margin 0.02] [--out DIR] [--probe-workers 1,2,3,4|none] [--probe-seconds 20] [--warmup-seconds 5]
 *   [--workers N] [--defaults-file FILE]
 * First times each worker count (short run each), then compares several exploration settings under the same budget on
 * the offline simulator. The winning settings are saved as the default unless --defaults-file is "none".
 */
import { runBenchmark, type BenchmarkCandidate } from "./benchmark.js";

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function parseCandidates(raw: string): BenchmarkCandidate[] {
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0).map((rate) => {
    const value = Number(rate);
    if (!Number.isFinite(value)) throw new Error(`'${rate}' is not a number in --candidates.`);
    return { id: `explore-${rate.replace(".", "_")}`, explorationRate: value };
  });
}

function parseWorkerCounts(raw: string): number[] {
  const counts = raw.split(",").map((part) => Number(part.trim()));
  if (counts.length === 0 || counts.some((count) => !Number.isInteger(count) || count < 1 || count > 8)) {
    throw new Error("--probe-workers needs whole numbers from 1 through 8, for example 1,2,3,4.");
  }
  return counts;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const name = flag(argv, "--name");
  if (!name) throw new Error("--name is required.");
  const candidates = parseCandidates(flag(argv, "--candidates") ?? "0,0.05,0.15,0.3");
  const probeWorkers = flag(argv, "--probe-workers") ?? "1,2,3,4";
  const defaultsFile = flag(argv, "--defaults-file") ?? "data/training-defaults.json";
  const report = await runBenchmark({
    name,
    outDir: flag(argv, "--out") ?? "data/experiments",
    candidates,
    episodesPerStage: Number(flag(argv, "--episodes-per-stage") ?? 12),
    maxEpisodes: Number(flag(argv, "--max-episodes") ?? 96),
    evaluationSeeds: Number(flag(argv, "--seeds") ?? 10),
    margin: Number(flag(argv, "--margin") ?? 0.02),
    workers: Number(flag(argv, "--workers") ?? 1),
    ...(probeWorkers === "none"
      ? {}
      : {
          probe: {
            workerCounts: parseWorkerCounts(probeWorkers),
            seconds: Number(flag(argv, "--probe-seconds") ?? 20),
            warmupSeconds: Number(flag(argv, "--warmup-seconds") ?? 5),
          },
        }),
    ...(defaultsFile === "none" ? {} : { defaultsFile }),
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
