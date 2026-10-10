/**
 * npm run train:experiment -- --name NAME [--episodes-per-stage N] [--max-episodes N] [--explore RATE] [--seeds N] [--out DIR]
 * Runs one headless experiment on the offline simulator and prints a short summary. Never overwrites an existing name.
 */
import { runHeadlessExperiment } from "./experiment.js";

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const name = flag(argv, "--name");
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("--name is required (letters, digits, '.', '_', '-').");
  const episodesPerStage = Number(flag(argv, "--episodes-per-stage") ?? 12);
  const maxEpisodes = Number(flag(argv, "--max-episodes") ?? 96);
  const explorationRate = Number(flag(argv, "--explore") ?? 0.2);
  const seeds = Number(flag(argv, "--seeds") ?? 10);
  if (!(explorationRate >= 0 && explorationRate <= 1)) throw new Error("--explore must be between 0 and 1.");
  const report = await runHeadlessExperiment({
    name,
    outDir: flag(argv, "--out") ?? "data/experiments",
    episodesPerStage,
    maxEpisodes,
    explorationRate,
    evaluationSeeds: seeds,
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
