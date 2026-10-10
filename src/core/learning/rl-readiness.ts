/**
 * RL readiness interfaces. These define the contracts a future learned policy must satisfy to
 * integrate with the existing decision model, safety broker, and evaluation pipeline. They do NOT
 * implement RL — they only specify what a learned component must look like to be plugged in.
 *
 * The key insight: a learned policy must be a drop-in replacement for PolicyAdvisor, must accept
 * vectorized observations, and must be evaluable by the existing evaluation harness. It does not
 * need to own the environment loop or the safety checks.
 *
 * RL readiness criteria (what must be true before RL is viable):
 *  1. State representation: continuous features, not banded. ✓ (episode-extended.ts provides these)
 *  2. Action representation: a finite set of parameterized actions with bounded continuous inputs.
 *     ✗ (Mineflayer skills have continuous {x,y,z} but the decision model enumerates ~16 skill IDs)
 *  3. Environment: can reset and step millions of times per hour.
 *     ✗ (Mineflayer is too slow; simulator is too simplified for transfer)
 *  4. Reward signal: well-defined, anti-exploitation, validated against human judgement.
 *     ✓ (reward.ts provides this, but is unvalidated against real gameplay)
 *  5. Safety constraints: the learned policy cannot bypass the Safety Broker.
 *     ✓ (the safety broker sits outside any policy)
 *  6. Evaluation: learned policy is evaluable by the existing harness.
 *     ✗ (PolicyAdvisor interface exists but no learned implementation yet)
 *  7. Sim-to-real transfer: evidence that simulator-trained policies work in real Minecraft.
 *     ✗ (no live testing infrastructure exists yet)
 *  8. Training throughput: at least 10,000 steps/second for PPO.
 *     ✗ (neither simulator nor Mineflayer can achieve this)
 */

import type { PolicyAdvisor, PolicyAssessment, PolicyFeatureQuery } from "./policy-advisor.js";
import type { PolicyWeights } from "./policy-weights.js";

/**
 * A learned policy is anything that implements PolicyAdvisor. The existing evaluation harness
 * can compare a learned advisor against the baseline using the same scenarios and seeds.
 *
 * This interface is deliberately narrow: the learned component only adjusts candidate scores.
 * It cannot create goals, change priority bands, or unlock capabilities.
 */
export interface LearnedPolicyAdvisor extends PolicyAdvisor {
  /** The model version (e.g. checkpoint ID). Changes when the model is retrained. */
  readonly modelVersion: string;
  /** Training metadata. */
  readonly trainingInfo: {
    readonly algorithm: string;
    readonly totalSteps: number;
    readonly episodes: number;
    readonly environment: string;
    readonly trainedAt: string;
    readonly meanReward: number;
    readonly meanEpisodeLength: number;
  };
  /** Whether this advisor can be safely serialised and restored without code changes. */
  readonly serialisable: boolean;
  /** Serialise the model to a buffer for checkpointing. */
  serialise(): Uint8Array;
}

/**
 * Vectorized observation that a future RL agent would consume.
 * This is what the current banded features should evolve toward.
 *
 * NOTE: This is a design document, not an active interface. The current system uses
 * EpisodeFeatures (banded) for learning. This shows what a future continuous representation
 * would look like.
 */
export interface VectorizedObservation {
  /** Agent state. */
  readonly health: number;           // [0, 20]
  readonly hunger: number;           // [0, 20]
  readonly saturation: number;       // [0, 20]
  readonly armor: number;            // [0, 20]
  readonly position: readonly [number, number, number];  // [x, y, z]
  readonly velocity: readonly [number, number, number];  // [vx, vy, vz]
  readonly isOnGround: boolean;
  readonly isInWater: boolean;

  /** Local environment (e.g. 5×5×5 block grid, one-hot encoded). */
  readonly localBlocks: readonly number[];  // flattened, length = 125

  /** Nearest entities: [type_embedding, dx, dy, dz, distance, isHostile]. */
  readonly nearestEntities: readonly (readonly number[])[];  // top 8 entities

  /** Inventory: [item_embedding, count] for top 16 slots. */
  readonly inventory: readonly (readonly number[])[];

  /** Equipment. */
  readonly heldItem: number;          // item embedding
  readonly heldDurability: number;    // [0, 1]

  /** Task context. */
  readonly currentGoal: number;       // goal embedding
  readonly goalProgress: number;      // [0, 1]
  readonly timeRemaining: number;     // [0, 1]
  readonly timeOfDay: number;         // [0, 1]
  readonly biome: number;             // biome embedding

  /** Memory features. */
  readonly knownResourcePositions: readonly (readonly number[])[];  // top 5 resources
  readonly knownThreatPositions: readonly (readonly number[])[];    // top 5 threats
  readonly explorationCoverage: number;  // [0, 1]
}

/**
 * Action representation for a future learned policy.
 *
 * The current system has 16 skill IDs with continuous {x, y, z} parameters.
 * A future learned policy would output a probability distribution over skill IDs
 * plus continuous parameters for the selected skill.
 */
export interface LearnedAction {
  readonly skillIndex: number;  // index into a fixed skill list
  readonly parameters: {
    readonly x: number;    // [-64, 64] relative offset
    readonly y: number;    // [-64, 64] relative offset
    readonly z: number;    // [-64, 64] relative offset
    readonly range: number; // [0, 32] interaction range
  };
}

/**
 * Environment interface for a future RL training loop.
 * This is what a Mineflayer-based or simulator-based training environment must implement.
 */
export interface TrainingEnvironment {
  /** Reset to a new episode. Returns the initial observation. */
  reset(seed?: number): Promise<VectorizedObservation>;
  /** Execute an action. Returns the next observation, reward, and done flag. */
  step(action: LearnedAction): Promise<{
    observation: VectorizedObservation;
    reward: number;
    done: boolean;
    info: Record<string, unknown>;
  }>;
  /** Number of parallel environments (for vectorized training). */
  readonly numEnvs: number;
  /** Steps per second throughput. */
  readonly stepsPerSecond: number;
  /** Close the environment and free resources. */
  close(): Promise<void>;
}

/**
 * Policy promotion gate for learned policies.
 * A learned policy must pass this gate before becoming active, just like the current
 * statistical policies. The gate checks:
 *  1. Safety: no new unsafe actions compared to baseline.
 *  2. Performance: success rate ≥ baseline - tolerance.
 *  3. Reward: mean reward ≥ baseline - tolerance.
 *  4. Generalisation: no regression on held-out scenarios.
 */
export interface LearnedPolicyGate {
  evaluate(
    learned: PolicyAdvisor,
    baseline: PolicyAdvisor,
    scenarios: readonly string[],
    seeds: number,
  ): Promise<{
    passed: boolean;
    safetyRegressions: number;
    performanceDelta: number;
    rewardDelta: number;
    scenariosPassed: number;
    scenariosFailed: number;
    recommendation: string;
  }>;
}

/**
 * RL readiness score. Evaluates whether the prerequisites for RL training are met.
 * Returns a score 0-100 and a list of blockers.
 */
export function assessRLReadiness(): {
  score: number;
  maxScore: number;
  blockers: readonly string[];
  ready: readonly string[];
} {
  const criteria: { name: string; met: boolean; weight: number; blocker: string }[] = [
    {
      name: "Continuous state representation",
      met: true,  // episode-extended.ts provides continuous features
      weight: 15,
      blocker: "",
    },
    {
      name: "Action parameterisation",
      met: false, // skills have continuous params but no probability distribution
      weight: 10,
      blocker: "Need π(a|s) output; current system outputs discrete skill choices",
    },
    {
      name: "Reward function",
      met: true,  // reward.ts provides multi-objective reward
      weight: 15,
      blocker: "",
    },
    {
      name: "Reward validation",
      met: false, // reward function is untested against real gameplay
      weight: 10,
      blocker: "Reward must be validated against human judgement on real Minecraft data",
    },
    {
      name: "Fast training environment",
      met: false, // simulator is too simple; Mineflayer is too slow
      weight: 20,
      blocker: "Need ≥10k steps/sec with faithful Minecraft mechanics",
    },
    {
      name: "Sim-to-real transfer evidence",
      met: false, // no live testing exists
      weight: 15,
      blocker: "Must demonstrate that simulator-trained policies transfer to real Minecraft",
    },
    {
      name: "Live Minecraft testing",
      met: false, // no Docker-based test infrastructure
      weight: 10,
      blocker: "Need automated testing against a real Minecraft 1.20.4 server",
    },
    {
      name: "Safety broker integration",
      met: true,  // safety broker is external to any policy
      weight: 5,
      blocker: "",
    },
  ];

  const ready: string[] = [];
  const blockers: string[] = [];
  let score = 0;
  let maxScore = 0;

  for (const criterion of criteria) {
    maxScore += criterion.weight;
    if (criterion.met) {
      score += criterion.weight;
      ready.push(criterion.name);
    } else {
      blockers.push(`${criterion.name}: ${criterion.blocker}`);
    }
  }

  return { score, maxScore, blockers, ready };
}
