/**
 * Training-only exploration, offline unit tests. The rule must (a) never switch a safety-band decision, (b) never switch
 * into a fight, (c) be deterministic for a seed and sequence, and (d) do nothing at epsilon 0. Every switch is returned
 * so the caller can record it; there is no silent path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionCandidate } from "../src/core/decision-model.js";
import { BAND_PROGRESS, BAND_SAFETY } from "../src/games/minecraft/decision-model.js";
import { exploreDecision } from "../src/games/minecraft/training-exploration.js";

function candidate(goalId: string, priorityBand: number, skillId: string | null = "minecraft.navigate"): DecisionCandidate {
  return { goalId, priorityBand, score: 100, skillId, input: {}, targetKey: `t:${goalId}`, rationale: goalId } as unknown as DecisionCandidate;
}

function decision(selected: DecisionCandidate, alternatives: DecisionCandidate[]) {
  return { selected, alternatives, plan: [selected.goalId] };
}

test("epsilon 0 never switches, so the greedy policy is unchanged", () => {
  const d = decision(candidate("a", BAND_PROGRESS), [candidate("b", BAND_PROGRESS)]);
  for (let sequence = 0; sequence < 50; sequence += 1) {
    const result = exploreDecision(d, { epsilon: 0, seed: 7 }, sequence);
    assert.equal(result.choice, null);
    assert.equal(result.decision, d);
  }
});

test("a safety-band (flee, reflex, hazard) decision is never switched, whatever epsilon says", () => {
  const d = decision(candidate("avoid-hazard", BAND_SAFETY), [candidate("collect", BAND_PROGRESS)]);
  for (let sequence = 0; sequence < 200; sequence += 1) {
    assert.equal(exploreDecision(d, { epsilon: 1, seed: 3 }, sequence).choice, null);
  }
});

test("a fight is never chosen as an exploratory alternative", () => {
  const d = decision(candidate("collect", BAND_PROGRESS), [candidate("defend", BAND_PROGRESS, "minecraft.attack-hostile")]);
  for (let sequence = 0; sequence < 200; sequence += 1) {
    assert.equal(exploreDecision(d, { epsilon: 1, seed: 3 }, sequence).choice, null, "no switch into a fight");
  }
});

test("the same seed and sequence always give the same decision (reproducible)", () => {
  const d = decision(candidate("a", BAND_PROGRESS), [candidate("b", BAND_PROGRESS), candidate("c", BAND_PROGRESS)]);
  const first = exploreDecision(d, { epsilon: 0.5, seed: 11 }, 4);
  const second = exploreDecision(d, { epsilon: 0.5, seed: 11 }, 4);
  assert.deepEqual(first.choice, second.choice);
});

test("an epsilon of 1 switches every eligible decision, records the switch, and selects a real alternative", () => {
  const alternatives = [candidate("b", BAND_PROGRESS), candidate("c", BAND_PROGRESS)];
  const d = decision(candidate("a", BAND_PROGRESS), alternatives);
  let switched = 0;
  for (let sequence = 0; sequence < 100; sequence += 1) {
    const result = exploreDecision(d, { epsilon: 1, seed: 5 }, sequence);
    assert.ok(result.choice, "epsilon 1 always switches");
    assert.equal(result.choice.fromGoalId, "a");
    assert.ok(["b", "c"].includes(result.choice.toGoalId));
    assert.equal(result.decision.selected?.goalId, result.choice.toGoalId);
    assert.deepEqual(result.decision.plan, [result.choice.toGoalId]);
    switched += 1;
  }
  assert.equal(switched, 100);
});

test("the switch rate tracks epsilon over many decisions (the draw is not biased)", () => {
  const d = decision(candidate("a", BAND_PROGRESS), [candidate("b", BAND_PROGRESS)]);
  let switched = 0;
  const trials = 4_000;
  for (let sequence = 0; sequence < trials; sequence += 1) {
    if (exploreDecision(d, { epsilon: 0.25, seed: 99 }, sequence).choice) switched += 1;
  }
  const rate = switched / trials;
  assert.ok(Math.abs(rate - 0.25) < 0.03, `observed switch rate ${rate.toFixed(3)} should be near 0.25`);
});

test("a headless experiment refuses to write into an existing directory, so earlier evidence is never overwritten", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runHeadlessExperiment } = await import("../src/training/experiment.js");
  const outDir = await mkdtemp(join(tmpdir(), "gamemind-exp-"));
  try {
    await mkdir(join(outDir, "taken"));
    await assert.rejects(
      runHeadlessExperiment({ name: "taken", outDir, episodesPerStage: 1, maxEpisodes: 1, explorationRate: 0, evaluationSeeds: 1 }),
      /already exists/,
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
