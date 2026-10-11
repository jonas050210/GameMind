/**
 * npm run train:benchmark -- --name NAME [--candidates 0,0.05,0.15,0.3] [--episodes-per-stage N] [--max-episodes N]
 *   [--seeds N] [--margin 0.02] [--out DIR] [--probe-workers 1,2,3,4|none] [--probe-seconds 20] [--warmup-seconds 5]
 *   [--workers N] [--environment-cases 1..256] [--environment-seconds 20] [--stages A,B] [--defaults-file FILE]
 * First times selected worker counts, then probes each deterministic environment for a timed learning signal, then
 * compares exploration settings using the recommended stages. A 256 × 20 second environment sweep takes about 85 min,
 * in addition to worker probing and candidate training. Nothing starts automatically after training.
 */
import { runBenchmark, type BenchmarkCandidate } from "./benchmark.js";
import { TRAINING_STAGES } from "./curriculum.js";

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

function parseStageIds(raw: string): string[] {
  const ids = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const known = new Set(TRAINING_STAGES.map((stage) => stage.id));
  if (ids.length === 0 || ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) {
    throw new Error("--stages needs unique known stage ids: basics,food,tools-and-shelter.");
  }
  return ids;
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
  const environmentCases = Number(flag(argv, "--environment-cases") ?? 13);
  const environmentSecondsPerCase = Number(flag(argv, "--environment-seconds") ?? 20);
  if (!Number.isInteger(environmentCases) || environmentCases < 1 || environmentCases > 256) throw new Error("--environment-cases must be a whole number from 1 through 256.");
  if (!Number.isFinite(environmentSecondsPerCase) || environmentSecondsPerCase < 1 || environmentSecondsPerCase > 600) throw new Error("--environment-seconds must be a number from 1 through 600.");
  const report = await runBenchmark({
    name,
    outDir: flag(argv, "--out") ?? "data/experiments",
    candidates,
    episodesPerStage: Number(flag(argv, "--episodes-per-stage") ?? 12),
    maxEpisodes: Number(flag(argv, "--max-episodes") ?? 96),
    evaluationSeeds: Number(flag(argv, "--seeds") ?? 10),
    margin: Number(flag(argv, "--margin") ?? 0.02),
    ...(flag(argv, "--stages") ? { stageIds: parseStageIds(flag(argv, "--stages") as string) } : {}),
    environmentCases,
    environmentSecondsPerCase,
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
