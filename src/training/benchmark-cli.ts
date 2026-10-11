/**
 * npm run train:benchmark -- --name NAME [--candidates 0,0.05,0.15,0.3] [--episodes-per-stage N] [--max-episodes N]
 *   [--seeds N] [--margin 0.02] [--out DIR] [--probe-workers 1,2,3,4|none] [--probe-seconds 20] [--warmup-seconds 5]
 *   [--workers N|auto] [--environment-cases 1..256] [--environment-seconds 20] [--stages A,B] [--defaults-file FILE] [--quiet]
 * First times selected worker counts, then probes each deterministic environment for a timed learning signal, then
 * compares exploration settings using the recommended stages. A 256 × 20 second environment sweep takes about 85 min,
 * in addition to worker probing and candidate training. Nothing starts automatically after training.
 * Use --workers auto to use all CPU cores (default: auto), --probe-workers none to skip worker probing (default: none),
 * --quiet to suppress logging for better performance.
 */
import { runBenchmark, type BenchmarkCandidate, type BenchmarkReport } from "./benchmark.js";
import { TRAINING_STAGES } from "./curriculum.js";
import { saveTrainingDefaults, defaultsPathFor } from "./defaults.js";
import { cpus, platform, totalmem } from "node:os";

const MAX_WORKERS = 8;

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
  if (counts.length === 0 || counts.some((count) => !Number.isInteger(count) || count < 1 || count > MAX_WORKERS)) {
    throw new Error(`--probe-workers needs whole numbers from 1 through ${MAX_WORKERS}, for example 1,2,3,4.`);
  }
  return counts;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const name = flag(argv, "--name");
  if (!name) throw new Error("--name is required.");
  const candidates = parseCandidates(flag(argv, "--candidates") ?? "0,0.05,0.15,0.3");
  const probeWorkers = flag(argv, "--probe-workers") ?? "none";
  const defaultsFile = flag(argv, "--defaults-file") ?? "data/training-defaults.json";
  const environmentCases = Number(flag(argv, "--environment-cases") ?? 13);
  const environmentSecondsPerCase = Number(flag(argv, "--environment-seconds") ?? 20);
  const quiet = argv.includes("--quiet");
  
  // Parse workers - support "auto" to use all CPU cores
  let workers = Number(flag(argv, "--workers") ?? 1);
  const workersArg = flag(argv, "--workers");
  if (workersArg === "auto") {
    const os = await import("node:os");
    workers = Math.min(8, os.cpus().length);
  } else if (workersArg) {
    workers = Number(workersArg);
  }
  if (!Number.isInteger(environmentCases) || environmentCases < 1 || environmentCases > 256) throw new Error("--environment-cases must be a whole number from 1 through 256.");
  if (!Number.isFinite(environmentSecondsPerCase) || environmentSecondsPerCase < 1 || environmentSecondsPerCase > 600) throw new Error("--environment-seconds must be a number from 1 through 600.");
  
  // Track progress for percentage display
  // Total steps = environment probe cases + candidate training runs
  const totalSteps = environmentCases + candidates.length;
  let currentStep = 0;
  
  // Default logger that writes to console for visibility in job output
  const logger = {
    info: quiet ? () => {} : (obj: unknown, msg?: string) => {
      // Count steps for progress calculation
      if (msg?.includes("probe started") || msg?.includes("candidate started")) {
        currentStep++;
      }
      
      // Calculate progress percentage
      const percent = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
      console.log(`[BENCHMARK ${percent}%] ${msg || ""} ${JSON.stringify(obj)}`);
    },
    warn: quiet ? () => {} : (obj: unknown, msg?: string) => {
      console.warn(`[BENCHMARK] ${msg || ""} ${JSON.stringify(obj)}`);
    }
  };

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
    logger,
  });
  
  // Automatically save the best configuration as training defaults
  const outDir = flag(argv, "--out") ?? "data/experiments";
  const defaultsPath = defaultsPathFor(outDir);
  
  // Find the best candidate - use winner if available, otherwise use first candidate's exploration rate or config default
  const bestEntry = report.winner ? report.entries.find(e => e.candidate.id === report.winner) : report.entries[0];
  const winningExplorationRate = bestEntry?.candidate.explorationRate ?? report.config.candidates?.[0]?.explorationRate ?? 0.3;
  const winningWorkers = report.workers;
  const winningStageIds = report.recommendedStageIds ?? report.config.stageIds ?? TRAINING_STAGES.map(s => s.id);
  
  // Get machine info
  const memoryGb = Math.round(totalmem() / (1024 * 1024 * 1024) * 100) / 100;
  
  await saveTrainingDefaults(defaultsPath, {
    schemaVersion: 1,
    workers: winningWorkers,
    explorationRate: winningExplorationRate,
    stageIds: winningStageIds,
    savedAt: new Date().toISOString(),
    benchmark: report.name,
    decision: report.decision,
    probe: null,
    machine: {
      platform: platform(),
      cpus: cpus().length,
      memoryGb: memoryGb,
      node: process.version,
    },
  });
  
  console.log(`\nBenchmark complete. Saved defaults to ${defaultsPath}`);
  console.log(`Configuration: workers=${winningWorkers}, explorationRate=${winningExplorationRate}, stages=[${winningStageIds.join(",")}]`);
  
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
