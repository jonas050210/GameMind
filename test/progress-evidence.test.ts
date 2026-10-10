/**
 * What counts as an action that "did something", and what that figure is allowed to steer.
 *
 * Until now only a gained item or a gained food point counted, so every exploration leg, approach, rest and retreat was
 * reported as a wasted action and recorded as "no progress". These tests pin the replacement down: each rule is a
 * before/after comparison of observations with a threshold, unknown values never create progress, and the broader evidence
 * feeds the measurements (the wasted-action figure, the recorded episode) but never the decisions of the loop.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ExperienceLearner } from "../src/core/learning/learner.js";
import {
  CLOSER_BY_BLOCKS,
  HEALTH_GAIN_POINTS,
  PROGRESS_DEFINITION,
  RETREAT_BY_BLOCKS,
  distanceToInputTarget,
  nearestHostileDistance,
  observedMovementProgress,
  type MovementEvidenceInput,
} from "../src/games/minecraft/progress-evidence.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { runEvaluationOnce } from "../src/testing/eval/harness.js";
import { evaluationSetId } from "../src/training/evaluate.js";
import { observationAt } from "./support/observations.js";

const at = (x: number, z = 0, overrides: Partial<MinecraftObservation> = {}): MinecraftObservation => observationAt({ x, y: 64, z }, overrides);
const zombie = (distance: number) => ({ id: "z1", name: "zombie", type: "hostile", position: { x: 5, y: 64, z: 5 }, distance, health: 20 }) as unknown as MinecraftObservation["entities"][number];

function evidence(overrides: Partial<MovementEvidenceInput>) {
  return observedMovementProgress({
    skillId: "minecraft.navigate",
    goalId: "approach:oak_log",
    safetyBand: false,
    movesToTarget: true,
    input: { x: 40, y: 64, z: 0, range: 3 },
    before: at(0),
    after: at(30),
    cellsRevealed: 0,
    ...overrides,
  });
}

test("exploration is an effect when it reveals ground the agent had never seen, and only exploration is judged that way", () => {
  const explored = evidence({ goalId: "explore:resource", movesToTarget: false, cellsRevealed: 3, after: at(0) });
  assert.equal(explored.progress, true);
  assert.match(explored.evidence ?? "", /revealed 3 map cells the agent had never seen/);
  assert.match(evidence({ goalId: "explore:food", movesToTarget: false, cellsRevealed: 1, after: at(0) }).evidence ?? "", /revealed 1 map cell the agent/);
  assert.equal(evidence({ goalId: "explore:resource", movesToTarget: false, cellsRevealed: 0, after: at(0) }).progress, false, "a leg that revealed nothing is waste");
  assert.equal(evidence({ goalId: "collect:oak_log", movesToTarget: false, cellsRevealed: 5, after: at(0) }).progress, false, "revealed cells only count for a goal whose purpose is exploring");
});

test("an approach counts when it ends measurably closer to its target, not when it ends level or farther", () => {
  const closer = evidence({});
  assert.equal(closer.progress, true);
  assert.match(closer.evidence ?? "", /ended 30\.0 blocks closer to its target \(40\.5 blocks → 10\.5 blocks\)/);
  assert.equal(evidence({ after: at(CLOSER_BY_BLOCKS / 2) }).progress, false, `closing less than ${CLOSER_BY_BLOCKS} block is within measurement noise`);
  assert.equal(evidence({ after: at(0) }).progress, false, "standing still is not an approach");
  assert.equal(evidence({ after: at(-8) }).progress, false, "moving away is not an approach");
  assert.equal(evidence({ movesToTarget: false }).progress, false, "a skill that does not travel (mining, placing) is never credited for distance");
});

test("an input with no position gives no distance, never a zero that could look like arrival", () => {
  const state = at(0);
  assert.equal(distanceToInputTarget(state, null), null);
  assert.equal(distanceToInputTarget(state, "text"), null);
  assert.equal(distanceToInputTarget(state, {}), null);
  assert.equal(distanceToInputTarget(state, { x: 4 }), null);
  assert.ok((distanceToInputTarget(state, { x: 4, z: 0 }) ?? 0) > 3);
  assert.equal(evidence({ input: { item: "oak_planks", count: 4 } }).progress, false);
});

test("a rest counts only when health rose, never from an unknown value, and no other skill is credited for regeneration", () => {
  const hurt = (health: number | null): MinecraftObservation => {
    const base = at(0);
    return { ...base, player: { ...base.player, health } };
  };
  const rest = (before: number | null, after: number | null, skillId = "minecraft.rest") => evidence({ skillId, goalId: "rest:recover-health", movesToTarget: false, input: {}, before: hurt(before), after: hurt(after) });
  const healed = rest(10, 10 + HEALTH_GAIN_POINTS + 3);
  assert.equal(healed.progress, true);
  assert.match(healed.evidence ?? "", /health rose from 10 to 14/);
  assert.equal(rest(10, 10).progress, false);
  assert.equal(rest(10, 8).progress, false);
  assert.equal(rest(null, 14).progress, false, "unknown health before is unknown, not zero");
  assert.equal(rest(10, null).progress, false);
  assert.equal(rest(10, 14, "minecraft.navigate").progress, false, "passive regeneration during a walk is not the walk's doing");
});

test("a retreat counts when the nearest hostile ends clearly farther or out of view, and only for safety actions", () => {
  const retreat = (before: MinecraftObservation["entities"], after: MinecraftObservation["entities"], safetyBand = true) =>
    evidence({ goalId: "avoid-nearby-hostile", safetyBand, movesToTarget: false, input: {}, before: at(0, 0, { entities: before }), after: at(0, 0, { entities: after }) });
  const farther = retreat([zombie(3)], [zombie(3 + RETREAT_BY_BLOCKS + 2)]);
  assert.equal(farther.progress, true);
  assert.match(farther.evidence ?? "", /the nearest hostile is now 7\.0 blocks away \(was 3\.0 blocks\)/);
  const gone = retreat([zombie(3)], []);
  assert.equal(gone.progress, true);
  assert.match(gone.evidence ?? "", /no hostile is in view any more \(the nearest was 3\.0 blocks away\)/);
  assert.equal(retreat([zombie(3)], [zombie(3 + RETREAT_BY_BLOCKS - 1)]).progress, false, "a step away that leaves it nearly as close is not an escape");
  assert.equal(retreat([zombie(3)], [zombie(2)]).progress, false, "it closed in");
  assert.equal(retreat([], []).progress, false, "nothing to retreat from");
  assert.equal(retreat([zombie(3)], [], false).progress, false, "the same movement outside the safety band is not credited as an escape");
  assert.equal(nearestHostileDistance(at(0, 0, { entities: [zombie(9), zombie(4)] })), 4);
  assert.equal(nearestHostileDistance(at(0)), null);
});

test("figures are only comparable under the same definition of progress and waste, so the definition is part of the evaluation set's identity", () => {
  const scenarios = evaluationScenarios();
  const seeds = [1, 2, 3];
  const id = evaluationSetId(scenarios, seeds, "model-a");
  assert.equal(id, evaluationSetId(scenarios, seeds, "model-a", PROGRESS_DEFINITION), "the current definition is the default");
  assert.notEqual(id, evaluationSetId(scenarios, seeds, "model-a", "item-and-food-gains-only.v1"), "a baseline recorded under another definition is not this set's baseline");
  assert.notEqual(id, evaluationSetId(scenarios, seeds, "model-b"));
  assert.notEqual(id, evaluationSetId(scenarios, [1, 2, 4], "model-a"));
  assert.match(PROGRESS_DEFINITION, /^verified-world-progress\.v\d+$/);
});

test("simulator: exploration that revealed ground is not reported as waste, while the loop still sees no gathering progress", async () => {
  const scenario = evaluationScenarios().find((entry) => entry.id === "food-none-reachable");
  assert.ok(scenario);
  const run = await runEvaluationOnce(scenario, 101);
  assert.equal(run.success, false, "there is no food to find: more exploring cannot make this run succeed");
  assert.ok(run.metrics.explorationLegs >= 3, "the agent explored");
  assert.equal(run.metrics.wastedActions, 0, "every leg revealed ground it had not seen, so none of them was wasted (the old rule reported all of them as waste)");
  assert.equal(run.metrics.progressEvents, 0, "no item or food was gained: the signal that drives target exclusion and the autonomy controller's cooldown is unchanged, so exploring cannot reset those brakes");
});

test("simulator: a run that keeps failing to move on is still reported as wasteful", async () => {
  const scenario = evaluationScenarios().find((entry) => entry.id === "recovery-persistent-stall");
  assert.ok(scenario);
  const run = await runEvaluationOnce(scenario, 101);
  assert.equal(run.success, false);
  assert.ok(run.metrics.wastedActions >= 2, `stalled attempts that changed nothing stay wasted (got ${run.metrics.wastedActions} of ${run.metrics.actions})`);
  assert.equal(run.metrics.progressEvents, 0);
});

test("simulator: the learner records an exploration leg that revealed ground as progress, so its progress rate is not a permanent zero", async () => {
  const scenario = evaluationScenarios().find((entry) => entry.id === "food-remote-berries");
  assert.ok(scenario);
  const learner = new ExperienceLearner();
  await runEvaluationOnce(scenario, 101, { learner, worldKey: "progress-evidence-world", provenance: "training" });
  const detail = await learner.detail();
  const explore = detail.contexts.find((context) => context.key.startsWith("minecraft.navigate|explore|"));
  assert.ok(explore, `an exploration context was learned (got ${detail.contexts.map((context) => context.key).join(", ")})`);
  assert.ok(explore.attempts >= 2);
  assert.equal(explore.progressRate, 1, "the legs that revealed ground are progress in the recorded episodes (they used to be recorded as none)");
});
