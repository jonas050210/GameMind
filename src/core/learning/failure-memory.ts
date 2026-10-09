/**
 * Cross-run memory of known failures. Its only job is to stop the agent from walking into the same
 * proven-dead end on the next attempt in the same world, and to soften that judgement as evidence
 * ages. Entries are keyed by world + target, so a "this rock is unreachable" lesson is never
 * transferred to a different world where it would be superstition.
 */

export const FAILURE_MEMORY_VERSION = "gamemind-failure-memory-v1" as const;

export interface FailureMemoryConfig {
  /** Attempts (in one world) after which the target is treated as known-unreachable. */
  readonly blockAfterAttempts: number;
  /** Runs without reinforcement after which an entry is forgotten entirely. */
  readonly forgetAfterRuns: number;
  /** Half-life in runs for the score penalty. */
  readonly decayHalfLifeRuns: number;
  readonly maxPenalty: number;
  readonly maxEntries: number;
}

export const DEFAULT_FAILURE_MEMORY_CONFIG: FailureMemoryConfig = {
  blockAfterAttempts: 3,
  forgetAfterRuns: 40,
  decayHalfLifeRuns: 12,
  maxPenalty: 0.45,
  maxEntries: 512,
};

export interface FailureMemoryEntry {
  readonly key: string;
  readonly worldKey: string;
  readonly targetKey: string;
  readonly goalClass: string;
  readonly failureCode: string | null;
  readonly attempts: number;
  readonly firstRunIndex: number;
  readonly lastRunIndex: number;
  readonly blocked: boolean;
  readonly note: string;
}

export interface FailureMemorySnapshot {
  readonly version: typeof FAILURE_MEMORY_VERSION;
  readonly config: FailureMemoryConfig;
  readonly entries: readonly FailureMemoryEntry[];
}

function memoryKey(worldKey: string, targetKey: string): string {
  return `${worldKey}#${targetKey}`;
}

export class FailureMemory {
  private readonly entries = new Map<string, FailureMemoryEntry>();
  private configValue: FailureMemoryConfig;

  constructor(config: Partial<FailureMemoryConfig> = {}) {
    this.configValue = { ...DEFAULT_FAILURE_MEMORY_CONFIG, ...config };
  }

  get config(): FailureMemoryConfig {
    return this.configValue;
  }

  get size(): number {
    return this.entries.size;
  }

  configure(config: Partial<FailureMemoryConfig>): void {
    this.configValue = { ...this.configValue, ...config };
  }

  /** Lessons about target *kinds* apply anywhere; lessons about a specific cell need the world key. */
  static targetOnly(worldKey: string | null | undefined, targetKey: string | null | undefined): boolean {
    return !worldKey || !targetKey;
  }

  recordFailure(input: {
    readonly worldKey: string | null;
    readonly targetKey: string | null;
    readonly goalClass: string;
    readonly failureCode: string | null;
    readonly runIndex: number;
    readonly note?: string;
  }): FailureMemoryEntry | null {
    const { worldKey, targetKey } = input;
    if (!worldKey || !targetKey) return null;
    const key = memoryKey(worldKey, targetKey);
    const previous = this.entries.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const entry: FailureMemoryEntry = {
      key,
      worldKey,
      targetKey,
      goalClass: input.goalClass,
      failureCode: input.failureCode,
      attempts,
      firstRunIndex: previous?.firstRunIndex ?? input.runIndex,
      lastRunIndex: input.runIndex,
      blocked: attempts >= this.configValue.blockAfterAttempts,
      note: input.note ?? "",
    };
    this.entries.set(key, entry);
    this.enforceCap();
    return entry;
  }

  /** Success at the same target is evidence the world changed; the lesson weakens and then goes. */
  recordSuccess(input: {
    readonly worldKey: string | null;
    readonly targetKey: string | null;
    readonly runIndex: number;
  }): void {
    const { worldKey, targetKey } = input;
    if (!worldKey || !targetKey) return;
    const key = memoryKey(worldKey, targetKey);
    const previous = this.entries.get(key);
    if (!previous) return;
    const attempts = previous.attempts - 1;
    if (attempts <= 0) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, {
      ...previous,
      attempts,
      blocked: attempts >= this.configValue.blockAfterAttempts,
      lastRunIndex: input.runIndex,
    });
  }

  entryFor(worldKey: string | null, targetKey: string | null): FailureMemoryEntry | null {
    if (!worldKey || !targetKey) return null;
    return this.entries.get(memoryKey(worldKey, targetKey)) ?? null;
  }

  private strength(entry: FailureMemoryEntry, runIndex: number): number {
    const age = Math.max(0, runIndex - entry.lastRunIndex);
    if (age === 0) return 1;
    return 0.5 ** (age / Math.max(1, this.configValue.decayHalfLifeRuns));
  }

  penaltyFor(
    worldKey: string | null,
    targetKey: string | null,
    runIndex: number,
  ): { penalty: number; entry: FailureMemoryEntry } | null {
    const entry = this.entryFor(worldKey, targetKey);
    if (!entry) return null;
    const strength = this.strength(entry, runIndex);
    if (strength <= 0) return null;
    const penalty =
      Math.min(this.configValue.maxPenalty, 0.12 * entry.attempts) * strength;
    if (penalty <= 0.005) return null;
    return { penalty: Math.round(penalty * 1_000) / 1_000, entry };
  }

  isBlocked(worldKey: string | null, targetKey: string | null, runIndex: number): boolean {
    const entry = this.entryFor(worldKey, targetKey);
    if (!entry || !entry.blocked) return false;
    return runIndex - entry.lastRunIndex < this.configValue.forgetAfterRuns;
  }

  /** Drops entries that have decayed past the forget horizon. Called before persisting. */
  prune(runIndex: number): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (runIndex - entry.lastRunIndex >= this.configValue.forgetAfterRuns) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  private enforceCap(): void {
    while (this.entries.size > this.configValue.maxEntries) {
      const oldest = [...this.entries.entries()].sort(
        (left, right) => left[1].lastRunIndex - right[1].lastRunIndex,
      )[0];
      if (!oldest) return;
      this.entries.delete(oldest[0]);
    }
  }

  snapshot(runIndex = 0): FailureMemorySnapshot {
    return {
      version: FAILURE_MEMORY_VERSION,
      config: this.configValue,
      entries: [...this.entries.values()]
        .map((entry) => ({ ...entry, penalty: this.penaltyFor(entry.worldKey, entry.targetKey, runIndex)?.penalty ?? 0 }))
        .sort((left, right) => right.attempts - left.attempts || left.key.localeCompare(right.key)),
    };
  }

  restore(snapshot: unknown): void {
    this.entries.clear();
    if (typeof snapshot !== "object" || snapshot === null) return;
    const raw = snapshot as Partial<FailureMemorySnapshot>;
    if (raw.version !== FAILURE_MEMORY_VERSION || !Array.isArray(raw.entries)) return;
    for (const entry of raw.entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry.worldKey !== "string" ||
        typeof entry.targetKey !== "string" ||
        typeof entry.attempts !== "number"
      ) {
        continue;
      }
      this.entries.set(entry.key, {
        key: entry.key,
        worldKey: entry.worldKey,
        targetKey: entry.targetKey,
        goalClass: typeof entry.goalClass === "string" ? entry.goalClass : "unknown",
        failureCode: typeof entry.failureCode === "string" ? entry.failureCode : null,
        attempts: Math.max(1, Math.trunc(entry.attempts)),
        firstRunIndex: Number.isFinite(entry.firstRunIndex) ? entry.firstRunIndex : 0,
        lastRunIndex: Number.isFinite(entry.lastRunIndex) ? entry.lastRunIndex : 0,
        blocked: entry.blocked === true,
        note: typeof entry.note === "string" ? entry.note.slice(0, 200) : "",
      });
    }
  }
}
