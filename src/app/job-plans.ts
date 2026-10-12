import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseTapSummary, readLiveReportSummary, type JobSpec } from "./jobs.js";

/**
 * Turns "run the offline tests / the offline evaluation / the live verification" into a concrete child process.
 * Every plan runs the project's own TypeScript entry points through the locally installed `tsx`, started with
 * the current Node binary: no shell, no `npm.cmd` shim, no PATH lookup, and therefore the same behaviour on
 * Linux, macOS, Windows and WSL.
 */

export interface PlanContext {
  readonly root: string;
  /** Where reports and evidence go; always inside the project's data directory. */
  readonly dataDirectory: string;
}

export class JobPlanError extends Error {
  constructor(
    readonly code: "DEPENDENCIES_MISSING" | "INVALID_OPTION" | "CONFIRMATION_REQUIRED" | "NOTHING_TO_RUN",
    message: string,
  ) {
    super(message);
    this.name = "JobPlanError";
  }
}

function tsxCli(root: string): string {
  const cli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) {
    throw new JobPlanError("DEPENDENCIES_MISSING", "The project dependencies are not installed (node_modules/tsx is missing). Run 'npm ci' in the project folder first.");
  }
  return cli;
}

function relative(root: string, target: string): string {
  const value = path.relative(root, target);
  return (value.length === 0 ? "." : value).split(path.sep).join("/");
}

/** The full offline unit/integration/regression suite, exactly what `npm test` runs. */
export function planUnitTests(context: PlanContext): JobSpec {
  const cli = tsxCli(context.root);
  const testDirectory = path.join(context.root, "test");
  const files = existsSync(testDirectory)
    ? readdirSync(testDirectory).filter((name) => name.endsWith(".test.ts")).sort().map((name) => path.join("test", name))
    : [];
  if (files.length === 0) throw new JobPlanError("NOTHING_TO_RUN", "No test files were found in the test directory.");
  return {
    kind: "unit-tests",
    label: "Offline unit and integration tests",
    source: "offline",
    command: process.execPath,
    args: [cli, "--test", "--test-reporter=tap", ...files],
    cwd: context.root,
    timeoutMs: 20 * 60_000,
    display: `tsx --test (${files.length} files)`,
    meta: { files: files.length, world: "simulated" },
    summarise: (output) => parseTapSummary(output),
  };
}

export interface EvalPlanOptions {
  readonly seeds?: number;
  readonly scenarioId?: string | null;
}

/** The offline simulator evaluation. It reads `data/learning` for the candidate comparison but never writes it. */
export function planOfflineEval(context: PlanContext, options: EvalPlanOptions = {}): JobSpec {
  const cli = tsxCli(context.root);
  const seeds = options.seeds ?? 20;
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > 200) throw new JobPlanError("INVALID_OPTION", "Seeds per scenario must be a whole number from 1 to 200.");
  const scenario = options.scenarioId ?? null;
  if (scenario !== null && !/^[a-z0-9-]{1,80}$/.test(scenario)) throw new JobPlanError("INVALID_OPTION", "The scenario id may only contain lowercase letters, digits and dashes.");
  const report = path.join(context.dataDirectory, "eval", "offline-report.json");
  return {
    kind: "offline-eval",
    label: scenario ? `Offline evaluation (${scenario}, ${seeds} seeds)` : `Offline evaluation (all scenarios, ${seeds} seeds)`,
    source: "offline",
    command: process.execPath,
    args: [cli, path.join("src", "eval.ts"), "--seeds", String(seeds), "--out", report, ...(scenario ? ["--scenario", scenario] : [])],
    cwd: context.root,
    timeoutMs: 30 * 60_000,
    display: `tsx src/eval.ts --seeds ${seeds}${scenario ? ` --scenario ${scenario}` : ""}`,
    meta: { seeds, scenario, world: "simulated" },
    summarise: () => ({ kind: "eval", reportPath: relative(context.root, report) }),
  };
}

export interface LivePlanOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** `read-only` = connection, observation and decision phases; `actions` adds movement, recovery and swim checks. */
  readonly scope: "read-only" | "actions";
  readonly allowDig?: boolean;
  readonly allowCombat?: boolean;
  /** The operator's explicit confirmation that a bot will join the named server. */
  readonly confirmed: boolean;
  /** Separate confirmation required for anything that changes the world or attacks entities. */
  readonly confirmedWorldChanges?: boolean;
}

/** A live run is never planned without confirmation; world-changing options need a second, separate one. */
export function planLiveVerification(context: PlanContext, options: LivePlanOptions): JobSpec {
  if (options.confirmed !== true) {
    throw new JobPlanError("CONFIRMATION_REQUIRED", `Live verification connects a bot to ${options.host}:${options.port}. Confirm that you want this before it runs.`);
  }
  const changesWorld = options.allowDig === true || options.allowCombat === true;
  if (changesWorld && options.confirmedWorldChanges !== true) {
    throw new JobPlanError(
      "CONFIRMATION_REQUIRED",
      `${[options.allowDig ? "digging blocks" : null, options.allowCombat ? "attacking hostile mobs" : null].filter(Boolean).join(" and ")} changes the world on ${options.host}:${options.port}. Confirm the world changes separately, or turn those checks off.`,
    );
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new JobPlanError("INVALID_OPTION", "The port must be a whole number from 1 to 65535.");
  if (!/^[A-Za-z0-9.\-:[\]]{1,253}$/.test(options.host)) throw new JobPlanError("INVALID_OPTION", "The host contains characters a server address cannot have.");
  if (!/^[A-Za-z0-9_]{3,16}$/.test(options.username)) throw new JobPlanError("INVALID_OPTION", "The bot name must be 3 to 16 letters, digits or underscores.");
  const cli = tsxCli(context.root);
  const outputDirectory = path.join(context.dataDirectory, "live-verification");
  const reportPath = path.join(outputDirectory, "live-verification-report.json");
  const args = [
    cli,
    path.join("src", "testing", "live", "live-test-runner.ts"),
    "--host", options.host,
    "--port", String(options.port),
    "--username", options.username,
    "--output", outputDirectory,
    ...(options.scope === "actions" ? ["--actions"] : []),
    ...(options.allowDig ? ["--allow-dig"] : []),
    ...(options.allowCombat ? ["--allow-combat"] : []),
  ];
  return {
    kind: "live-verification",
    label: `Live verification of ${options.host}:${options.port}`,
    source: "live",
    command: process.execPath,
    args,
    cwd: context.root,
    timeoutMs: 15 * 60_000,
    display: `tsx src/testing/live/live-test-runner.ts --host ${options.host} --port ${options.port}${options.scope === "actions" ? " --actions" : ""}${options.allowDig ? " --allow-dig" : ""}${options.allowCombat ? " --allow-combat" : ""}`,
    meta: { host: options.host, port: options.port, username: options.username, scope: options.scope, allowDig: options.allowDig === true, allowCombat: options.allowCombat === true, world: "live" },
    summarise: () => readLiveReportSummary(reportPath),
  };
}
