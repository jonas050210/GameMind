import { episodeContextKey, type DistanceBand, type ThreatBand, type TimeOfDayBand, type VitalityBand } from "./episode.js";
import type { FailureMemory } from "./failure-memory.js";
import { BASELINE_POLICY_WEIGHTS, type PolicyWeights } from "./policy-weights.js";

/**
 * The only thing the decision model is allowed to know about learning: given the features of a
 * candidate goal, how should experience change its preference? The advisor can nudge a score, and
 * it can veto a target that has already been proven unreachable in this world. It cannot create a
 * goal, change a priority band, or unlock a capability.
 */

export interface PolicyFeatureQuery {
  readonly skillId: string;
  readonly goalClass: string;
  readonly distanceBand: DistanceBand;
  readonly vitality: VitalityBand;
  readonly threat: ThreatBand;
  readonly timeOfDay: TimeOfDayBand;
  readonly targetKey: string | null;
}

export interface PolicyAssessment {
  /** Multiplies the candidate's utility score before ranking. 1 means "no learned opinion". */
  readonly multiplier: number;
  /** Absolute score penalty for a target the agent has repeatedly failed at. */
  readonly penalty: number;
  /** Set when experience proves the target itself is not worth attempting. */
  readonly blocked: { readonly reason: string } | null;
  readonly contextKey: string;
  /** Short, human-readable explanations of everything that was applied, for the decision trace. */
  readonly notes: readonly string[];
}

export interface PolicyAdvisor {
  readonly id: string;
  readonly source: "baseline" | "experience";
  assess(query: PolicyFeatureQuery): PolicyAssessment;
  /** Summary for the Control Center and the trace. */
  describe(): {
    readonly id: string;
    readonly source: string;
    readonly contexts: number;
    readonly failureEntries: number;
    readonly weights: Readonly<Record<string, number>>;
  };
}

const NEUTRAL_ASSESSMENT: PolicyAssessment = {
  multiplier: 1,
  penalty: 0,
  blocked: null,
  contextKey: "baseline",
  notes: [],
};

export class BaselinePolicyAdvisor implements PolicyAdvisor {
  readonly id = "baseline-advisor";
  readonly source = "baseline" as const;

  assess(): PolicyAssessment {
    return NEUTRAL_ASSESSMENT;
  }

  describe() {
    return { id: this.id, source: this.source, contexts: 0, failureEntries: 0, weights: {} };
  }
}

export interface ExperiencePolicyAdvisorOptions {
  readonly weights?: PolicyWeights;
  readonly failureMemory?: FailureMemory;
  readonly worldKey?: string | null;
  readonly runIndex?: number;
  readonly useTargetMemory?: boolean;
}

export class ExperiencePolicyAdvisor implements PolicyAdvisor {
  private readonly weights: PolicyWeights;
  private readonly failureMemory: FailureMemory | null;
  private readonly worldKey: string | null;
  private readonly runIndex: number;
  private readonly useTargetMemory: boolean;
  readonly id: string;
  readonly source: "baseline" | "experience";

  constructor(options: ExperiencePolicyAdvisorOptions = {}) {
    this.weights = options.weights ?? BASELINE_POLICY_WEIGHTS;
    this.failureMemory = options.failureMemory ?? null;
    this.worldKey = options.worldKey ?? null;
    this.runIndex = options.runIndex ?? 0;
    this.useTargetMemory = options.useTargetMemory ?? true;
    this.source = this.weights.source;
    this.id = this.weights.id;
  }

  assess(query: PolicyFeatureQuery): PolicyAssessment {
    const contextKey = episodeContextKey({
      skillId: query.skillId,
      goalClass: query.goalClass,
      distanceBand: query.distanceBand,
      threat: query.threat,
      vitality: query.vitality,
      timeOfDay: query.timeOfDay,
      band: 0,
      distance: 0,
      health: null,
      hunger: null,
      targetKind: "unknown",
      actionIndex: 0,
      attemptsOnTarget: 0,
    });
    const notes: string[] = [];
    let multiplier = 1;
    const entry = this.weights.entries[contextKey];
    if (entry) {
      multiplier = entry.weight;
      notes.push(
        `learned weight ×${entry.weight.toFixed(3)} from ${entry.samples} attempts (evidence ${(
          entry.evidence * 100
        ).toFixed(0)}%)`,
      );
    }

    let penalty = 0;
    let blocked: PolicyAssessment["blocked"] = null;
    if (this.useTargetMemory && this.failureMemory) {
      const memory = this.failureMemory.penaltyFor(this.worldKey, query.targetKey, this.runIndex);
      if (memory) {
        penalty = memory.penalty;
        notes.push(
          `target memory: ${memory.entry.attempts} recorded failure(s)${
            memory.entry.failureCode ? ` (${memory.entry.failureCode})` : ""
          }, penalty ${memory.penalty.toFixed(3)}`,
        );
      }
      if (this.failureMemory.isBlocked(this.worldKey, query.targetKey, this.runIndex)) {
        blocked = {
          reason: `known unreachable after ${memory?.entry.attempts ?? 3} failed attempts in this world (last: ${
            memory?.entry.failureCode ?? "unknown"
          })`,
        };
        notes.push("target blocked by learned failure memory");
      }
    }

    return { multiplier, penalty, blocked, contextKey, notes };
  }

  describe() {
    return {
      id: this.id,
      source: this.source,
      contexts: Object.keys(this.weights.entries).length,
      failureEntries: this.failureMemory?.size ?? 0,
      weights: Object.fromEntries(
        Object.entries(this.weights.entries).map(([key, entry]) => [key, entry.weight]),
      ),
    };
  }
}

export function applyAdvisorScore(
  baseScore: number,
  assessment: PolicyAssessment,
): number {
  return Math.round((baseScore * assessment.multiplier - assessment.penalty * 100) * 100) / 100;
}

export const BASELINE_ADVISOR: PolicyAdvisor = new BaselinePolicyAdvisor();
