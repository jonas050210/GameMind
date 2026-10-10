/**
 * npm run train:benchmark -- --name NAME [--candidates 0,0.05,0.15,0.3] [--episodes-per-stage N] [--max-episodes N]
 *   [--seeds N] [--margin 0.02] [--out DIR]
 * Compares several exploration settings under the same budget on the offline simulator and prints the report.
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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const name = flag(argv, "--name");
  if (!name) throw new Error("--name is required.");
  const candidates = parseCandidates(flag(argv, "--candidates") ?? "0,0.05,0.15,0.3");
  const report = await runBenchmark({
    name,
    outDir: flag(argv, "--out") ?? "data/experiments",
    candidates,
    episodesPerStage: Number(flag(argv, "--episodes-per-stage") ?? 12),
    maxEpisodes: Number(flag(argv, "--max-episodes") ?? 96),
    evaluationSeeds: Number(flag(argv, "--seeds") ?? 10),
    margin: Number(flag(argv, "--margin") ?? 0.02),
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
