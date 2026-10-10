/**
 * The JSON a finished task prints on stdout. It lives here, apart from the command-line entry point, so the exact
 * shape can be tested: a printed report is something scripts and operators read, and a field that quietly disappears
 * is a regression nothing else would notice.
 */
import { classifyFailure } from "../core/failure-taxonomy.js";
import type { MinecraftTaskResult } from "../games/minecraft/task-runner.js";

export type ReportSource = "cli" | "control-center";

/**
 * Facts about the world a report came from that the task result does not carry. Only the offline simulator has any
 * (its own clock and its world statistics); a live server has no simulated clock, so a live report is given none
 * instead of an invented value.
 */
export type ReportDetails = Readonly<Record<string, unknown>>;

/** Called once for every finished task, with the details of the session it ran in when that session has any. */
export type TaskReporter = (result: MinecraftTaskResult, source: ReportSource, details?: ReportDetails) => void;

/**
 * The failure category the Control Center shows, attached to the CLI report too so stdout and the
 * dashboard can never disagree about whether a stop was a safety refusal, a missing capability, a
 * connection fault or a task that ran out of budget.
 */
export function failureClassification(result: MinecraftTaskResult): Record<string, unknown> {
  if (result.status === "succeeded" && result.failure === null) return {};
  const classified = classifyFailure(result.failure?.code ?? null, result.failure?.message ?? null);
  return {
    classification: {
      status: result.status,
      kind: classified.kind,
      label: classified.label,
      code: classified.code,
      owner: classified.owner,
      retryable: classified.retryable,
      ...(classified.hint ? { hint: classified.hint } : {}),
    },
  };
}

/** The report for a task that ran against a real Minecraft server. */
export function liveTaskReport(result: MinecraftTaskResult, source: ReportSource): Record<string, unknown> {
  return { type: "task-report", startedBy: source, ...result, ...failureClassification(result) };
}

export interface SimulatedReportScenario {
  readonly id: string;
  readonly seed: number;
  readonly description: string;
  readonly expectation: string;
  /** True for the offline demo, which is labelled so nobody mistakes it for a run on a server. */
  readonly demo: boolean;
}

/**
 * The report for a task that ran in the offline simulator. `simulatedWorld: true` is always present, and `details`
 * adds the simulated clock and the damage/starvation statistics the simulator measured.
 */
export function simulatedTaskReport(
  scenario: SimulatedReportScenario,
  result: MinecraftTaskResult,
  source: ReportSource,
  details: ReportDetails = {},
): Record<string, unknown> {
  return {
    type: "sim-task-report",
    simulatedWorld: true,
    startedBy: source,
    scenarioId: scenario.id,
    seed: scenario.seed,
    description: scenario.description,
    expectation: scenario.expectation,
    ...(scenario.demo ? { offlineDemo: true } : {}),
    ...details,
    ...result,
    ...failureClassification(result),
  };
}
