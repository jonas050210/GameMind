import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ExperienceLearner } from "./core/learning/learner.js";
import { PROGRESS_DEFINITION } from "./games/minecraft/progress-evidence.js";
import {
  baselinePolicyMetricsFromReport,
  comparePolicyAgainstBaseline,
} from "./testing/eval/policy-comparison.js";
import {
  evaluationScenarios,
  learningEvaluationScenarioIds,
  type EvaluationScenario,
} from "./testing/eval/scenarios.js";
import { evaluationSeeds, runEvaluationSuite, type EvaluationReport } from "./testing/eval/harness.js";

interface EvalOptions {
  readonly seeds: number;
  readonly scenarioId: string | null;
  readonly out: string;
  readonly learning: boolean;
  readonly learningDirectory: string;
}

function parseEvalArgs(args: readonly string[]): EvalOptions {
  let seeds = 20;
  let scenarioId: string | null = null;
  let out = path.join("data", "eval", "offline-report.json");
  let learning = true;
  let learningDirectory = process.env.GAMEMIND_LEARNING_DIR ?? path.join("data", "learning");
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
      case "--learning-dir":
        learningDirectory = value();
        break;
      case "--no-learning":
        learning = false;
        break;
      case "--help":
      case "-h":
        console.log(
    "Usage: npm run eval:offline -- [--seeds N] [--scenario ID] [--out PATH] [--learning-dir PATH] [--no-learning]",
  );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }
  return { seeds, scenarioId, out, learning, learningDirectory };
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
  const seeds = evaluationSeeds(options.seeds);
  const baselineReport = await runEvaluationSuite(scenarios, seeds, undefined, {
    learningScenarioIds: options.learning ? learningEvaluationScenarioIds() : [],
    learningRepetitions: 2,
  });
  const learner = ExperienceLearner.forDirectory(path.resolve(options.learningDirectory));
  await learner.load();
  const candidateWeights = learner.candidateWeights;
  const policyComparison = candidateWeights.source === "experience" && Object.keys(candidateWeights.entries).length > 0
    ? {
        ...(await comparePolicyAgainstBaseline(
          scenarios,
          seeds,
          candidateWeights,
          {},
          baselinePolicyMetricsFromReport(baselineReport),
        )),
        candidatePolicyId: candidateWeights.id,
      }
    : null;
  const report = { ...baselineReport, policyComparison };
  const elapsedMs = Date.now() - started;

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify({ ...report, elapsedMs, offlineSimulationOnly: true, progressDefinition: PROGRESS_DEFINITION }, null, 2)}\n`, "utf8");

  console.log(
    "GameMind offline evaluation — simulated worlds, control logic only. Not a live Minecraft server result.",
  );
  console.log(formatTable(report));
  if (policyComparison) {
    console.log(`\nLearned ranking policy ${candidateWeights.id}: ${policyComparison.decision.promote ? "eligible for promotion" : "promotion held"}.`);
    for (const reason of policyComparison.decision.reasons) console.log(`  ${reason}`);
  } else {
    console.log(`\nNo weighted candidate found in ${path.resolve(options.learningDirectory)}; policy-ranking evaluation was not run.`);
  }
  console.log(
    `\n${report.totals.runs} runs over ${report.seedCount} seeds per scenario in ${(elapsedMs / 1000).toFixed(1)} s; ` +
      `unsafe actions ${report.totals.unsafeActions}, unverified confirmations ${report.totals.unverifiedConfirmations}, deaths ${report.totals.deaths}.`,
  );
  const learning = report.learning ?? [];
  if (learning.length > 0) {
    console.log("\nRepeat-run efficiency (same seeded worlds, one shared experience memory):");
    const learningHeader = ["scenario", "cold act.", "repeat act.", "cold waste", "repeat waste", "success", "gates"];
    const learningRows = learning.map((comparison) => [
      comparison.scenarioId,
      String(comparison.cold.actions),
      String(comparison.repeated.actions),
      String(comparison.cold.wastedActions),
      String(comparison.repeated.wastedActions),
      `${(comparison.repeated.successRate * 100).toFixed(0)}%`,
      comparison.passed ? "pass" : "FAIL",
    ]);
    const widths = learningHeader.map((column, index) =>
      Math.max(column.length, ...learningRows.map((row) => (row[index] ?? "").length)),
    );
    const line = (cells: readonly string[]): string =>
      cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
    console.log(line(learningHeader));
    console.log(line(widths.map((width) => "-".repeat(width))));
    for (const row of learningRows) console.log(line(row));
  }
  console.log(`Report written to ${options.out}.`);
  if (!report.passed) {
    const failing = report.scenarios.filter((scenario) => !scenario.passed);
    for (const scenario of failing) {
      for (const gate of scenario.gates) if (!gate.passed) console.error(`FAILED ${scenario.scenarioId}: ${gate.name} — ${gate.detail}`);
    }
    for (const comparison of report.learning ?? []) {
      if (comparison.passed) continue;
      for (const gate of comparison.gates) {
        if (!gate.passed) console.error(`FAILED learning ${comparison.scenarioId}: ${gate.name} — ${gate.detail}`);
      }
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
