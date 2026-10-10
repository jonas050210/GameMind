import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExperienceLearner, LearnerDetail } from "../core/learning/learner.js";
import { classifyFailure } from "../core/failure-taxonomy.js";
import type { EvaluationSummary } from "../control-center/types.js";
import { policyPromotionRefusalReasons } from "../games/minecraft/policy-promotion.js";
import { readEvaluationSummary } from "../games/minecraft/run-control.js";
import type { TrainingEvaluationReport } from "../training/evaluate.js";
import type { JobKind, JobView } from "./jobs.js";
import { displayPath, type RedactionContext } from "./redact.js";

/**
 * Read-only views behind the Control Center's detail endpoints. Each one is computed from files and live objects at
 * request time and says where its data came from; none of them invents a value for something that was not measured.
 */

/** Failure codes the operator is told about by name, whether or not they occurred yet. */
export const EXPLAINED_FAILURE_CODES = ["CONSECUTIVE_ACTION_FAILURES", "NO_FEASIBLE_GOAL", "TASK_BLOCKED_MODE"] as const;

/** What each of the three stop reasons means and what to do about it, beyond the generic taxonomy hint. */
const SPECIFIC_EXPLANATIONS: Readonly<Record<string, { readonly meaning: string; readonly whatToCheck: readonly string[] }>> = {
  CONSECUTIVE_ACTION_FAILURES: {
    meaning: "The task stopped because its last actions all failed in a row (default: 2). Each failure excluded its target and the planner replanned, but the next attempt failed as well.",
    whatToCheck: [
      "Open the failure codes of that run in Learning → Recent runs; the codes name the world condition that stopped each action (path blocked, tool missing, block not diggable).",
      "A failure that repeats with the same code on different targets points at the environment (terrain, game mode, tool) rather than at one bad target.",
      "Failures caused by the session or the policy (connection lost, safety refusal, game mode) are shown as excluded evidence: they stopped the task but are not held against the skill.",
    ],
  },
  NO_FEASIBLE_GOAL: {
    meaning: "The planner had no candidate left it was allowed to act on: every known target was excluded, unreachable, unsafe or already attempted, and no exploration was possible.",
    whatToCheck: [
      "The decision text of the blocked run names why nothing qualified (see the event log, category 'decision').",
      "A fresh area, more exploration legs (--explore-legs) or waiting for the failure memory to age out can create new candidates.",
      "If this follows TASK_BLOCKED_* messages, fix those first: they are the specific cause.",
    ],
  },
  TASK_BLOCKED_MODE: {
    meaning: "The live session reported a game mode the agent will not act in (for example creative or spectator), so the task was refused before any action ran. This is a policy decision, not a failure of a skill.",
    whatToCheck: [
      "Set the player to survival mode (for example /gamemode survival) and start the task again.",
      "The mode shown on the Overview comes from the live session, with the evidence behind it; 'unknown' means the session has not reported it.",
      "No experience is recorded against any skill for a refusal like this.",
    ],
  },
};

export interface ExplainedFailure {
  readonly code: string;
  readonly kind: string;
  readonly label: string;
  readonly owner: string;
  readonly retryable: boolean;
  readonly hint: string | null;
  readonly meaning: string | null;
  readonly whatToCheck: readonly string[];
  /** How many recorded actions carried this code; null when the code is not an action-level outcome. */
  readonly occurrences: number | null;
}

export function explainFailure(code: string, occurrences: number | null = null): ExplainedFailure {
  const classified = classifyFailure(code);
  const specific = SPECIFIC_EXPLANATIONS[code];
  return {
    code,
    kind: classified.kind,
    label: classified.label,
    owner: classified.owner,
    retryable: classified.retryable,
    hint: classified.hint,
    meaning: specific?.meaning ?? null,
    whatToCheck: specific?.whatToCheck ?? [],
    occurrences,
  };
}

export interface LearningQueryInputs {
  readonly learner: ExperienceLearner | null;
  readonly learningDirectory: string | null;
  readonly evaluationReportPath: string;
  readonly evaluationScenarioIds: readonly string[];
  readonly redaction: RedactionContext;
  /** Checkpoint evaluations from the offline training directory, newest first. */
  readonly trainingReports: readonly TrainingEvaluationReport[];
  readonly trainingDirectory: string;
}

export async function buildLearningQuery(input: LearningQueryInputs): Promise<Record<string, unknown>> {
  const { learner } = input;
  const evaluation = await readEvaluationSummary(input.evaluationReportPath);
  if (!learner || !learner.enabledValue) {
    return {
      generatedAt: new Date().toISOString(),
      enabled: false,
      reason: "Learning is turned off for this run (--no-learning), so no experience is recorded or shown.",
      explanations: EXPLAINED_FAILURE_CODES.map((code) => explainFailure(code)),
      evaluation,
      trainingReports: summariseTrainingReports(input.trainingReports),
      trainingDirectory: input.trainingDirectory,
    };
  }
  const detail: LearnerDetail = await learner.detail();
  const snapshot = learner.snapshot();
  const refusal = policyPromotionRefusalReasons(
    {
      episodes: snapshot.episodes,
      candidateContexts: snapshot.candidatePolicy.contexts,
      contradictedConfirmations: snapshot.contradictedConfirmations,
      candidateWeightsId: learner.candidateWeights.id,
    },
    evaluation,
    input.evaluationScenarioIds,
  );
  const failureCounts = new Map(detail.failures.map((entry) => [entry.code, entry.count] as const));
  const codes = [...new Set([...EXPLAINED_FAILURE_CODES, ...detail.failures.slice(0, 8).map((entry) => entry.code), ...detail.recentRuns.map((run) => run.lastFailureCode).filter((code): code is string => typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code))])];
  return {
    generatedAt: new Date().toISOString(),
    enabled: true,
    store: {
      directory: displayPath(input.learningDirectory, input.redaction),
      runs: detail.totals.runs,
      episodes: detail.totals.episodes,
      evidenceProvenance: detail.evidenceProvenance,
      byProvenance: detail.totals.byProvenance,
    },
    policy: {
      ...detail.policy,
      status: detail.policy.activeId ? "active-policy" : "no-active-policy",
      statement: detail.policy.activeId
        ? `Policy ${detail.policy.activeId} (${detail.policy.activeContexts} weighted contexts) is steering decisions.`
        : "No policy has been promoted, so decisions use the baseline. The candidate below is measured evidence waiting for the offline gate; it steers nothing yet.",
      promotion: { allowed: refusal.length === 0, refusalReasons: refusal, gate: "offline full-suite comparison with the same seeds (the existing gate)" },
    },
    contexts: detail.contexts,
    failures: detail.failures,
    excluded: detail.excluded,
    contradictions: detail.contradictions,
    recentRuns: detail.recentRuns,
    history: detail.history,
    blockedTargets: snapshot.failureMemory,
    reward: snapshot.reward,
    evaluation,
    trainingReports: summariseTrainingReports(input.trainingReports),
    trainingDirectory: input.trainingDirectory,
    explanations: codes.map((code) => explainFailure(code, failureCounts.get(code) ?? null)),
  };
}

function summariseTrainingReports(reports: readonly TrainingEvaluationReport[]): Array<Record<string, unknown>> {
  return reports.map((report) => ({
    checkpointId: report.checkpointId,
    generatedAt: report.generatedAt,
    verdict: report.verdict,
    conclusion: report.conclusion ?? null,
    weightsId: report.weightsId,
    learnedContexts: report.candidateContent?.learnedContexts ?? null,
    evaluationSet: report.evaluationSet ?? null,
    baseline: { successRate: report.baseline.metrics.successRate, runs: report.baseline.metrics.runs, interval: report.confidence?.baseline ?? null, meanWastedActions: report.baseline.meanWastedActions, medianActions: report.baseline.metrics.medianActions },
    candidate: { successRate: report.candidate.metrics.successRate, runs: report.candidate.metrics.runs, interval: report.confidence?.candidate ?? null, meanWastedActions: report.candidate.meanWastedActions, medianActions: report.candidate.metrics.medianActions },
    deltas: report.deltas,
    behaviour: report.behaviour ?? null,
    paired: report.paired ?? null,
    baselineStability: report.baselineStability ?? null,
    reasons: [...report.decision.reasons, ...report.decision.blocking],
    heldOut: { seeds: report.heldOut.evaluationSeeds.length, disjointFromTraining: report.heldOut.disjointSeeds, note: report.heldOut.note },
    scenarios: report.baseline.metrics.scenarios.map((baseline) => {
      const candidate = report.candidate.metrics.scenarios.find((entry) => entry.scenarioId === baseline.scenarioId);
      return {
        scenarioId: baseline.scenarioId,
        baselineSuccess: baseline.successRate,
        candidateSuccess: candidate?.successRate ?? null,
        successDelta: candidate ? Math.round((candidate.successRate - baseline.successRate) * 1000) / 1000 : null,
        baselineMedianActions: baseline.medianActions,
        candidateMedianActions: candidate?.medianActions ?? null,
        actionsDelta: candidate ? candidate.medianActions - baseline.medianActions : null,
        unsafeDelta: candidate ? candidate.unsafeActions - baseline.unsafeActions : null,
        deathsDelta: candidate ? candidate.deaths - baseline.deaths : null,
      };
    }),
  }));
}

// ---- world memory ------------------------------------------------------------------------------------------------

interface StoredMemory {
  readonly worldKey?: string;
  readonly savedAt?: string;
  readonly observations?: number;
  readonly blocks?: ReadonlyArray<{ readonly name: string; readonly position: { readonly x: number; readonly y: number; readonly z: number } }>;
  readonly minable?: ReadonlyArray<{ readonly name: string }>;
  readonly exploredCells?: readonly string[];
  readonly landmarks?: ReadonlyArray<{ readonly id: string; readonly type: string; readonly label: string; readonly position: { readonly x: number; readonly y: number; readonly z: number }; readonly createdAt: string }>;
}

export interface MemoryWorldView {
  readonly file: string;
  readonly worldKey: string;
  readonly savedAt: string | null;
  readonly observations: number;
  readonly resources: Readonly<Record<string, number>>;
  readonly minableBlocks: number;
  readonly exploredCells: number;
  readonly bounds: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number } | null;
  /** Explored cells folded into a coarse grid, row-major from north-west; null when nothing was explored. */
  readonly grid: { readonly columns: number; readonly rows: number; readonly cellsPerBucket: number; readonly counts: readonly number[]; readonly max: number } | null;
  readonly landmarks: ReadonlyArray<{ readonly id: string; readonly type: string; readonly label: string; readonly position: { readonly x: number; readonly y: number; readonly z: number }; readonly createdAt: string }>;
  readonly landmarkTotal: number;
  readonly current: boolean;
}

const GRID_LIMIT = 24;

function foldGrid(cells: readonly string[]): { bounds: MemoryWorldView["bounds"]; grid: MemoryWorldView["grid"] } {
  const points: Array<[number, number]> = [];
  for (const cell of cells) {
    const match = /^(-?\d+),(-?\d+)$/.exec(cell);
    if (match) points.push([Number(match[1]), Number(match[2])]);
  }
  if (points.length === 0) return { bounds: null, grid: null };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const width = maxX - minX + 1;
  const height = maxZ - minZ + 1;
  const bucket = Math.max(1, Math.ceil(Math.max(width, height) / GRID_LIMIT));
  const columns = Math.ceil(width / bucket);
  const rows = Math.ceil(height / bucket);
  const counts = new Array<number>(columns * rows).fill(0);
  for (const [x, z] of points) {
    const column = Math.floor((x - minX) / bucket);
    const row = Math.floor((z - minZ) / bucket);
    counts[row * columns + column] = (counts[row * columns + column] ?? 0) + 1;
  }
  return { bounds: { minX, maxX, minZ, maxZ }, grid: { columns, rows, cellsPerBucket: bucket * bucket, counts, max: Math.max(...counts) } };
}

export async function buildMemoryQuery(input: {
  readonly directory: string;
  readonly currentWorldKey: string | null;
  readonly liveSummary: { readonly worldKey: string; readonly observations: number; readonly exploredCells: number; readonly resourceBlocks: Readonly<Record<string, number>>; readonly landmarks: number } | null;
  readonly redaction: RedactionContext;
}): Promise<Record<string, unknown>> {
  let names: string[] = [];
  try {
    names = (await readdir(input.directory)).filter((name) => name.endsWith(".json"));
  } catch {
    names = [];
  }
  const worlds: MemoryWorldView[] = [];
  for (const name of names.slice(0, 40)) {
    try {
      const stored = JSON.parse(await readFile(path.join(input.directory, name), "utf8")) as StoredMemory;
      if (typeof stored.worldKey !== "string") continue;
      const resources: Record<string, number> = {};
      for (const block of stored.blocks ?? []) resources[block.name] = (resources[block.name] ?? 0) + 1;
      const folded = foldGrid(stored.exploredCells ?? []);
      worlds.push({
        file: name.replace(/\.json$/, "").slice(0, 80),
        worldKey: stored.worldKey,
        savedAt: stored.savedAt ?? null,
        observations: stored.observations ?? 0,
        resources,
        minableBlocks: stored.minable?.length ?? 0,
        exploredCells: stored.exploredCells?.length ?? 0,
        bounds: folded.bounds,
        grid: folded.grid,
        landmarks: (stored.landmarks ?? []).slice(0, 60),
        landmarkTotal: stored.landmarks?.length ?? 0,
        current: stored.worldKey === input.currentWorldKey,
      });
    } catch {
      // unreadable memory files are skipped; the status below says how many were found
    }
  }
  worlds.sort((left, right) => (right.savedAt ?? "").localeCompare(left.savedAt ?? ""));
  return {
    generatedAt: new Date().toISOString(),
    directory: displayPath(input.directory, input.redaction),
    status: worlds.length === 0 ? "empty" : "ok",
    filesFound: names.length,
    worlds,
    live: input.liveSummary,
    note: "World memory is what the agent remembers from observation: resource sightings, explored cells and landmarks. It is saved after tasks and at shutdown, so a running session can be ahead of the saved file.",
  };
}

// ---- tests and evaluation ----------------------------------------------------------------------------------------

export function latestJob(jobs: readonly JobView[], kind: JobKind): JobView | null {
  return jobs.find((job) => job.kind === kind) ?? null;
}

export function evaluationOverview(input: {
  readonly summary: EvaluationSummary | null;
  readonly jobs: readonly JobView[];
  readonly trainingReports: readonly TrainingEvaluationReport[];
  readonly liveDefaults: { readonly host: string; readonly port: number; readonly username: string };
}): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    notice: "Everything under 'offline' ran in the simulator or in unit tests. Only a result under 'live' involved a Minecraft server, and none exists unless a live verification was started here and reached one.",
    offline: {
      unitTests: latestJob(input.jobs, "unit-tests"),
      evaluationRun: latestJob(input.jobs, "offline-eval"),
      report: input.summary,
      checkpointReports: summariseTrainingReports(input.trainingReports),
    },
    live: {
      latest: latestJob(input.jobs, "live-verification"),
      defaults: input.liveDefaults,
      confirmation: {
        required: true,
        text: "Live verification connects a bot to the server you name. Read-only checks only observe. Digging and combat change the world and need their own confirmation.",
      },
    },
  };
}
