/**
 * Enhanced learner wrapper. Extends the base ExperienceLearner with:
 *  1. Reward computation per episode
 *  2. Policy checkpoint store
 *  3. Class-level failure memory
 *  4. Extended episode features
 *  5. Experiment tracking
 *
 * This wraps the existing learner rather than replacing it, so all existing tests pass unchanged.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { ExperienceLearner, type LearningRunContext, type LearningRunReport, type EpisodeDraft } from "./learner.js";
import type { PolicyAdvisor } from "./policy-advisor.js";
import type { PolicyWeights } from "./policy-weights.js";
import { computeReward, DEFAULT_REWARD_CONFIG, type RewardBreakdown, type RewardConfig, type RewardInput } from "./reward.js";
import { PolicyCheckpointStore, ExperimentStore, type ExperimentRecord } from "./checkpoint.js";
import { ClassFailureMemory, deriveClassPatternKey, type ClassFailureMemoryConfig } from "./class-failure-memory.js";
import type { ExtendedFeatures } from "./episode-extended.js";

export interface EnhancedEpisodeDraft extends EpisodeDraft {
  readonly extendedFeatures?: ExtendedFeatures;
  readonly taskTargetItem?: string | null;
  readonly taskTargetCount?: number;
  readonly taskItemsCollected?: number;
}

export interface EnhancedRunReport extends LearningRunReport {
  readonly rewardStats: {
    readonly meanReward: number;
    readonly ewmaReward: number;
    readonly minReward: number;
    readonly maxReward: number;
    readonly positiveRate: number;
  };
  readonly classFailurePatterns: number;
  readonly checkpointId: string | null;
}

export interface EnhancedLearnerOptions {
  readonly learner: ExperienceLearner;
  readonly rewardConfig?: Partial<RewardConfig>;
  readonly classFailureConfig?: Partial<ClassFailureMemoryConfig>;
  readonly checkpointDir?: string;
  readonly logger?: Logger | null;
}

export interface EnhancedSnapshot {
  readonly base: ReturnType<ExperienceLearner["snapshot"]>;
  readonly rewardStats: {
    readonly totalEpisodes: number;
    readonly meanReward: number;
    readonly ewmaReward: number;
    readonly positiveRate: number;
  };
  readonly classFailure: {
    readonly patterns: number;
    readonly blockedPatterns: number;
    readonly topPatterns: readonly {
      readonly patternKey: string;
      readonly attempts: number;
      readonly distinctTargets: number;
      readonly blocked: boolean;
    }[];
  };
  readonly checkpoints: {
    readonly total: number;
    readonly activeId: string | null;
    readonly recent: readonly { id: string; reason: string; createdAt: string }[];
  };
  readonly experiments: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly promoted: boolean;
  }[];
}

export class EnhancedLearner {
  private readonly base: ExperienceLearner;
  private readonly rewardConfig: RewardConfig;
  private readonly classFailure: ClassFailureMemory;
  private readonly checkpoints: PolicyCheckpointStore;
  private readonly experiments: ExperimentStore;
  private readonly logger: Logger | null;

  // Running reward statistics
  private totalRewardEpisodes = 0;
  private meanReward = 0;
  private ewmaReward = 0;
  private positiveRewardCount = 0;
  private minReward = Infinity;
  private maxReward = -Infinity;

  constructor(options: EnhancedLearnerOptions) {
    this.base = options.learner;
    this.rewardConfig = { ...DEFAULT_REWARD_CONFIG, ...options.rewardConfig };
    this.classFailure = new ClassFailureMemory(options.classFailureConfig);
    this.checkpoints = new PolicyCheckpointStore(
      options.checkpointDir ? { directory: options.checkpointDir } : {},
    );
    this.experiments = new ExperimentStore();
    this.logger = options.logger ?? null;
  }

  /** Compute the reward for an episode and record it. */
  recordEpisodeWithReward(draft: EnhancedEpisodeDraft): {
    readonly episode: ReturnType<ExperienceLearner["recordEpisode"]>;
    readonly reward: RewardBreakdown;
  } {
    const episode = this.base.recordEpisode(draft);

    // Compute reward
    const rewardInput: RewardInput = {
      status: draft.outcome.status,
      confirmed: draft.outcome.confirmed,
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
      taskTargetItem: draft.taskTargetItem ?? null,
      taskTargetCount: draft.taskTargetCount,
      taskItemsCollected: draft.taskItemsCollected,
    };
    const reward = computeReward(rewardInput, this.rewardConfig);

    // Update running reward stats
    this.totalRewardEpisodes++;
    this.meanReward += (reward.total - this.meanReward) / this.totalRewardEpisodes;
    this.ewmaReward = this.totalRewardEpisodes === 1
      ? reward.total
      : 0.3 * reward.total + 0.7 * this.ewmaReward;
    if (reward.total > 0) this.positiveRewardCount++;
    this.minReward = Math.min(this.minReward, reward.total);
    this.maxReward = Math.max(this.maxReward, reward.total);

    // Update class-level failure memory if this was a failure
    if (draft.outcome.status !== "succeeded" && draft.outcome.failureCode) {
      const equipmentTier = draft.extendedFeatures?.equipmentTier ?? null;
      const timeOfDay = draft.features.timeOfDay;
      const patternKey = deriveClassPatternKey(
        draft.features.skillId,
        draft.features.goalClass,
        draft.outcome.failureCode,
        equipmentTier,
        timeOfDay,
      );
      this.classFailure.recordFailure({
        patternKey,
        skillId: draft.features.skillId,
        goalClass: draft.features.goalClass,
        condition: equipmentTier ? `eq:${equipmentTier}` : null,
        targetKey: draft.targetKey,
        runIndex: this.base.runIndex,
      });
    } else if (draft.outcome.status === "succeeded" && draft.outcome.progress) {
      // Success weakens matching patterns
      const equipmentTier = draft.extendedFeatures?.equipmentTier ?? null;
      const timeOfDay = draft.features.timeOfDay;
      const patternKey = deriveClassPatternKey(
        draft.features.skillId,
        draft.features.goalClass,
        null,
        equipmentTier,
        timeOfDay,
      );
      this.classFailure.recordSuccess({
        patternKey,
        targetKey: draft.targetKey,
        runIndex: this.base.runIndex,
      });
    }

    return { episode, reward };
  }

  /** Delegate to base learner. */
  beginRun(context: LearningRunContext): void {
    this.base.beginRun(context);
  }

  /** Delegate to base learner. */
  recordEpisode(draft: EpisodeDraft): ReturnType<ExperienceLearner["recordEpisode"]> {
    return this.base.recordEpisode(draft);
  }

  /** Finish the run with enhanced reporting. */
  async finishRun(report?: { readonly promoted?: boolean; readonly note?: string }): Promise<EnhancedRunReport> {
    const baseReport = await this.base.finishRun(report);

    // Save checkpoint when there are episodes to learn from
    if (baseReport.episodes > 0) {
      const checkpoint = this.checkpoints.save(
        this.base.candidateWeights,
        {
          episodes: baseReport.totalEpisodes,
          runs: baseReport.runs,
          contexts: baseReport.contexts,
          successes: baseReport.successes,
          failures: baseReport.failures,
          rewardStats: {
            meanReward: this.meanReward,
            ewmaReward: this.ewmaReward,
            positiveRate: this.totalRewardEpisodes > 0
              ? this.positiveRewardCount / this.totalRewardEpisodes
              : 0,
          },
        },
        report?.note ?? `run ${baseReport.runId}`,
      );
      await this.checkpoints.persist();

      if (report?.promoted) {
        this.checkpoints.activate(checkpoint.policyId);
        await this.checkpoints.persist();
      }
    }

    // Prune stale class patterns
    this.classFailure.prune(this.base.runIndex);

    return {
      ...baseReport,
      rewardStats: {
        meanReward: Math.round(this.meanReward * 10000) / 10000,
        ewmaReward: Math.round(this.ewmaReward * 10000) / 10000,
        minReward: this.minReward === Infinity ? 0 : Math.round(this.minReward * 10000) / 10000,
        maxReward: this.maxReward === -Infinity ? 0 : Math.round(this.maxReward * 10000) / 10000,
        positiveRate: this.totalRewardEpisodes > 0
          ? Math.round((this.positiveRewardCount / this.totalRewardEpisodes) * 1000) / 1000
          : 0,
      },
      classFailurePatterns: this.classFailure.size,
      checkpointId: this.checkpoints.active?.policyId ?? null,
    };
  }

  /** Get the advisor from the base learner. */
  advisor(): PolicyAdvisor {
    return this.base.advisor();
  }

  /** Access the class failure memory. */
  get classFailureMemory(): ClassFailureMemory {
    return this.classFailure;
  }

  /** Access the checkpoint store. */
  get checkpointStore(): PolicyCheckpointStore {
    return this.checkpoints;
  }

  /** Access the experiment store. */
  get experimentStore(): ExperimentStore {
    return this.experiments;
  }

  /** Get the base learner's snapshot plus enhanced data. */
  snapshot(): EnhancedSnapshot {
    const base = this.base.snapshot();
    const activePatterns = this.classFailure.activePatterns(this.base.runIndex);
    return {
      base,
      rewardStats: {
        totalEpisodes: this.totalRewardEpisodes,
        meanReward: Math.round(this.meanReward * 10000) / 10000,
        ewmaReward: Math.round(this.ewmaReward * 10000) / 10000,
        positiveRate: this.totalRewardEpisodes > 0
          ? Math.round((this.positiveRewardCount / this.totalRewardEpisodes) * 1000) / 1000
          : 0,
      },
      classFailure: {
        patterns: this.classFailure.size,
        blockedPatterns: activePatterns.filter((p) => p.blocked).length,
        topPatterns: activePatterns.slice(0, 10).map((p) => ({
          patternKey: p.patternKey,
          attempts: p.attempts,
          distinctTargets: p.distinctTargets,
          blocked: p.blocked,
        })),
      },
      checkpoints: {
        total: this.checkpoints.all.length,
        activeId: this.checkpoints.active?.policyId ?? null,
        recent: this.checkpoints.all.slice(-5).reverse().map((c) => ({
          id: c.policyId,
          reason: c.reason,
          createdAt: c.createdAt,
        })),
      },
      experiments: this.experiments.recent.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        promoted: e.result?.promoted ?? false,
      })),
    };
  }

  /** Promote a candidate policy with checkpoint tracking. */
  async promote(
    weights: PolicyWeights,
    note?: string,
  ): Promise<void> {
    await this.base.promote(weights, note);
    this.checkpoints.activate(weights.id);
    this.checkpoints.markGatePass(weights.id);
    await this.checkpoints.persist();
  }

  /** Rollback to the previous policy. */
  async rollback(note?: string): Promise<void> {
    const previous = this.checkpoints.rollback();
    if (previous) {
      await this.base.promote(previous.policy, note ?? "rolled back to previous checkpoint");
    } else {
      await this.base.rollback(note ?? "rolled back to baseline");
    }
    await this.checkpoints.persist();
  }

  /** Delegate: is learning enabled? */
  get enabled(): boolean {
    return this.base.enabledValue;
  }

  /** Delegate: current run context. */
  get currentRun(): LearningRunContext | null {
    return this.base.currentRun;
  }

  /** Load persisted state. */
  async load(): Promise<void> {
    await this.base.load();
    await this.checkpoints.load();
  }
}
