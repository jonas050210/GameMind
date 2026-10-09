import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluationScenarios, type EvaluationScenario } from "./testing/eval/scenarios.js";
import { evaluationSeeds, runEvaluationSuite, type EvaluationReport } from "./testing/eval/harness.js";

interface EvalOptions {
  readonly seeds: number;
  readonly scenarioId: string | null;
  readonly out: string;
}

function parseEvalArgs(args: readonly string[]): EvalOptions {
  let seeds = 20;
  let scenarioId: string | null = null;
  let out = path.join("data", "eval", "offline-report.json");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    const value = (): string => {
      if (!next || next.startsWith("--")) throw new Error(`Option '${arg}' requires a value.`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--seeds":
        seeds = Number(value());
        if (!Number.isInteger(seeds) || seeds < 1 || seeds > 200) {
          throw new Error("--seeds must be an integer from 1 through 200.");
        }
        break;
      case "--scenario":
        scenarioId = value();
        break;
      case "--out":
        out = value();
        break;
      case "--help":
      case "-h":
        console.log("Usage: npm run eval:offline -- [--seeds N] [--scenario ID] [--out PATH]");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }
  return { seeds, scenarioId, out };
}

function formatTable(report: EvaluationReport): string {
  const header = ["scenario", "family", "expect", "success", "safe", "unsafe", "deaths", "med.actions", "med.sim-s", "gates"];
  const rows = report.scenarios.map((scenario) => [
    scenario.scenarioId,
    scenario.family,
    scenario.expectation,
    scenario.expectation === "success" ? `${(scenario.successRate * 100).toFixed(0)}%` : "n/a",
    `${(scenario.safeRate * 100).toFixed(0)}%`,
    String(scenario.unsafeActions),
    String(scenario.deaths),
    String(scenario.medianActions),
    String(scenario.medianSimulatedSeconds),
    scenario.passed ? "pass" : "FAIL",
  ]);
  const widths = header.map((column, index) => Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length)));
  const line = (cells: readonly string[]): string => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

async function main(): Promise<void> {
  const options = parseEvalArgs(process.argv.slice(2));
  const scenarios: EvaluationScenario[] = evaluationScenarios().filter(
    (scenario) => options.scenarioId === null || scenario.id === options.scenarioId,
  );
  if (scenarios.length === 0) throw new Error(`Unknown scenario '${options.scenarioId}'.`);

  const started = Date.now();
  const report = await runEvaluationSuite(scenarios, evaluationSeeds(options.seeds));
  const elapsedMs = Date.now() - started;

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify({ ...report, elapsedMs, offlineSimulationOnly: true }, null, 2)}\n`, "utf8");

  console.log(
    "GameMind offline evaluation — simulated worlds, control logic only. Not a live Minecraft server result.",
  );
  console.log(formatTable(report));
  console.log(
    `\n${report.totals.runs} runs over ${report.seedCount} seeds per scenario in ${(elapsedMs / 1000).toFixed(1)} s; ` +
      `unsafe actions ${report.totals.unsafeActions}, unverified confirmations ${report.totals.unverifiedConfirmations}, deaths ${report.totals.deaths}.`,
  );
  console.log(`Report written to ${options.out}.`);
  if (!report.passed) {
    const failing = report.scenarios.filter((scenario) => !scenario.passed);
    for (const scenario of failing) {
      for (const gate of scenario.gates) if (!gate.passed) console.error(`FAILED ${scenario.scenarioId}: ${gate.name} — ${gate.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
