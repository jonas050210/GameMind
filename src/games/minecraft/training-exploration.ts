/**
 * Seeded exploration for training. A purely greedy learner only ever sees the option it already prefers, so it can never
 * learn that an alternative would have been better. During training, a decision is occasionally switched to another
 * progress-band candidate, which produces experience for that alternative.
 *
 * Constraints, deliberately narrow:
 *  - only when the selected candidate is a progress-band goal (never a safety, reflex or flee decision);
 *  - only among progress-band alternatives, never into a fight (`minecraft.attack-hostile`);
 *  - deterministic: the draw depends only on (seed, observation sequence), so a run can be reproduced exactly;
 *  - every switch is returned so the caller records it in the trace. Nothing is switched silently.
 */
import type { DecisionCandidate } from "../../core/decision-model.js";
import { BAND_PROGRESS } from "./decision-model.js";

export interface ExplorationConfig {
  /** Probability in [0, 1] of switching an eligible decision to an alternative. */
  readonly epsilon: number;
  /** Seed for the episode; the same seed and sequence always give the same draw. */
  readonly seed: number;
}

export interface ExplorationChoice {
  readonly fromGoalId: string;
  readonly toGoalId: string;
  readonly observationSequence: number;
  readonly eligibleAlternatives: number;
}

interface DecisionLike {
  readonly selected: DecisionCandidate | null;
  readonly alternatives: readonly DecisionCandidate[];
  readonly plan: readonly string[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns the decision unchanged, or a copy that selects an alternative, with the switch described. */
export function exploreDecision<T extends DecisionLike>(
  decision: T,
  config: ExplorationConfig,
  observationSequence: number,
): { decision: T; choice: ExplorationChoice | null } {
  const selected = decision.selected;
  if (!selected || config.epsilon <= 0 || selected.priorityBand !== BAND_PROGRESS) {
    return { decision, choice: null };
  }
  // An alternative is a different *choice*, not a different goal name: every block target of one resource shares a
  // goal id (for example "collect:oak_log"), so comparing goal ids alone would exclude all of them and exploration
  // would never fire. The pair (goal, target) identifies the choice.
  const eligible = decision.alternatives.filter(
    (candidate) =>
      candidate.priorityBand === BAND_PROGRESS &&
      candidate.skillId !== null &&
      candidate.skillId !== "minecraft.attack-hostile" &&
      !(candidate.goalId === selected.goalId && candidate.targetKey === selected.targetKey),
  );
  if (eligible.length === 0) return { decision, choice: null };
  const draw = mulberry32((config.seed * 1_000_003 + observationSequence) | 0);
  if (draw() >= config.epsilon) return { decision, choice: null };
  const pick = eligible[Math.min(eligible.length - 1, Math.floor(draw() * eligible.length))]!;
  return {
    decision: { ...decision, selected: pick, plan: [pick.goalId] },
    choice: {
      fromGoalId: selected.goalId,
      toGoalId: pick.goalId,
      observationSequence,
      eligibleAlternatives: eligible.length,
    },
  };
}
