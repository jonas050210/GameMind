/**
 * Hierarchical failure memory. Extends the existing per-target failure memory with class-level
 * patterns: "mining stone with wooden pickaxe always fails" rather than just "this specific stone
 * block at (10, 64, -3) is unreachable".
 *
 * This enables the agent to generalise failure lessons: if it fails to mine stone at one location,
 * it should avoid mining stone at *any* location until it has better tools, not just avoid that
 * specific block.
 *
 * The hierarchy:
 *  1. Target-level: "oak_log@12,64,-3 is unreachable" (existing)
 *  2. Class-level: "mine:stone fails without iron pickaxe" (new)
 *  3. Configuration-level: "gather:log at night without shelter fails" (new)
 */

export interface ClassFailurePattern {
  /** Pattern key: e.g. "mine|stone|no_iron_pickaxe" */
  readonly patternKey: string;
  /** The skill+goal combination that failed. */
  readonly skillId: string;
  readonly goalClass: string;
  /** Optional condition that must hold for the pattern to apply. */
  readonly condition: string | null;
  /** Number of times this pattern has been observed. */
  readonly attempts: number;
  /** Number of distinct targets that exhibited this pattern. */
  readonly distinctTargets: number;
  /** Last time this pattern was observed (run index). */
  readonly lastRunIndex: number;
  /** Whether this pattern has enough evidence to block. */
  readonly blocked: boolean;
}

export interface ClassFailureMemoryConfig {
  /** Minimum distinct targets before a class-level pattern is considered reliable. */
  readonly minDistinctTargets: number;
  /** Minimum total attempts for a class-level pattern. */
  readonly minAttempts: number;
  /** Runs without reinforcement before a class pattern decays. */
  readonly forgetAfterRuns: number;
  /** Half-life for class-level penalties. */
  readonly decayHalfLifeRuns: number;
  /** Maximum penalty a class-level pattern can apply. */
  readonly maxPenalty: number;
  /** Maximum number of class-level patterns to track. */
  readonly maxPatterns: number;
}

export const DEFAULT_CLASS_FAILURE_CONFIG: ClassFailureMemoryConfig = {
  minDistinctTargets: 3,
  minAttempts: 5,
  forgetAfterRuns: 60,
  decayHalfLifeRuns: 20,
  maxPenalty: 0.35,
  maxPatterns: 128,
};

export class ClassFailureMemory {
  private readonly patterns = new Map<string, ClassFailurePattern>();
  private readonly config: ClassFailureMemoryConfig;
  /** Track which targets contributed to each pattern (for distinctTargets count). */
  private readonly patternTargets = new Map<string, Set<string>>();

  constructor(config: Partial<ClassFailureMemoryConfig> = {}) {
    this.config = { ...DEFAULT_CLASS_FAILURE_CONFIG, ...config };
  }

  get size(): number {
    return this.patterns.size;
  }

  /**
   * Record a class-level failure. The pattern key should encode the skill, goal, and relevant
   * condition (e.g. "mine|stone|no_iron_pickaxe").
   */
  recordFailure(input: {
    readonly patternKey: string;
    readonly skillId: string;
    readonly goalClass: string;
    readonly condition: string | null;
    readonly targetKey: string | null;
    readonly runIndex: number;
  }): void {
    const { patternKey } = input;
    const previous = this.patterns.get(patternKey);
    const targets = this.patternTargets.get(patternKey) ?? new Set<string>();
    if (input.targetKey) targets.add(input.targetKey);
    this.patternTargets.set(patternKey, targets);

    const attempts = (previous?.attempts ?? 0) + 1;
    const distinctTargets = targets.size;
    const blocked =
      attempts >= this.config.minAttempts && distinctTargets >= this.config.minDistinctTargets;

    const pattern: ClassFailurePattern = {
      patternKey,
      skillId: input.skillId,
      goalClass: input.goalClass,
      condition: input.condition,
      attempts,
      distinctTargets,
      lastRunIndex: input.runIndex,
      blocked,
    };
    this.patterns.set(patternKey, pattern);
    this.enforceCap();
  }

  /** A success at a target weakens the pattern, but doesn't erase it immediately. */
  recordSuccess(input: {
    readonly patternKey: string;
    readonly targetKey: string | null;
    readonly runIndex: number;
  }): void {
    const previous = this.patterns.get(input.patternKey);
    if (!previous) return;
    // Remove target from the set
    if (input.targetKey) {
      const targets = this.patternTargets.get(input.patternKey);
      if (targets) {
        targets.delete(input.targetKey);
        this.patternTargets.set(input.patternKey, targets);
      }
    }
    // Reduce attempts (but don't go below 0)
    const attempts = Math.max(0, previous.attempts - 1);
    const distinctTargets = (this.patternTargets.get(input.patternKey) ?? new Set()).size;
    const blocked =
      attempts >= this.config.minAttempts && distinctTargets >= this.config.minDistinctTargets;

    this.patterns.set(input.patternKey, {
      ...previous,
      attempts,
      distinctTargets,
      lastRunIndex: input.runIndex,
      blocked,
    });
  }

  /** Get the penalty for a pattern, accounting for decay. */
  penaltyFor(patternKey: string, runIndex: number): number {
    const pattern = this.patterns.get(patternKey);
    if (!pattern) return 0;
    const age = Math.max(0, runIndex - pattern.lastRunIndex);
    const strength = age === 0 ? 1 : 0.5 ** (age / Math.max(1, this.config.decayHalfLifeRuns));
    if (strength <= 0) return 0;
    const basePenalty = Math.min(this.config.maxPenalty, 0.08 * pattern.attempts);
    const penalty = basePenalty * strength;
    return penalty <= 0.005 ? 0 : Math.round(penalty * 1000) / 1000;
  }

  /** Check if a pattern blocks actions of this class. */
  isBlocked(patternKey: string, runIndex: number): boolean {
    const pattern = this.patterns.get(patternKey);
    if (!pattern || !pattern.blocked) return false;
    return runIndex - pattern.lastRunIndex < this.config.forgetAfterRuns;
  }

  /** Check if any matching pattern blocks a given skill+goal combination. */
  findBlockingPattern(
    skillId: string,
    goalClass: string,
    condition: string | null,
    runIndex: number,
  ): ClassFailurePattern | null {
    for (const pattern of this.patterns.values()) {
      if (pattern.skillId !== skillId || pattern.goalClass !== goalClass) continue;
      if (condition && pattern.condition && pattern.condition !== condition) continue;
      if (!condition && pattern.condition) continue;
      if (this.isBlocked(pattern.patternKey, runIndex)) return pattern;
    }
    return null;
  }

  /** Get all active patterns for reporting. */
  activePatterns(runIndex: number): readonly ClassFailurePattern[] {
    const result: ClassFailurePattern[] = [];
    for (const pattern of this.patterns.values()) {
      const age = runIndex - pattern.lastRunIndex;
      if (age >= this.config.forgetAfterRuns) continue;
      result.push(pattern);
    }
    return result.sort((a, b) => b.attempts - a.attempts);
  }

  prune(runIndex: number): number {
    let dropped = 0;
    for (const [key, pattern] of this.patterns) {
      if (runIndex - pattern.lastRunIndex >= this.config.forgetAfterRuns) {
        this.patterns.delete(key);
        this.patternTargets.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  private enforceCap(): void {
    while (this.patterns.size > this.config.maxPatterns) {
      const oldest = [...this.patterns.entries()].sort(
        (a, b) => a[1].lastRunIndex - b[1].lastRunIndex,
      )[0];
      if (!oldest) return;
      this.patterns.delete(oldest[0]);
      this.patternTargets.delete(oldest[0]);
    }
  }

  snapshot(): {
    readonly patterns: readonly ClassFailurePattern[];
    readonly config: ClassFailureMemoryConfig;
  } {
    return {
      patterns: [...this.patterns.values()],
      config: this.config,
    };
  }

  restore(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const raw = data as { patterns?: unknown };
    if (!Array.isArray(raw.patterns)) return;
    for (const entry of raw.patterns) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Partial<ClassFailurePattern>;
      if (typeof e.patternKey !== "string" || typeof e.attempts !== "number") continue;
      this.patterns.set(e.patternKey, {
        patternKey: e.patternKey,
        skillId: typeof e.skillId === "string" ? e.skillId : "unknown",
        goalClass: typeof e.goalClass === "string" ? e.goalClass : "unknown",
        condition: typeof e.condition === "string" ? e.condition : null,
        attempts: Math.max(1, Math.trunc(e.attempts)),
        distinctTargets: Math.max(0, Math.trunc(e.distinctTargets ?? 1)),
        lastRunIndex: typeof e.lastRunIndex === "number" && Number.isFinite(e.lastRunIndex) ? e.lastRunIndex : 0,
        blocked: e.blocked === true,
      });
    }
  }
}

/**
 * Derive a class-level pattern key from episode data.
 * This extracts the generalisable pattern from a specific failure.
 */
export function deriveClassPatternKey(
  skillId: string,
  goalClass: string,
  failureCode: string | null,
  equipmentTier: string | null,
  timeOfDay: string | null,
): string {
  const parts = [skillId, goalClass];
  if (failureCode) parts.push(failureCode);
  if (equipmentTier && equipmentTier !== "none") parts.push(`eq:${equipmentTier}`);
  if (timeOfDay && timeOfDay !== "unknown") parts.push(timeOfDay);
  return parts.join("|");
}
