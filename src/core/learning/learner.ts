import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import type { Logger } from "pino";
import {
  episodeContextKey,
  episodeFailureKey,
  episodeSchema,
  type EpisodeProvenance,
  type Episode,
  type EpisodeFeatures,
  type EpisodeOutcome,
} from "./episode.js";
import { ExperienceStore, InMemoryExperienceStore, type ExperienceStoreLike } from "./experience-store.js";
import { DEFAULT_FAILURE_MEMORY_CONFIG, FailureMemory, type FailureMemoryConfig, type FailureMemorySnapshot } from "./failure-memory.js";
import { BASELINE_POLICY_WEIGHTS, DEFAULT_POLICY_WEIGHT_CONFIG, derivePolicyWeights, parsePolicyWeights, type PolicyWeightConfig, type PolicyWeights } from "./policy-weights.js";
import { classifyFailure, type FailureKind } from "../failure-taxonomy.js";
import { admitsProvenance, applyEpisode, conservativeSuccessRate, emptySkillStat, foldEpisodes, parseSkillStatistics, type SkillStatistics } from "./skill-statistics.js";
import { classifyOutcome } from "./outcome.js";
import { episodeProvenanceOf } from "./episode.js";
import { ExperiencePolicyAdvisor, type PolicyAdvisor } from "./policy-advisor.js";
import {
  computeReward,
  DEFAULT_REWARD_CONFIG,
  emptyRewardAggregate,
  parseRewardAggregate,
  updateRewardAggregate,
  type RewardAggregate,
  type RewardBreakdown,
  type RewardConfig,
  type RewardInput,
} from "./reward.js";
import { ClassFailureMemory, deriveClassPatternKey, type ClassFailureMemoryConfig } from "./class-failure-memory.js";
import { PolicyCheckpointStore, ExperimentStore, type ExperimentRecord } from "./checkpoint.js";
import { assessRLReadiness } from "./rl-readiness.js";

/**
 * The learner. It writes episodes, keeps running skill statistics and failure memory, and holds the
 * policy table that is actually active. Nothing here changes behaviour by itself: a derived weight
 * table only becomes the *active* policy once `PolicyGate` has accepted it against the baseline.
 */

/**
 * Version 2 derives statistics from verified, attributable evidence only (see `classifyOutcome`) and records which
 * episode provenances they were folded from. A version 1 state is not trusted for its numbers: they were computed
 * under the old rule. It is migrated by recomputing from the append-only episode log, which is never modified, and
 * the promoted policy and run history it carried are kept.
 */
export const LEARNING_STATE_SCHEMA_VERSION = 2 as const;

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
  /** Where the episode came from; defaults to "unlabelled" for callers that do not say. */
  readonly provenance?: EpisodeProvenance | undefined;
  readonly outcome: EpisodeOutcome;
}

/**
 * Running reward statistics over the episodes this learner trusts. They are persisted (and recomputed from the
 * episode log when a state file has none) so the numbers the Learning panel shows do not restart at zero after
 * every process restart, while the episode and run counters come from the log.
 */
export interface LearningRewardState {
  readonly aggregate: RewardAggregate;
  /** Unrounded sum, so a caller can take the reward of one task as the difference between two readings. */
  readonly sum: number;
}

/**
 * Running reward statistics over the episodes the learner trusts. They are persisted (and recomputed from the
 * episode log when a state file has none) so the numbers the Learning panel shows do not restart at zero after
 * every process restart, while the episode and run counters always come from the log.
 */
export interface LearningRewardState {
  readonly aggregate: RewardAggregate;
  /** Unrounded total, so a caller can take the reward of one task as the difference between two readings. */
  readonly sum: number;
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
  /** Provenances the statistics were folded from; null means every episode. A mismatch with the learner's rebuilds them. */
  readonly evidenceProvenance: readonly EpisodeProvenance[] | null;
  /**
   * Null in a state written before reward statistics were persisted, or when the file was unreadable: the
   * episode log is the source of truth, so a null triggers a rebuild rather than showing zeroed numbers.
   */
  readonly reward: LearningRewardState | null;
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
  /**
   * Which episodes may shape the weights and the failure memory. Unset means all of them (offline tools and tests).
   * A live agent passes `["live"]`: experience recorded by the simulator, by training or by demos stays in the log
   * and is shown, but it is not evidence about the real game.
   */
  readonly evidenceProvenance?: readonly EpisodeProvenance[];
}

export interface LearnerContextDetail {
  readonly key: string;
  readonly skillId: string;
  readonly goalClass: string;
  readonly distanceBand: string;
  readonly threat: string;
  readonly vitality: string;
  readonly attempts: number;
  readonly successes: number;
  readonly successRate: number | null;
  readonly conservativeSuccessRate: number | null;
  readonly weight: number | null;
  readonly weightEvidence: number | null;
  readonly weightStatus: "learned" | "neutral" | "insufficient-evidence";
  readonly minSamples: number;
  readonly contradictedConfirmations: number;
  readonly safetyDenials: number;
  readonly excluded: number;
  readonly topFailures: readonly { readonly code: string; readonly count: number }[];
  readonly meanDurationMs: number;
  readonly progressRate: number | null;
}

export interface LearnerFailureDetail {
  readonly code: string;
  readonly count: number;
  readonly kind: FailureKind;
  readonly label: string;
  readonly hint: string | null;
  readonly retryable: boolean;
}

export interface LearnerDetail {
  readonly enabled: boolean;
  readonly evidenceProvenance: readonly EpisodeProvenance[] | null;
  readonly totals: {
    readonly runs: number;
    readonly episodes: number;
    readonly byProvenance: Record<string, { episodes: number; runs: number; successes: number; failures: number; excluded: number; usedAsEvidence: boolean }>;
  };
  readonly policy: {
    readonly activeId: string | null;
    readonly activeContexts: number;
    readonly candidateId: string;
    readonly candidateSource: "baseline" | "experience";
    readonly candidateContexts: number;
    readonly minSamples: number;
    readonly weightRange: readonly [number, number];
    /** Which weights steer decisions right now: the promoted policy, the candidate (opt-in), or none (baseline). */
    readonly influencesDecisions: "active" | "candidate" | "none";
  };
  readonly contexts: readonly LearnerContextDetail[];
  readonly failures: readonly LearnerFailureDetail[];
  readonly excluded: { readonly total: number; readonly reasons: Readonly<Record<string, number>> };
  readonly contradictions: { readonly total: number };
  readonly recentRuns: readonly { readonly runId: string; readonly at: string; readonly taskId: string; readonly provenance: EpisodeProvenance; readonly episodes: number; readonly successes: number; readonly failures: number; readonly excluded: number; readonly lastFailureCode: string | null; readonly worldKey: string | null }[];
  readonly history: LearningState["history"];
}

export interface LearningRunReport {
  readonly runId: string;
  readonly episodes: number;
  readonly totalEpisodes: number;
  readonly runs: number;
  /** Successes and failures of this run, counted over the episodes that are evidence for this learner. */
  readonly successes: number;
  readonly failures: number;
  /** Episodes of this run that were logged but excluded by the provenance filter; not part of `successes`/`failures`. */
  readonly discardedByProvenance?: number;
  readonly blockedTargets: number;
  readonly advisorId: string;
  readonly activePolicyId: string | null;
  readonly candidatePolicyId: string;
  readonly contexts: number;
}

/**
 * The reward input of one recorded episode. It is derived only from what the episode itself carries, so folding
 * the append-only log reproduces exactly the numbers the live run computed. Returns null for a draft the reward
 * function cannot describe (undefined numbers), which is then not counted at all.
 */
function rewardInputOf(episode: Episode): RewardInput | null {
  try {
    const input: RewardInput = {
      status: episode.outcome.status,
      confirmed: episode.outcome.confirmed,
      attemptsOnTarget: episode.features.attemptsOnTarget,
      distanceBefore: episode.features.distance,
      progress: episode.outcome.progress,
      safetyDenied: episode.outcome.safetyDenied,
      itemsGained: episode.outcome.itemsGained,
      itemsConsumed: episode.outcome.itemsConsumed,
      healthDelta: episode.outcome.healthDelta,
      foodDelta: episode.outcome.foodDelta,
      durationMs: episode.outcome.durationMs,
      distanceAfter: episode.outcome.distanceAfter,
      health: episode.features.health,
      hunger: episode.features.hunger,
      goalClass: episode.features.goalClass,
      skillId: episode.features.skillId,
    };
    return input;
  } catch {
    return null;
  }
}

/** Folds the reward of every episode of a log, in the order the episodes were recorded. */
export function foldReward(
  episodes: readonly Episode[],
  rewardConfig: RewardConfig = DEFAULT_REWARD_CONFIG,
): LearningRewardState {
  let aggregate = emptyRewardAggregate();
  let sum = 0;
  for (const episode of episodes) {
    const input = rewardInputOf(episode);
    if (!input) continue;
    const reward = computeReward(input, rewardConfig).total;
    aggregate = updateRewardAggregate(aggregate, reward);
    sum += reward;
  }
  return { aggregate, sum: Math.round(sum * 10_000) / 10_000 };
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
    evidenceProvenance: null,
    reward: { aggregate: emptyRewardAggregate(), sum: 0 },
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
  private readonly evidenceProvenance: readonly EpisodeProvenance[] | null;
  private state: LearningState = emptyLearningState();
  private runContext: LearningRunContext | null = null;
  private runEpisodes: Episode[] = [];
  private loaded = false;

  // Running reward statistics over the episodes this learner trusts; persisted and rebuilt from the episode log.
  private rewardAggregate: RewardAggregate = emptyRewardAggregate();
  private rewardSum = 0;

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
    this.evidenceProvenance = options.evidenceProvenance ? [...options.evidenceProvenance].sort() : null;
    this.state = { ...emptyLearningState(), evidenceProvenance: this.evidenceProvenance };
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
    // A usable state carries its own reward statistics, so the numbers survive a restart without reading the log.
    const rewardCarried = restored !== null && restored.reward !== null;
    if (restored && rewardCarried && sameFilter(restored.evidenceProvenance, this.evidenceProvenance)) {
      this.state = restored;
      this.failureMemory.restore(restored.failureMemory);
      this.rewardAggregate = restored.reward!.aggregate;
      this.rewardSum = restored.reward!.sum;
      return this.state;
    }
    // Either there is no usable state, it was written under the old evidence rule (version 1), it predates the
    // persisted reward statistics, or it was folded from a different set of provenances than this learner trusts.
    // All of them are recomputed from the episode log, which is the source of truth and is never rewritten. What
    // the old state held that is not derived from episodes (the promoted policy and the run history) is carried
    // over, and the old file is kept as a backup.
    const legacy = parsed && typeof parsed === "object" ? legacyCarryOver(parsed as Record<string, unknown>) : null;
    const base: LearningState = {
      ...emptyLearningState(),
      evidenceProvenance: this.evidenceProvenance,
      ...(restored ? { activeWeights: restored.activeWeights, history: restored.history } : {}),
      ...(legacy ? { activeWeights: legacy.activeWeights, history: legacy.history } : {}),
    };
    if (parsed && this.stateFile) {
      const version = String((parsed as { schemaVersion?: unknown }).schemaVersion ?? "unknown");
      const reason = !restored ? `v${version}` : rewardCarried ? "evidence-filter" : "reward-stats";
      await this.backupState(parsed, reason);
    }
    this.state = await this.rebuildFromStore(base);
    if (parsed) await this.persist();
    return this.state;
  }

  /** Keeps the state file that is about to be superseded, once per kind, so a migration can always be inspected or undone. */
  private async backupState(previous: unknown, label: string): Promise<void> {
    if (!this.stateFile) return;
    const target = `${this.stateFile}.${label}.bak`;
    try {
      await readFile(target, "utf8");
      return;
    } catch {
      // not backed up yet
    }
    try {
      await writeFile(target, `${JSON.stringify(previous, null, 2)}\n`, "utf8");
    } catch (error) {
      this.logger?.warn({ err: error, target }, "Could not back up the previous learning state");
    }
  }

  /** Self-healing path: recompute the whole learner from the append-only episode log. */
  private async rebuildFromStore(base: LearningState): Promise<LearningState> {
    const { episodes: all } = await this.store.load();
    const episodes = all.filter((episode) => admitsProvenance(episode, this.evidenceProvenance ?? undefined));
    const reward = foldReward(episodes, this.rewardConfig);
    this.rewardAggregate = reward.aggregate;
    this.rewardSum = reward.sum;
    if (all.length === 0) return { ...base, reward };
    const stats = foldEpisodes(episodes);
    const memory = new FailureMemory(this.failureMemory.config);
    const runIds = [...new Set(episodes.map((episode) => episode.runId))];
    runIds.forEach((runId, index) => {
      for (const episode of episodes.filter((candidate) => candidate.runId === runId)) {
        const verdict = classifyOutcome(episode.outcome).verdict;
        if (verdict === "excluded") continue;
        if (verdict === "success" && episode.outcome.progress) {
          memory.recordSuccess({ worldKey: episode.worldKey, targetKey: episode.targetKey, runIndex: index });
          continue;
        }
        if (verdict === "success") continue;
        memory.recordFailure({
          worldKey: episode.worldKey,
          targetKey: episode.targetKey,
          goalClass: episode.features.goalClass,
          failureCode: episode.outcome.failureCode,
          runIndex: index,
        });
      }
    });
    this.failureMemory.restore(memory.snapshot(runIds.length));
    const weights = derivePolicyWeights(stats, {
      config: this.weightConfig,
      episodes: episodes.length,
      runs: runIds.length,
    });
    return {
      ...base,
      runs: all.length === 0 ? 0 : [...new Set(all.map((episode) => episode.runId))].length,
      episodes: all.length,
      lastRunId: all.at(-1)?.runId ?? null,
      stats,
      failureMemory: memory.snapshot(runIds.length),
      candidateWeights: weights,
      evidenceProvenance: this.evidenceProvenance,
      reward,
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
    return { episodes: this.rewardAggregate.count, sum: this.rewardSum };
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
        provenance: draft.provenance ?? "unlabelled",
        targetKey: draft.targetKey,
        features: draft.features,
        outcome: draft.outcome,
      });
      this.runEpisodes.push(episode);
      const evidenceEpisode = admitsProvenance(episode, this.evidenceProvenance ?? undefined);

      // Compute the reward signal only from evidence this learner trusts. The episode remains in the append-only
      // log either way; filtering here keeps live counters aligned with the rebuild path and provenance contract.
      try {
        const rewardInput = rewardInputOf(episode);
        if (rewardInput && evidenceEpisode) {
          const reward = computeReward(rewardInput, this.rewardConfig);
          this.rewardAggregate = updateRewardAggregate(this.rewardAggregate, reward.total);
          this.rewardSum += reward.total;
        }
      } catch {
        // Reward computation must never break episode recording
      }

      // Update class-level failure memory for failures
      try {
        if (evidenceEpisode && draft.outcome.status !== "succeeded" && draft.outcome.failureCode && draft.targetKey) {
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
        } else if (evidenceEpisode && draft.outcome.status === "succeeded" && draft.outcome.progress && draft.targetKey) {
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
    if (episodes.length > 0) {
      await this.store.appendMany(episodes);
      // A completed run is a persistence boundary. Do not write the state/checkpoint ahead of a buffered
      // episode log: recovery and the provenance audit both treat that append-only log as their source of truth.
      await this.store.flush();
    }

    const state = this.state;
    const stats = { ...state.stats };
    let successes = 0;
    let failures = 0;
    let excludedCount = 0;
    // Episodes outside the trusted provenances are logged (above) but are not evidence for this learner; they used
    // to be counted in the run report and in the checkpoint metadata anyway, so a demo episode could raise the
    // "successes" a promotion check reads.
    let discardedByProvenance = 0;
    for (const episode of episodes) {
      const verdict = classifyOutcome(episode.outcome).verdict;
      if (!admitsProvenance(episode, this.evidenceProvenance ?? undefined)) {
        discardedByProvenance += 1;
        continue;
      }
      if (verdict === "success") successes += 1;
      else if (verdict === "failure") failures += 1;
      else excludedCount += 1;
      const key = episodeContextKey(episode.features);
      stats[key] = applyEpisode(stats[key] ?? emptySkillStat(), episode);
      // Failure memory: only world-anchored targets are remembered, only for outcomes that say something about the
      // target (a dropped connection or a safety refusal does not make a tree a bad tree), and a later success at the
      // same target weakens the lesson instead of leaving a permanent ban.
      if (verdict !== "excluded" && episode.targetKey && episode.worldKey) {
        if (verdict === "failure") {
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
      evidenceProvenance: this.evidenceProvenance,
      reward: { aggregate: this.rewardAggregate, sum: Math.round(this.rewardSum * 10_000) / 10_000 },
      history: [
        {
          runId,
          at: new Date().toISOString(),
          episodes: episodes.length,
          promoted: report.promoted ?? false,
          note:
            report.note ??
            `${successes} verified successful / ${failures} failed actions${excludedCount > 0 ? `, ${excludedCount} excluded (not evidence about the choice)` : ""}${discardedByProvenance > 0 ? `, ${discardedByProvenance} outside this learner's provenance (logged, not counted)` : ""}${pruned > 0 ? `, ${pruned} stale failure memories pruned` : ""}`,
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
              meanReward: this.rewardAggregate.mean,
              ewmaReward: this.rewardAggregate.ewma,
              positiveRate: this.rewardAggregate.positiveRate,
              minReward: this.rewardAggregate.min,
              maxReward: this.rewardAggregate.max,
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
      ...(discardedByProvenance > 0 ? { discardedByProvenance } : {}),
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
      await writeFileAtomic(this.stateFile, `${serialized}\n`);
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
        meanReward: this.rewardAggregate.mean,
        ewmaReward: this.rewardAggregate.ewma,
        positiveRate: this.rewardAggregate.positiveRate,
        totalEpisodes: this.rewardAggregate.count,
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

  /**
   * Everything the Learning panel shows that `snapshot()` does not carry: per-context evidence with the weight it
   * produced, the failure codes behind the numbers, how much of the log each provenance contributed, which outcomes
   * were excluded from the evidence and why, and the most recent runs. Computed from the state and the episode log;
   * nothing here is stored, so it cannot drift from them.
   */
  async detail(): Promise<LearnerDetail> {
    await this.load();
    const { episodes } = await this.store.load();
    const config = { ...DEFAULT_POLICY_WEIGHT_CONFIG, ...this.weightConfig };
    const weights = this.state.candidateWeights;
    const byProvenance: LearnerDetail["totals"]["byProvenance"] = {};
    const runs = new Map<string, { runId: string; at: string; taskId: string; provenance: EpisodeProvenance; episodes: number; successes: number; failures: number; excluded: number; lastFailureCode: string | null; worldKey: string | null }>();
    for (const episode of episodes) {
      const provenance = episodeProvenanceOf(episode).provenance;
      const verdict = classifyOutcome(episode.outcome);
      const bucket = (byProvenance[provenance] ??= { episodes: 0, runs: 0, successes: 0, failures: 0, excluded: 0, usedAsEvidence: admitsProvenance(episode, this.evidenceProvenance ?? undefined) });
      bucket.episodes += 1;
      if (verdict.verdict === "success") bucket.successes += 1;
      else if (verdict.verdict === "failure") bucket.failures += 1;
      else bucket.excluded += 1;
      const run = runs.get(episode.runId) ?? { runId: episode.runId, at: episode.timestamp, taskId: episode.taskId, provenance, episodes: 0, successes: 0, failures: 0, excluded: 0, lastFailureCode: null, worldKey: episode.worldKey };
      run.episodes += 1;
      run.at = episode.timestamp;
      if (verdict.verdict === "success") run.successes += 1;
      else if (verdict.verdict === "failure") run.failures += 1;
      else run.excluded += 1;
      // Only a verdict that is evidence sets the run's failure code: an excluded outcome (safety refusal, lost
      // session, wrong game mode) is not a failure of the run, and its code used to be shown as "Last failure".
      if (verdict.verdict === "failure") run.lastFailureCode = verdict.reason ?? episode.outcome.failureCode;
      runs.set(episode.runId, run);
    }
    for (const run of runs.values()) {
      const bucket = byProvenance[run.provenance];
      if (bucket) bucket.runs += 1;
    }
    const contexts: LearnerContextDetail[] = Object.entries(this.state.stats)
      .map(([key, stat]): LearnerContextDetail => {
        const [skillId = "", goalClass = "", distanceBand = "", threat = "", vitality = ""] = key.split("|");
        const entry = weights.entries[key] ?? null;
        const successRate = stat.attempts === 0 ? null : Math.round((stat.successes / stat.attempts) * 1_000) / 1_000;
        const topFailures = Object.entries(stat.failureCodes).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 4).map(([code, count]) => ({ code, count }));
        return {
          key,
          skillId,
          goalClass,
          distanceBand,
          threat,
          vitality,
          attempts: stat.attempts,
          successes: stat.successes,
          successRate,
          conservativeSuccessRate: stat.attempts === 0 ? null : Math.round(conservativeSuccessRate(stat) * 1_000) / 1_000,
          weight: entry ? entry.weight : null,
          weightEvidence: entry ? entry.evidence : null,
          weightStatus: entry ? "learned" : stat.attempts < config.minSamples ? "insufficient-evidence" : "neutral",
          minSamples: config.minSamples,
          contradictedConfirmations: stat.contradictedConfirmations,
          safetyDenials: stat.safetyDenials,
          excluded: stat.excluded ?? 0,
          topFailures,
          meanDurationMs: Math.round(stat.ewmaDurationMs),
          progressRate: stat.attempts === 0 ? null : Math.round((stat.progressCount / stat.attempts) * 1_000) / 1_000,
        };
      })
      .sort((left, right) => right.attempts - left.attempts || left.key.localeCompare(right.key));
    const failureTotals = new Map<string, number>();
    const excludedReasons: Record<string, number> = {};
    let excludedTotal = 0;
    let contradicted = 0;
    for (const stat of Object.values(this.state.stats)) {
      for (const [code, count] of Object.entries(stat.failureCodes)) failureTotals.set(code, (failureTotals.get(code) ?? 0) + count);
      for (const [reason, count] of Object.entries(stat.excludedReasons ?? {})) excludedReasons[reason] = (excludedReasons[reason] ?? 0) + count;
      excludedTotal += stat.excluded ?? 0;
      contradicted += stat.contradictedConfirmations;
    }
    const failures: LearnerFailureDetail[] = [...failureTotals.entries()]
      .map(([code, count]) => {
        const classified = classifyFailure(code);
        return { code, count, kind: classified.kind, label: classified.label, hint: classified.hint, retryable: classified.retryable };
      })
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
      .slice(0, 20);
    return {
      enabled: this.enabled,
      evidenceProvenance: this.evidenceProvenance ? [...this.evidenceProvenance] : null,
      totals: { runs: this.state.runs, episodes: this.state.episodes, byProvenance },
      policy: {
        activeId: this.state.activeWeights?.id ?? null,
        activeContexts: this.state.activeWeights ? Object.keys(this.state.activeWeights.entries).length : 0,
        candidateId: weights.id,
        candidateSource: weights.source,
        candidateContexts: Object.keys(weights.entries).length,
        minSamples: config.minSamples,
        weightRange: [config.minWeight, config.maxWeight],
        influencesDecisions: this.useCandidateWeights ? "candidate" : this.state.activeWeights ? "active" : "none",
      },
      contexts,
      failures,
      excluded: { total: excludedTotal, reasons: excludedReasons },
      contradictions: { total: contradicted },
      recentRuns: [...runs.values()].slice(-20).reverse(),
      history: this.state.history,
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

  /**
   * Clean up resources and ensure all buffered data is written to disk.
   */
  async close(): Promise<void> {
    if ("flush" in this.store) {
      await (this.store as { flush: () => Promise<void> }).flush();
    }
  }
}

function sameFilter(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** The parts of an older state that are not derived from episodes and must survive a recomputation. */
function legacyCarryOver(raw: Record<string, unknown>): { activeWeights: PolicyWeights | null; history: LearningState["history"] } | null {
  const activeWeights = parsePolicyWeights(raw.activeWeights);
  const history = Array.isArray(raw.history)
    ? raw.history.filter((entry): entry is LearningState["history"][number] => typeof entry === "object" && entry !== null && typeof (entry as { runId?: unknown }).runId === "string").slice(0, HISTORY_LIMIT)
    : [];
  return { activeWeights: activeWeights && Object.keys(activeWeights.entries).length > 0 ? activeWeights : null, history };
}

/**
 * Reads the persisted reward statistics. A state written before they existed has none, and the caller then
 * recomputes them from the episode log (which is the source of truth) instead of showing a zeroed panel.
 */
function parseLearningRewardState(value: unknown): LearningRewardState | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { aggregate?: unknown; sum?: unknown };
  if (typeof raw.aggregate !== "object" || raw.aggregate === null) return null;
  const aggregate = parseRewardAggregate(raw.aggregate);
  if (aggregate.count === 0) return null;
  return { aggregate, sum: typeof raw.sum === "number" && Number.isFinite(raw.sum) ? raw.sum : aggregate.mean * aggregate.count };
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
    evidenceProvenance: Array.isArray(raw.evidenceProvenance) ? ([...raw.evidenceProvenance].sort() as EpisodeProvenance[]) : null,
    reward: parseLearningRewardState(raw.reward),
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
