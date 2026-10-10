import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readTrainingState, trainingPaths } from "../training/state.js";
import type { AgentLoopPerformance } from "../games/minecraft/runtime-metrics.js";

/**
 * Reads the evidence the roadmap rules work from. Every number here comes from a file a real run wrote, or
 * from the live runtime that the caller passes in. A missing file is reported as an unavailable source and
 * produces no finding; it is never filled in with a default.
 */

export interface AutonomyProfileEvidence {
  readonly file: string;
  readonly measuredAt: string;
  readonly scenario: string;
  readonly seed: number;
  readonly virtualSeconds: number;
  readonly idleVirtualSeconds: number;
  readonly tasks: readonly { taskId: string; status: string; failureCode: string | null; actions: number; simulatedMs: number }[];
}

export interface TestRunEvidence {
  readonly measuredAt: string;
  readonly passed: number;
  readonly failed: number;
  readonly failures: readonly string[];
  readonly command: string;
}

export interface TrainingEvidence {
  readonly measuredAt: string;
  readonly status: string;
  readonly episodes: number;
  readonly evaluation: {
    readonly checkpointId: string;
    readonly measuredAt: string;
    readonly verdict: string;
    readonly baselineSuccess: number;
    readonly candidateSuccess: number;
    readonly successDelta: number;
    readonly baselineFailureCodes: Readonly<Record<string, number>>;
    readonly candidateFailureCodes: Readonly<Record<string, number>>;
  } | null;
}

export interface EpisodeEvidence {
  readonly measuredAt: string | null;
  readonly total: number;
  readonly failureCodes: Readonly<Record<string, number>>;
  readonly skills: Readonly<Record<string, { attempts: number; successes: number }>>;
  readonly sources: readonly string[];
}

export interface RuntimeEvidence {
  readonly measuredAt: string;
  readonly observationIntervalP95Ms: number | null;
  readonly loopHz: number | null;
  readonly reactionP95Ms: number | null;
  readonly source: string;
}

export interface EvidenceBundle {
  readonly profiles: readonly AutonomyProfileEvidence[];
  readonly tests: TestRunEvidence | null;
  readonly training: TrainingEvidence | null;
  readonly episodes: EpisodeEvidence | null;
  readonly liveVerification: { readonly measuredAt: string; readonly summary: string } | null;
  readonly runtime: RuntimeEvidence | null;
}

export interface EvidenceSource {
  readonly name: string;
  readonly path: string;
  readonly available: boolean;
  readonly measuredAt: string | null;
}

export interface EvidenceLoadOptions {
  /** Directory with autonomy profile reports (data/profile). */
  readonly profileDirectory: string;
  /** Test record written by `npm run test:record` (data/evidence/tests.json). */
  readonly testRecordPath: string;
  /** Training root (data/training). */
  readonly trainingRoot: string;
  /** Learning stores whose episodes are counted. */
  readonly episodeFiles: readonly string[];
  /** Hand-written or scripted record of a live verification run (data/evidence/live-verification.json). */
  readonly liveVerificationPath: string;
  readonly runtime: RuntimeEvidence | null;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function modifiedAt(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadProfiles(directory: string): Promise<AutonomyProfileEvidence[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const profiles: AutonomyProfileEvidence[] = [];
  for (const name of names) {
    const file = join(directory, name);
    const raw = await readJson(file);
    if (!isRecord(raw) || !Array.isArray(raw.tasks) || typeof raw.scenario !== "string") continue;
    const measuredAt = typeof raw.generatedAt === "string" ? raw.generatedAt : (await modifiedAt(file)) ?? new Date(0).toISOString();
    profiles.push({
      file,
      measuredAt,
      scenario: raw.scenario,
      seed: Number(raw.seed),
      virtualSeconds: Number(raw.virtualSeconds),
      idleVirtualSeconds: Number(raw.idleVirtualSeconds ?? 0),
      tasks: raw.tasks.filter(isRecord).map((task) => ({
        taskId: String(task.taskId),
        status: String(task.status),
        failureCode: typeof task.failureCode === "string" ? task.failureCode : null,
        actions: Number(task.actions ?? 0),
        simulatedMs: Number(task.simulatedMs ?? 0),
      })),
    });
  }
  return profiles;
}

async function loadTests(path: string): Promise<TestRunEvidence | null> {
  const raw = await readJson(path);
  if (!isRecord(raw) || typeof raw.measuredAt !== "string") return null;
  return {
    measuredAt: raw.measuredAt,
    passed: Number(raw.passed ?? 0),
    failed: Number(raw.failed ?? 0),
    failures: Array.isArray(raw.failures) ? raw.failures.map(String) : [],
    command: String(raw.command ?? "npm test"),
  };
}

function countsOf(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const counts: Record<string, number> = {};
  for (const [code, count] of Object.entries(value)) if (typeof count === "number") counts[code] = count;
  return counts;
}

async function loadTraining(root: string): Promise<TrainingEvidence | null> {
  const paths = trainingPaths(root);
  const state = await readTrainingState(paths).catch(() => null);
  if (!state) return null;
  let evaluation: TrainingEvidence["evaluation"] = null;
  if (state.lastEvaluation) {
    const report = await readJson(state.lastEvaluation.reportPath);
    if (isRecord(report) && isRecord(report.baseline) && isRecord(report.candidate)) {
      const baseline = report.baseline as Record<string, unknown>;
      const candidate = report.candidate as Record<string, unknown>;
      const baseMetrics = (baseline.metrics ?? {}) as Record<string, unknown>;
      const candMetrics = (candidate.metrics ?? {}) as Record<string, unknown>;
      const baselineSuccess = Number(baseMetrics.successRate);
      const candidateSuccess = Number(candMetrics.successRate);
      evaluation = {
        checkpointId: state.lastEvaluation.checkpointId,
        measuredAt: state.lastEvaluation.generatedAt,
        verdict: state.lastEvaluation.verdict,
        baselineSuccess,
        candidateSuccess,
        successDelta: candidateSuccess - baselineSuccess,
        baselineFailureCodes: countsOf(baseline.failureCodes),
        candidateFailureCodes: countsOf(candidate.failureCodes),
      };
    }
  }
  return {
    measuredAt: state.updatedAt,
    status: state.status,
    episodes: state.totalEpisodes,
    evaluation,
  };
}

async function loadEpisodes(files: readonly string[]): Promise<{ evidence: EpisodeEvidence | null; sources: EvidenceSource[] }> {
  const sources: EvidenceSource[] = [];
  const failureCodes: Record<string, number> = {};
  const skills: Record<string, { attempts: number; successes: number }> = {};
  let total = 0;
  let latest: string | null = null;
  const used: string[] = [];
  for (const file of files) {
    let found = false;
    try {
      const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      found = true;
      for await (const line of reader) {
        if (!line.trim()) continue;
        let episode: unknown;
        try {
          episode = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(episode) || !isRecord(episode.outcome) || !isRecord(episode.features)) continue;
        total += 1;
        const outcome = episode.outcome;
        const features = episode.features;
        const code = typeof outcome.failureCode === "string" ? outcome.failureCode : null;
        if (code) failureCodes[code] = (failureCodes[code] ?? 0) + 1;
        const skill = typeof features.skillId === "string" ? features.skillId : "unknown";
        const entry = skills[skill] ?? { attempts: 0, successes: 0 };
        entry.attempts += 1;
        if (outcome.status === "succeeded") entry.successes += 1;
        skills[skill] = entry;
        if (typeof episode.timestamp === "string" && (latest === null || episode.timestamp > latest)) latest = episode.timestamp;
      }
    } catch {
      found = false;
    }
    if (found) used.push(file);
    sources.push({ name: `episodes ${file}`, path: file, available: found, measuredAt: found ? await modifiedAt(file) : null });
  }
  if (used.length === 0) return { evidence: null, sources };
  return {
    evidence: { measuredAt: latest, total, failureCodes, skills, sources: used },
    sources,
  };
}

async function loadLiveVerification(path: string): Promise<EvidenceBundle["liveVerification"]> {
  const raw = await readJson(path);
  if (!isRecord(raw) || typeof raw.measuredAt !== "string") return null;
  return { measuredAt: raw.measuredAt, summary: String(raw.summary ?? "live verification recorded") };
}

export async function loadEvidence(options: EvidenceLoadOptions): Promise<{ bundle: EvidenceBundle; sources: EvidenceSource[]; evidenceAt: string | null }> {
  const profiles = await loadProfiles(options.profileDirectory);
  const tests = await loadTests(options.testRecordPath);
  const training = await loadTraining(options.trainingRoot);
  const episodeResult = await loadEpisodes(options.episodeFiles);
  const live = await loadLiveVerification(options.liveVerificationPath);

  const sources: EvidenceSource[] = [
    {
      name: "autonomy profiles",
      path: options.profileDirectory,
      available: profiles.length > 0,
      measuredAt: profiles.map((p) => p.measuredAt).sort().at(-1) ?? null,
    },
    { name: "test record", path: options.testRecordPath, available: tests !== null, measuredAt: tests?.measuredAt ?? null },
    { name: "training state", path: trainingPaths(options.trainingRoot).state, available: training !== null, measuredAt: training?.measuredAt ?? null },
    ...episodeResult.sources,
    { name: "live verification", path: options.liveVerificationPath, available: live !== null, measuredAt: live?.measuredAt ?? null },
    {
      name: "live runtime",
      path: "in-process",
      available: options.runtime !== null,
      measuredAt: options.runtime?.measuredAt ?? null,
    },
  ];
  const times = [
    ...profiles.map((p) => p.measuredAt),
    tests?.measuredAt,
    training?.measuredAt,
    episodeResult.evidence?.measuredAt,
    live?.measuredAt,
    options.runtime?.measuredAt,
  ].filter((value): value is string => typeof value === "string");
  const evidenceAt = times.sort().at(-1) ?? null;

  return {
    bundle: {
      profiles,
      tests,
      training,
      episodes: episodeResult.evidence,
      liveVerification: live,
      runtime: options.runtime,
    },
    sources,
    evidenceAt,
  };
}

/**
 * Live runtime evidence from the fast loop's own measurements. Null until it has observed at least once, so
 * the roadmap never reads an empty loop as a healthy or failing one.
 */
export function runtimeEvidenceOf(loop: AgentLoopPerformance | null): RuntimeEvidence | null {
  if (!loop || loop.observation.total === 0) return null;
  return {
    measuredAt: loop.sampledAt,
    observationIntervalP95Ms: loop.observation.intervalMs.p95Ms,
    loopHz: loop.observation.frequencyHz,
    reactionP95Ms: loop.reactionMs.p95Ms,
    source: "live runtime (fast loop)",
  };
}
