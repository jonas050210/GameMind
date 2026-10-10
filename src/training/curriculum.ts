import { evaluationScenarios, type EvaluationScenario } from "../testing/eval/scenarios.js";
import { evaluationSeeds } from "../testing/eval/harness.js";

/**
 * Training curriculum and the seed split that keeps training and evaluation apart.
 *
 * Training episodes use seeds from `TRAINING_SEED_BASE` upward. Evaluation uses `evaluationSeeds(n)`, which
 * are small numbers (101, 138, …). The two ranges cannot meet, and `assertSeedSplit` checks that at run time,
 * so a checkpoint is never scored on a world it was trained on. Scenario *families* are shared between the two
 * sides (a stage trains on the same kinds of task the evaluation suite measures); what is held out is the
 * world seed. The report says so rather than claiming a broader generalisation.
 */

export const TRAINING_SEED_BASE = 1_000_000;

/**
 * Exploration offered to a new run. Greedy training (0) only ever records the top-ranked candidate of each decision, so
 * the learner never sees how an alternative would have gone and cannot learn to prefer one. A modest, seeded rate gives
 * it that counterfactual evidence; 0 is still available (`--explore 0`) and means exactly what it says.
 */
export const DEFAULT_TRAINING_EXPLORATION_RATE = 0.15;

export interface CurriculumStage {
  readonly id: string;
  readonly label: string;
  /** Scenario ids (from the offline suite) cycled through during this stage. */
  readonly scenarioIds: readonly string[];
  /** Minimum episodes before the pass check is applied. */
  readonly minEpisodes: number;
  /** Success rate over the stage's episodes that moves training on to the next stage. */
  readonly passRate: number;
}

export const TRAINING_STAGES: readonly CurriculumStage[] = [
  {
    id: "basics",
    label: "Gathering and recovery from a blocked route",
    scenarioIds: [
      "explore-remote-log",
      "recovery-single-hidden-obstacle",
      "replanning-removed-log",
      "recovery-persistent-stall",
    ],
    minEpisodes: 8,
    passRate: 0.75,
  },
  {
    id: "food",
    label: "Securing food and eating before gathering",
    scenarioIds: ["food-remote-berries", "food-dropped-bread", "survival-eat-before-gather", "survival-rest-then-gather"],
    minEpisodes: 8,
    passRate: 0.75,
  },
  {
    id: "tools-and-shelter",
    label: "Tool gating, stone and shelter",
    scenarioIds: [
      "explore-craft-pickaxe",
      "mine-stone-with-pickaxe",
      "mine-stone-needs-pickaxe",
      "shelter-close-cardinal-sides",
      "shelter-before-night-when-hurt",
    ],
    minEpisodes: 8,
    passRate: 0.6,
  },
];

/** Resolves the curriculum's scenario ids against the offline suite; throws if one has been renamed away. */
export function curriculumScenarios(stages: readonly CurriculumStage[] = TRAINING_STAGES): Map<string, EvaluationScenario> {
  const byId = new Map(evaluationScenarios().map((scenario) => [scenario.id, scenario] as const));
  for (const stage of stages) {
    for (const id of stage.scenarioIds) {
      if (!byId.has(id)) throw new Error(`Curriculum stage "${stage.id}" names unknown scenario "${id}".`);
    }
  }
  return byId;
}

/** Deterministic training seed for the n-th training episode. Monotonic, so a resumed run never repeats one. */
export function trainingSeed(episodeIndex: number): number {
  return TRAINING_SEED_BASE + episodeIndex;
}

/** Throws when any training seed in the first `episodes` episodes collides with an evaluation seed. */
export function assertSeedSplit(evaluationSeedCount: number, episodes: number): void {
  const evaluation = new Set(evaluationSeeds(evaluationSeedCount));
  for (let index = 0; index < episodes; index += 1) {
    const seed = trainingSeed(index);
    if (evaluation.has(seed)) throw new Error(`Training seed ${seed} collides with an evaluation seed.`);
  }
}
