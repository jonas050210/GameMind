/**
 * Task-aware reward signal. The reward is a scalar summary of one episode's contribution toward
 * survival, task progress, efficiency, and safety. It is the learning signal that future RL or
 * improved statistical policies would optimise. Today it drives outcome-conditioned weights and
 * is recorded with every episode for offline analysis.
 *
 * Design principles:
 *  1. Every term is bounded so one extreme event cannot dominate a context's running mean.
 *  2. Survival is the highest-priority component: death or near-death dominates.
 *  3. Genuine progress (items gained, health recovered, food consumed for a purpose) is positive;
 *     wasted actions and dangerous situations are negative.
 *  4. Exploitation terms (e.g. "ate when not hungry") are explicitly zeroed to prevent gaming.
 *  5. All terms are visible in the reward breakdown so an operator can see *why* the reward was
 *     what it was.
 */

export interface RewardBreakdown {
  /** Maintaining health and food above critical levels. Death is a large penalty. */
  readonly survival: number;
  /** Items gained toward the task goal, food/health recovered. */
  readonly progress: number;
  /** Speed: shorter durations get a small bonus for equal outcomes. */
  readonly efficiency: number;
  /** Safety denials, damage taken, dangerous situations entered. */
  readonly safety: number;
  /** Information value: first encounter with a context or resource. */
  readonly exploration: number;
  /**
   * Penalties for effort that bought nothing: repeated failures on one target, prolonged inactivity without
   * progress, wandering that does not close the distance to the goal, and consumed resources that produced
   * nothing. A recovery after earlier failures earns a small bonus here, so the term is not only negative.
   */
  readonly waste: number;
  /** Total of the above. */
  readonly total: number;
}

export interface RewardInput {
  /** Episode outcome fields. */
  readonly status: "succeeded" | "rejected" | "failed" | "timed_out" | "disconnected" | "aborted";
  readonly confirmed: boolean;
  readonly progress: boolean;
  readonly safetyDenied: boolean;
  readonly itemsGained: number;
  readonly itemsConsumed: number;
  readonly healthDelta: number;
  readonly foodDelta: number;
  readonly durationMs: number;
  readonly distanceAfter: number | null;

  /** Episode feature context. */
  readonly health: number | null;
  readonly hunger: number | null;
  readonly goalClass: string;
  readonly skillId: string;

  /** Optional: items toward a specific task target (e.g. gathering oak_log). */
  readonly taskTargetItem?: string | null;
  readonly taskTargetCount?: number | undefined;
  readonly taskItemsCollected?: number | undefined;

  /** Attempts already spent on this target in the run (for repeated-failure penalties). */
  readonly attemptsOnTarget?: number;
  /** Distance to the target before the action; with distanceAfter it shows whether the agent got closer. */
  readonly distanceBefore?: number | null;
}

export interface RewardConfig {
  /** Weight of each reward component. */
  readonly weights: {
    readonly survival: number;
    readonly progress: number;
    readonly efficiency: number;
    readonly safety: number;
    readonly exploration: number;
    readonly waste: number;
  };
  /** Duration below this (ms) gets the full efficiency bonus; above gets zero. */
  readonly fastDurationMs: number;
  /** Duration above this (ms) gets the full efficiency penalty. */
  readonly slowDurationMs: number;
  /** Penalty when health drops below this. */
  readonly criticalHealth: number;
  /** Penalty when hunger drops below this. */
  readonly criticalHunger: number;
  /** Reward for eating when actually hungry (food < this). */
  readonly hungerRewardThreshold: number;
  /** Max absolute value of any single component (prevents one term from dominating). */
  readonly componentCap: number;
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  weights: {
    survival: 2.0,
    progress: 1.5,
    efficiency: 0.5,
    safety: 1.0,
    exploration: 0.2,
    waste: 1.0,
  },
  fastDurationMs: 500,
  slowDurationMs: 5_000,
  criticalHealth: 6,
  criticalHunger: 4,
  hungerRewardThreshold: 14,
  componentCap: 3.0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeSurvival(input: RewardInput, config: RewardConfig): number {
  // Death (disconnected due to death) is the worst outcome.
  if (input.status === "disconnected") return -3.0;
  let value = 0;
  // Health loss penalty
  if (input.healthDelta < 0) {
    value += Math.max(-2.0, input.healthDelta * 0.1);
  }
  // Critical state penalty
  if (input.health !== null && input.health < config.criticalHealth) {
    value -= 0.5;
  }
  if (input.hunger !== null && input.hunger < config.criticalHunger) {
    value -= 0.3;
  }
  // Health recovery bonus (eating/resting that works)
  if (input.healthDelta > 0) {
    value += Math.min(1.0, input.healthDelta * 0.05);
  }
  return clamp(value, -config.componentCap, config.componentCap);
}

function computeProgress(input: RewardInput, config: RewardConfig): number {
  if (input.status !== "succeeded" && !input.progress) {
    // No progress: small penalty
    return -0.2;
  }
  let value = 0;

  // Genuine item gain (not from eating which is tracked as foodDelta)
  const genuineGain = Math.max(0, input.itemsGained);
  value += Math.min(2.0, genuineGain * 0.3);

  // Food gained (found berries, cooked food)
  if (input.foodDelta > 0) {
    // Only reward eating when actually hungry (prevents farming the reward)
    if (input.hunger !== null && input.hunger < config.hungerRewardThreshold) {
      value += Math.min(1.0, input.foodDelta * 0.1);
    }
    // Food gained without eating (found berries) is always useful
    if (input.goalClass === "collect" || input.goalClass === "harvest" || input.goalClass === "pickup") {
      value += Math.min(0.5, input.foodDelta * 0.05);
    }
  }

  // Task-specific progress
  if (input.taskTargetItem && input.taskItemsCollected !== undefined && input.taskTargetCount) {
    const ratio = Math.min(1, input.taskItemsCollected / Math.max(1, input.taskTargetCount));
    value += ratio * 0.5;
  }

  // Confirmation adds a small bonus
  if (input.confirmed) value += 0.1;

  return clamp(value, -config.componentCap, config.componentCap);
}

function computeEfficiency(input: RewardInput, config: RewardConfig): number {
  const { durationMs, status } = input;
  if (status !== "succeeded") return 0;

  // Faster actions get a bonus; slower actions get nothing (but no penalty — survival already handles that)
  if (durationMs <= config.fastDurationMs) {
    return 0.5;
  }
  if (durationMs >= config.slowDurationMs) {
    return -0.1; // small penalty for very slow actions
  }
  // Linear interpolation
  const ratio = (durationMs - config.fastDurationMs) / (config.slowDurationMs - config.fastDurationMs);
  return 0.5 - ratio * 0.6;
}

function computeSafety(input: RewardInput, config: RewardConfig): number {
  let value = 0;
  // Safety denials: the agent was about to do something dangerous
  if (input.safetyDenied) {
    value -= 0.3;
  }
  // Damage taken during the action
  if (input.healthDelta < -2) {
    value -= Math.min(1.0, Math.abs(input.healthDelta) * 0.1);
  }
  // Failed under dangerous conditions (inferred from low health after)
  if (input.status === "failed" && input.health !== null && input.health < config.criticalHealth) {
    value -= 0.5;
  }
  return clamp(value, -config.componentCap, config.componentCap);
}

/** Effort that produced nothing. Every term is named so a trace can say which penalty applied. */
function computeWaste(input: RewardInput, config: RewardConfig): number {
  const progressed = input.progress || (input.status === "succeeded" && input.itemsGained > 0);
  let value = 0;
  if (!progressed) {
    // Trying the same target again and again without progress: each extra attempt costs more.
    const attempts = input.attemptsOnTarget ?? 0;
    if (attempts >= 2) value -= Math.min(1.0, 0.3 * (attempts - 1));
    // A long action that changed nothing is inactivity, not work.
    if (input.durationMs >= config.slowDurationMs) value -= 0.5;
    // Movement that did not close the distance to the goal is wandering.
    const movementGoal = input.goalClass === "explore" || input.goalClass === "approach" || input.goalClass === "recheck";
    if (movementGoal && input.distanceBefore != null && input.distanceAfter != null && input.distanceAfter >= input.distanceBefore - 0.5) {
      value -= 0.3;
    }
    // Items consumed by a failed action are resource waste.
    if (input.itemsConsumed > 0) value -= 0.1 * Math.min(5, input.itemsConsumed);
  } else if ((input.attemptsOnTarget ?? 0) >= 1) {
    // Recovered: the target was reached after earlier failures.
    value += 0.3;
  }
  return clamp(value, -config.componentCap, config.componentCap);
}

function computeExploration(input: RewardInput, config: RewardConfig): number {
  // Exploration is rewarded only for explore/approach goals that succeeded
  if (input.goalClass !== "explore" && input.goalClass !== "approach") return 0;
  if (input.status !== "succeeded") return 0;
  // The further we explored (larger distance), the more informational value
  const dist = input.distanceAfter ?? 0;
  return clamp(Math.min(0.5, dist * 0.01), 0, config.componentCap);
}

export function computeReward(
  input: RewardInput,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): RewardBreakdown {
  const survival = computeSurvival(input, config);
  const progress = computeProgress(input, config);
  const efficiency = computeEfficiency(input, config);
  const safety = computeSafety(input, config);
  const exploration = computeExploration(input, config);
  const waste = computeWaste(input, config);

  const total =
    config.weights.survival * survival +
    config.weights.progress * progress +
    config.weights.efficiency * efficiency +
    config.weights.safety * safety +
    config.weights.exploration * exploration +
    config.weights.waste * waste;

  const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    survival: round4(survival),
    progress: round4(progress),
    efficiency: round4(efficiency),
    safety: round4(safety),
    exploration: round4(exploration),
    waste: round4(waste),
    total: round4(total),
  };
}

/**
 * Aggregate reward statistics for a context, used by outcome-conditioned weights.
 */
export interface RewardAggregate {
  readonly count: number;
  readonly mean: number;
  readonly ewma: number;
  readonly min: number;
  readonly max: number;
  readonly positiveRate: number;
}

const REWARD_EWMA_ALPHA = 0.3;

export function emptyRewardAggregate(): RewardAggregate {
  return { count: 0, mean: 0, ewma: 0, min: Infinity, max: -Infinity, positiveRate: 0 };
}

export function updateRewardAggregate(prev: RewardAggregate, reward: number): RewardAggregate {
  const count = prev.count + 1;
  const mean = prev.mean + (reward - prev.mean) / count;
  const ewma = prev.count === 0 ? reward : REWARD_EWMA_ALPHA * reward + (1 - REWARD_EWMA_ALPHA) * prev.ewma;
  const min = Math.min(prev.min, reward);
  const max = Math.max(prev.max, reward);
  const positives = Math.round(prev.positiveRate * prev.count) + (reward > 0 ? 1 : 0);
  const positiveRate = positives / count;
  return {
    count,
    mean: Math.round(mean * 10_000) / 10_000,
    ewma: Math.round(ewma * 10_000) / 10_000,
    min: Math.round(min * 10_000) / 10_000,
    max: Math.round(max * 10_000) / 10_000,
    positiveRate: Math.round(positiveRate * 1_000) / 1_000,
  };
}

export function parseRewardAggregate(value: unknown): RewardAggregate {
  if (typeof value !== "object" || value === null) return emptyRewardAggregate();
  const raw = value as Record<string, unknown>;
  return {
    count: typeof raw.count === "number" ? Math.max(0, raw.count) : 0,
    mean: typeof raw.mean === "number" ? raw.mean : 0,
    ewma: typeof raw.ewma === "number" ? raw.ewma : 0,
    min: typeof raw.min === "number" ? raw.min : 0,
    max: typeof raw.max === "number" ? raw.max : 0,
    positiveRate: typeof raw.positiveRate === "number" ? raw.positiveRate : 0,
  };
}
