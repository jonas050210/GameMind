import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import {
  episodeContextKey,
  episodeFailureKey,
  episodeSchema,
  type Episode,
  type EpisodeFeatures,
  type EpisodeOutcome,
} from "./episode.js";
import { ExperienceStore, InMemoryExperienceStore, type ExperienceStoreLike } from "./experience-store.js";
import { DEFAULT_FAILURE_MEMORY_CONFIG, FailureMemory, type FailureMemoryConfig, type FailureMemorySnapshot } from "./failure-memory.js";
import { BASELINE_POLICY_WEIGHTS, derivePolicyWeights, parsePolicyWeights, type PolicyWeightConfig, type PolicyWeights } from "./policy-weights.js";
import { foldEpisodes, parseSkillStatistics, type SkillStatistics } from "./skill-statistics.js";
import { ExperiencePolicyAdvisor, type PolicyAdvisor } from "./policy-advisor.js";
import { computeReward, DEFAULT_REWARD_CONFIG, type RewardBreakdown, type RewardConfig, type RewardInput } from "./reward.js";
import { ClassFailureMemory, deriveClassPatternKey, type ClassFailureMemoryConfig } from "./class-failure-memory.js";
import { PolicyCheckpointStore, ExperimentStore, type ExperimentRecord } from "./checkpoint.js";
import { assessRLReadiness } from "./rl-readiness.js";

/**
 * The learner. It writes episodes, keeps running skill statistics and failure memory, and holds the
 * policy table that is actually active. Nothing here changes behaviour by itself: a derived weight
 * table only becomes the *active* policy once `PolicyGate` has accepted it against the baseline.
 */

export const LEARNING_STATE_SCHEMA_VERSION = 1 as const;

export interface LearningRunContext {
  readonly runId: string;
  readonly taskId: string;
  /** Scenario id + seed, or server host + world name. Gates target memory to one world. */
  readonly worldKey: string | null;
}

export interface EpisodeDraft {
  readonly runId: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly sequence: number;
  readonly worldKey: string | null;
  readonly policyVersion: string | null;
  readonly targetKey: string | null;
  readonly features: EpisodeFeatures;
  readonly outcome: EpisodeOutcome;
}

export interface LearningState {
  readonly schemaVersion: typeof LEARNING_STATE_SCHEMA_VERSION;
  readonly runs: number;
  readonly episodes: number;
  readonly lastRunId: string | null;
  readonly stats: SkillStatistics;
  readonly failureMemory: FailureMemorySnapshot;
  readonly candidateWeights: PolicyWeights;
  readonly activeWeights: PolicyWeights | null;
  readonly history: readonly {
    readonly runId: string;
    readonly at: string;
    readonly episodes: number;
    readonly promoted: boolean;
    readonly note: string;
  }[];
}

export interface ExperienceLearnerOptions {
  readonly store?: ExperienceStoreLike;
  readonly stateFile?: string | null;
  readonly weightConfig?: Partial<PolicyWeightConfig>;
  readonly failureConfig?: Partial<FailureMemoryConfig>;
  /** When true, un-promoted (candidate) weights already influence decisions. Off by default. */
  readonly useCandidateWeights?: boolean;
  readonly logger?: Logger | null;
  readonly enabled?: boolean;
}

export interface LearningRunReport {
  readonly runId: string;
  readonly episodes: number;
  readonly totalEpisodes: number;
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly blockedTargets: number;
  readonly advisorId: string;
  readonly activePolicyId: string | null;
  readonly candidatePolicyId: string;
  readonly contexts: number;
}

export function emptyLearningState(): LearningState {
  return {
    schemaVersion: LEARNING_STATE_SCHEMA_VERSION,
    runs: 0,
    episodes: 0,
    lastRunId: null,
    stats: {},
    failureMemory: { version: "gamemind-failure-memory-v1", config: DEFAULT_FAILURE_MEMORY_CONFIG, entries: [] },
    candidateWeights: BASELINE_POLICY_WEIGHTS,
    activeWeights: null,
    history: [],
  };
}

const HISTORY_LIMIT = 40;

export class ExperienceLearner {
  readonly store: ExperienceStoreLike;
  private readonly stateFile: string | null;
  private readonly weightConfig: Partial<PolicyWeightConfig>;
  private readonly failureMemory: FailureMemory;
  private readonly useCandidateWeights: boolean;
  private readonly logger: Logger | null;
  private readonly enabled: boolean;
  private readonly rewardConfig: RewardConfig;
  private readonly classFailure: ClassFailureMemory;
  private readonly checkpointStore: PolicyCheckpointStore;
  private readonly experimentStore: ExperimentStore;
  private state: LearningState = emptyLearningState();
  private runContext: LearningRunContext | null = null;
  private runEpisodes: Episode[] = [];
  private loaded = false;

  // Running reward statistics (computed from every recorded episode)
  private rewardEpisodeCount = 0;
  private rewardMean = 0;
  private rewardSum = 0;
  private rewardEwma = 0;
  private rewardPositiveCount = 0;

  constructor(options: ExperienceLearnerOptions = {}) {
    this.store = options.store ?? new InMemoryExperienceStore();
    this.stateFile = options.stateFile === undefined ? null : options.stateFile;
    this.weightConfig = options.weightConfig ?? {};
    this.failureMemory = new FailureMemory(options.failureConfig ?? {});
    this.useCandidateWeights = options.useCandidateWeights ?? false;
    this.logger = options.logger ?? null;
    this.enabled = options.enabled ?? true;
    this.rewardConfig = DEFAULT_REWARD_CONFIG;
    this.classFailure = new ClassFailureMemory();
    this.checkpointStore = new PolicyCheckpointStore(
      this.stateFile ? { directory: path.dirname(this.stateFile) } : {},
    );
    this.experimentStore = new ExperimentStore();
  }

  static forDirectory(
    directory: string,
    options: Omit<ExperienceLearnerOptions, "store" | "stateFile"> & {
      readonly stateFileName?: string;
      readonly episodesFileName?: string;
    } = {},
  ): ExperienceLearner {
    return new ExperienceLearner({
      ...options,
      store: new ExperienceStore({
        directory,
        ...(options.episodesFileName ? { fileName: options.episodesFileName } : {}),
      }),
      stateFile: path.join(directory, options.stateFileName ?? "state.json"),
    });
  }

  get enabledValue(): boolean {
    return this.enabled;
  }

  get runIndex(): number {
    return this.state.runs;
  }

  /** Weights derived from experience so far; promoted only through the policy gate. */
  get candidateWeights(): PolicyWeights {
    return this.state.candidateWeights;
  }

  /** The policy currently steering decisions, or null while the baseline is in force. */
  get activeWeights(): PolicyWeights | null {
    return this.state.activeWeights;
  }

  get currentRun(): LearningRunContext | null {
    return this.runContext;
  }

  async load(): Promise<LearningState> {
    if (this.loaded) return this.state;
    this.loaded = true;
    if (!this.stateFile) {
      this.state = await this.rebuildFromStore(this.state);
      return this.state;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.warn({ err: error, stateFile: this.stateFile }, "Learning state unreadable; rebuilding from the episode log");
      }
      parsed = null;
    }
    const restored = parseLearningState(parsed);
    if (restored) {
      this.state = restored;
      this.failureMemory.restore(restored.failureMemory);
      return this.state;
    }
    this.state = await this.rebuildFromStore(emptyLearningState());
    return this.state;
  }

  /** Self-healing path: recompute the whole learner from the append-only episode log. */
  private async rebuildFromStore(base: LearningState): Promise<LearningState> {
    const { episodes } = await this.store.load();
    if (episodes.length === 0) return base;
    const stats = foldEpisodes(episodes);
    const memory = new FailureMemory(this.failureMemory.config);
    const runIds = [...new Set(episodes.map((episode) => episode.runId))];
    runIds.forEach((runId, index) => {
      for (const episode of episodes.filter((candidate) => candidate.runId === runId)) {
        if (episode.outcome.status === "succeeded" && episode.outcome.progress) {
          memory.recordSuccess({ worldKey: episode.worldKey, targetKey: episode.targetKey, runIndex: index });
          continue;
        }
        if (episode.outcome.status === "succeeded") continue;
        memory.recordFailure({
          worldKey: episode.worldKey,
          targetKey: episode.targetKey,
          goalClass: episode.features.goalClass,
          failureCode: episode.outcome.failureCode,
          runIndex: index,
        });
      }
    });
    const weights = derivePolicyWeights(stats, {
      config: this.weightConfig,
      episodes: episodes.length,
      runs: runIds.length,
    });
    return {
      ...base,
      runs: runIds.length,
      episodes: episodes.length,
      lastRunId: runIds.at(-1) ?? null,
      stats,
      failureMemory: memory.snapshot(runIds.length),
      candidateWeights: weights,
    };
  }

  beginRun(context: LearningRunContext): void {
    if (!this.enabled) return;
    this.runContext = context;
    this.runEpisodes = [];
  }

  /** Records one attempted action. Cheap and non-throwing: learning must never break a run. */
  /**
   * Unrounded running totals of the per-action reward. A caller that wants the reward of one task takes the
   * difference between two readings around it, which is exact (the snapshot values are rounded for display).
   */
  get rewardTotals(): { readonly episodes: number; readonly sum: number } {
    return { episodes: this.rewardEpisodeCount, sum: this.rewardSum };
  }

  recordEpisode(draft: EpisodeDraft): Episode | null {
    if (!this.enabled) return null;
    try {
      const episode: Episode = episodeSchema.parse({
        schemaVersion: 1,
        episodeId: `ep-${randomUUID().slice(0, 12)}`,
        runId: draft.runId,
        taskId: draft.taskId,
        sessionId: draft.sessionId,
        sequence: draft.sequence,
        timestamp: new Date().toISOString(),
        policyVersion: draft.policyVersion,
        worldKey: draft.worldKey,
        targetKey: draft.targetKey,
        features: draft.features,
        outcome: draft.outcome,
      });
      this.runEpisodes.push(episode);

      // Compute reward signal for this episode
      try {
        const rewardInput: RewardInput = {
          status: draft.outcome.status,
          confirmed: draft.outcome.confirmed,
          attemptsOnTarget: draft.features.attemptsOnTarget,
          distanceBefore: draft.features.distance,
          progress: draft.outcome.progress,
          safetyDenied: draft.outcome.safetyDenied,
          itemsGained: draft.outcome.itemsGained,
          itemsConsumed: draft.outcome.itemsConsumed,
          healthDelta: draft.outcome.healthDelta,
          foodDelta: draft.outcome.foodDelta,
          durationMs: draft.outcome.durationMs,
          distanceAfter: draft.outcome.distanceAfter,
          health: draft.features.health,
          hunger: draft.features.hunger,
          goalClass: draft.features.goalClass,
          skillId: draft.features.skillId,
        };
        const reward = computeReward(rewardInput, this.rewardConfig);

        // Update running reward statistics
        this.rewardEpisodeCount++;
        this.rewardSum += reward.total;
        this.rewardMean += (reward.total - this.rewardMean) / this.rewardEpisodeCount;
        this.rewardEwma = this.rewardEpisodeCount === 1
          ? reward.total
          : 0.3 * reward.total + 0.7 * this.rewardEwma;
        if (reward.total > 0) this.rewardPositiveCount++;
      } catch {
        // Reward computation must never break episode recording
      }

      // Update class-level failure memory for failures
      try {
        if (draft.outcome.status !== "succeeded" && draft.outcome.failureCode && draft.targetKey) {
          const patternKey = deriveClassPatternKey(
            draft.features.skillId,
            draft.features.goalClass,
            draft.outcome.failureCode,
            null,
            draft.features.timeOfDay !== "unknown" ? draft.features.timeOfDay : null,
          );
          this.classFailure.recordFailure({
            patternKey,
            skillId: draft.features.skillId,
            goalClass: draft.features.goalClass,
            condition: null,
            targetKey: draft.targetKey,
            runIndex: this.state.runs,
          });
        } else if (draft.outcome.status === "succeeded" && draft.outcome.progress && draft.targetKey) {
          const patternKey = deriveClassPatternKey(
            draft.features.skillId,
            draft.features.goalClass,
            null,
            null,
            draft.features.timeOfDay !== "unknown" ? draft.features.timeOfDay : null,
          );
          this.classFailure.recordSuccess({
            patternKey,
            targetKey: draft.targetKey,
            runIndex: this.state.runs,
          });
        }
      } catch {
        // Class failure memory must never break episode recording
      }

      return episode;
    } catch (error) {
      this.logger?.warn({ err: error }, "Episode draft was invalid; skipped");
      return null;
    }
  }

  /**
   * Folds this run's episodes into the learner state and persists both the episode log and the state
   * file. Returns the numbers a Control Center or CLI report needs.
   */
  async finishRun(report: { readonly promoted?: boolean; readonly note?: string } = {}): Promise<LearningRunReport> {
    const context = this.runContext;
    const episodes = this.runEpisodes;
    this.runEpisodes = [];
    if (!this.enabled) {
      return this.emptyReport(context?.runId ?? "disabled", episodes.length, 0);
    }
    await this.load();
    if (episodes.length > 0) await this.store.appendMany(episodes);

    const state = this.state;
    const stats = { ...state.stats };
    let successes = 0;
    let failures = 0;
    for (const episode of episodes) {
      const key = episodeContextKey(episode.features);
      const previous = stats[key] ?? {
        attempts: 0,
        successes: 0,
        progressCount: 0,
        contradictedConfirmations: 0,
        safetyDenials: 0,
        failureCodes: {},
        ewmaDurationMs: 0,
        ewmaGain: 0,
        totalDistance: 0,
        distanceSamples: 0,
        lastSequence: 0,
      };
      const success = episode.outcome.status === "succeeded" && episode.outcome.confirmed;
      if (success) successes += 1;
      else failures += 1;
      const failureCodes = { ...previous.failureCodes };
      if (!success && episode.outcome.failureCode) {
        failureCodes[episode.outcome.failureCode] =
          (failureCodes[episode.outcome.failureCode] ?? 0) + 1;
      }
      stats[key] = {
        attempts: previous.attempts + 1,
        successes: previous.successes + (success ? 1 : 0),
        progressCount: previous.progressCount + (episode.outcome.progress ? 1 : 0),
        contradictedConfirmations:
          previous.contradictedConfirmations + (episode.outcome.verified === false ? 1 : 0),
        safetyDenials: previous.safetyDenials + (episode.outcome.safetyDenied ? 1 : 0),
        failureCodes,
        ewmaDurationMs:
          previous.attempts === 0
            ? episode.outcome.durationMs
            : 0.25 * episode.outcome.durationMs + 0.75 * previous.ewmaDurationMs,
        ewmaGain:
          previous.attempts === 0
            ? Math.max(0, episode.outcome.itemsGained) + Math.max(0, episode.outcome.foodDelta)
            : 0.25 *
                (Math.max(0, episode.outcome.itemsGained) + Math.max(0, episode.outcome.foodDelta)) +
              0.75 * previous.ewmaGain,
        totalDistance: previous.totalDistance + episode.features.distance,
        distanceSamples: previous.distanceSamples + 1,
        lastSequence: Math.max(previous.lastSequence, episode.sequence),
      };
      // Failure memory: only world-anchored targets are remembered, and a later success at the same
      // target weakens the lesson instead of leaving a permanent ban.
      if (episode.targetKey && episode.worldKey) {
        if (episode.outcome.status !== "succeeded") {
          this.failureMemory.recordFailure({
            worldKey: episode.worldKey,
            targetKey: episode.targetKey,
            goalClass: episode.features.goalClass,
            failureCode: episode.outcome.failureCode ?? episodeFailureKey(episode.features, episode.outcome).split("|")[2] ?? "failure",
            runIndex: state.runs,
            note: episode.runId,
          });
        } else if (episode.outcome.progress) {
          this.failureMemory.recordSuccess({
            worldKey: episode.worldKey,
            targetKey: episode.targetKey,
            runIndex: state.runs,
          });
        }
      }
    }

    const runId = context?.runId ?? state.lastRunId ?? "unknown";
    const pruned = this.failureMemory.prune(state.runs + 1);
    const runs = state.runs + 1;
    const candidateWeights = derivePolicyWeights(stats, {
      config: this.weightConfig,
      episodes: state.episodes + episodes.length,
      runs,
    });
    this.state = {
      schemaVersion: LEARNING_STATE_SCHEMA_VERSION,
      runs,
      episodes: state.episodes + episodes.length,
      lastRunId: runId,
      stats,
      failureMemory: this.failureMemory.snapshot(runs),
      candidateWeights,
      activeWeights: state.activeWeights,
      history: [
        {
          runId,
          at: new Date().toISOString(),
          episodes: episodes.length,
          promoted: report.promoted ?? false,
          note:
            report.note ??
            `${successes} successful / ${failures} failed actions${pruned > 0 ? `, ${pruned} stale failure memories pruned` : ""}`,
        },
        ...state.history,
      ].slice(0, HISTORY_LIMIT),
    };
    await this.persist();

    // Save checkpoint for this run's derived weights
    try {
      if (episodes.length > 0) {
        this.checkpointStore.save(
          candidateWeights,
          {
            episodes: this.state.episodes,
            runs,
            contexts: Object.keys(stats).length,
            successes,
            failures,
            rewardStats: {
              meanReward: this.rewardMean,
              ewmaReward: this.rewardEwma,
              positiveRate: this.rewardEpisodeCount > 0
                ? this.rewardPositiveCount / this.rewardEpisodeCount : 0,
            },
          },
          report.note ?? `run ${runId}`,
        );
        await this.checkpointStore.persist();
      }
    } catch {
      // Checkpoint saving must never break the run report
    }
    this.classFailure.prune(runs);

    return {
      runId,
      episodes: episodes.length,
      totalEpisodes: this.state.episodes,
      runs,
      successes,
      failures,
      blockedTargets: this.failureMemory.snapshot(runs).entries.filter((entry) => entry.blocked).length,
      advisorId: this.advisor().id,
      activePolicyId: this.state.activeWeights?.id ?? null,
      candidatePolicyId: candidateWeights.id,
      contexts: Object.keys(stats).length,
    };
  }

  /** Advisor used by the decision model for the run that is currently in progress. */
  advisor(): PolicyAdvisor {
    const weights = this.useCandidateWeights
      ? this.state.candidateWeights
      : this.state.activeWeights ?? BASELINE_POLICY_WEIGHTS;
    return new ExperiencePolicyAdvisor({
      weights,
      failureMemory: this.failureMemory,
      worldKey: this.runContext?.worldKey ?? null,
      runIndex: this.state.runs,
    });
  }

  async promote(weights: PolicyWeights, note = "promoted after passing the policy gate"): Promise<void> {
    await this.load();
    this.state = {
      ...this.state,
      activeWeights: weights,
      history: [
        {
          runId: this.state.lastRunId ?? "policy",
          at: new Date().toISOString(),
          episodes: this.state.episodes,
          promoted: true,
          note: `${note} (${weights.id}, ${Object.keys(weights.entries).length} weighted contexts)`,
        },
        ...this.state.history,
      ].slice(0, HISTORY_LIMIT),
    };
    await this.persist();
  }

  async rollback(note = "rolled back to the baseline policy"): Promise<void> {
    await this.load();
    this.state = {
      ...this.state,
      activeWeights: null,
      history: [
        {
          runId: this.state.lastRunId ?? "policy",
          at: new Date().toISOString(),
          episodes: this.state.episodes,
          promoted: false,
          note,
        },
        ...this.state.history,
      ].slice(0, HISTORY_LIMIT),
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.stateFile) return;
    const serialized = JSON.stringify(this.state, null, 2);
    try {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.tmp`;
      await writeFile(temporary, `${serialized}\n`, "utf8");
      await rename(temporary, this.stateFile);
    } catch (error) {
      this.logger?.warn({ err: error, stateFile: this.stateFile }, "Could not persist learning state");
    }
  }

  snapshot(): {
    readonly enabled: boolean;
    readonly runs: number;
    readonly episodes: number;
    /** Totals the promotion check needs: experience that contradicted the world or tripped safety. */
    readonly contradictedConfirmations: number;
    readonly safetyDenials: number;
    readonly failures: number;
    readonly lastRunId: string | null;
    readonly contexts: readonly { key: string; attempts: number; successes: number }[];
    readonly activePolicy: { id: string; contexts: number } | null;
    readonly candidatePolicy: { id: string; contexts: number };
    readonly failureMemory: readonly {
      targetKey: string;
      attempts: number;
      blocked: boolean;
      failureCode: string | null;
    }[];
    readonly history: LearningState["history"];
    readonly runEpisodes: number;
    readonly reward: {
      readonly meanReward: number;
      readonly ewmaReward: number;
      readonly positiveRate: number;
      readonly totalEpisodes: number;
    };
    readonly classPatterns: readonly {
      readonly patternKey: string;
      readonly attempts: number;
      readonly distinctTargets: number;
      readonly blocked: boolean;
    }[];
    readonly checkpoints: {
      readonly total: number;
      readonly activeId: string | null;
      readonly recent: readonly { readonly id: string; readonly reason: string; readonly createdAt: string }[];
    };
    readonly experiments: readonly {
      readonly id: string;
      readonly name: string;
      readonly status: string;
      readonly promoted: boolean;
    }[];
    readonly rlReadiness: {
      readonly score: number;
      readonly maxScore: number;
      readonly ready: readonly string[];
      readonly blockers: readonly string[];
    };
  } {
    const stats = this.state.stats;
    let contradictedConfirmations = 0;
    let safetyDenials = 0;
    let failures = 0;
    for (const stat of Object.values(stats)) {
      contradictedConfirmations += stat.contradictedConfirmations;
      safetyDenials += stat.safetyDenials;
      failures += Math.max(0, stat.attempts - stat.successes);
    }
    const activePatterns = this.classFailure.activePatterns(this.state.runs);
    const rlAssessment = assessRLReadiness();
    return {
      enabled: this.enabled,
      runs: this.state.runs,
      episodes: this.state.episodes,
      contradictedConfirmations,
      safetyDenials,
      failures,
      lastRunId: this.state.lastRunId,
      contexts: Object.entries(stats)
        .map(([key, stat]) => ({ key, attempts: stat.attempts, successes: stat.successes }))
        .sort((left, right) => right.attempts - left.attempts || left.key.localeCompare(right.key))
        .slice(0, 24),
      activePolicy: this.state.activeWeights
        ? {
            id: this.state.activeWeights.id,
            contexts: Object.keys(this.state.activeWeights.entries).length,
          }
        : null,
      candidatePolicy: {
        id: this.state.candidateWeights.id,
        contexts: Object.keys(this.state.candidateWeights.entries).length,
      },
      failureMemory: this.failureMemory.snapshot(this.state.runs).entries.slice(0, 24).map((entry) => ({
        targetKey: entry.targetKey,
        attempts: entry.attempts,
        blocked: entry.blocked,
        failureCode: entry.failureCode,
      })),
      history: this.state.history,
      runEpisodes: this.runEpisodes.length,
      reward: {
        meanReward: Math.round(this.rewardMean * 10_000) / 10_000,
        ewmaReward: Math.round(this.rewardEwma * 10_000) / 10_000,
        positiveRate: this.rewardEpisodeCount > 0
          ? Math.round((this.rewardPositiveCount / this.rewardEpisodeCount) * 1_000) / 1_000
          : 0,
        totalEpisodes: this.rewardEpisodeCount,
      },
      classPatterns: activePatterns.slice(0, 12).map((p) => ({
        patternKey: p.patternKey,
        attempts: p.attempts,
        distinctTargets: p.distinctTargets,
        blocked: p.blocked,
      })),
      checkpoints: {
        total: this.checkpointStore.all.length,
        activeId: this.checkpointStore.active?.policyId ?? null,
        recent: this.checkpointStore.all.slice(-5).reverse().map((c) => ({
          id: c.policyId,
          reason: c.reason,
          createdAt: c.createdAt,
        })),
      },
      experiments: this.experimentStore.recent.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        promoted: e.result?.promoted ?? false,
      })),
      rlReadiness: {
        score: rlAssessment.score,
        maxScore: rlAssessment.maxScore,
        ready: rlAssessment.ready,
        blockers: rlAssessment.blockers,
      },
    };
  }

  private emptyReport(runId: string, episodes: number, total: number): LearningRunReport {
    return {
      runId,
      episodes,
      totalEpisodes: total,
      runs: this.state.runs,
      successes: 0,
      failures: 0,
      blockedTargets: 0,
      advisorId: "disabled",
      activePolicyId: null,
      candidatePolicyId: BASELINE_POLICY_WEIGHTS.id,
      contexts: 0,
    };
  }
}

function parseLearningState(value: unknown): LearningState | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<LearningState>;
  if (raw.schemaVersion !== LEARNING_STATE_SCHEMA_VERSION) return null;
  if (typeof raw.runs !== "number" || typeof raw.episodes !== "number") return null;
  const stats = parseSkillStatistics(raw.stats);
  const weights = parsePolicyWeights(raw.candidateWeights) ?? BASELINE_POLICY_WEIGHTS;
  const activeWeights = parsePolicyWeights(raw.activeWeights);
  const failureMemory: FailureMemorySnapshot =
    raw.failureMemory && typeof raw.failureMemory === "object"
      ? raw.failureMemory
      : { version: "gamemind-failure-memory-v1", config: DEFAULT_FAILURE_MEMORY_CONFIG, entries: [] };
  return {
    schemaVersion: LEARNING_STATE_SCHEMA_VERSION,
    runs: Math.max(0, Math.trunc(raw.runs)),
    episodes: Math.max(0, Math.trunc(raw.episodes)),
    lastRunId: typeof raw.lastRunId === "string" ? raw.lastRunId : null,
    stats,
    failureMemory,
    candidateWeights: weights,
    activeWeights: activeWeights && Object.keys(activeWeights.entries).length > 0 ? activeWeights : null,
    history: Array.isArray(raw.history)
      ? raw.history
          .filter(
            (entry): entry is LearningState["history"][number] =>
              typeof entry === "object" && entry !== null && typeof entry.runId === "string",
          )
          .slice(0, HISTORY_LIMIT)
      : [],
  };
}
