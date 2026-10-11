import assert from "node:assert/strict";
import test from "node:test";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { evaluationSeeds, runEvaluationOnce, runEvaluationSuite } from "../src/testing/eval/harness.js";

test("the offline evaluation gates hold on a regression sample of seeds", async () => {
  const report = await runEvaluationSuite(evaluationScenarios(), evaluationSeeds(8));
  for (const scenario of report.scenarios) {
    for (const gate of scenario.gates) {
      assert.ok(gate.passed, `${scenario.scenarioId}: ${gate.name} — ${gate.detail}`);
    }
  }
  assert.equal(report.totals.unsafeActions, 0, "no action may start under threat");
  assert.equal(report.totals.unverifiedConfirmations, 0, "no confirmation may contradict the observed state");
  assert.equal(report.totals.deaths, 0, "no seed may reach zero health");
  assert.equal(report.passed, true);
});

test("evaluation runs retain specific action failures for intermittent-action diagnosis", async () => {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === "replanning-removed-log");
  assert.ok(scenario);
  const run = await runEvaluationOnce(scenario, 841);

  assert.equal(run.actionFailures.length, 1);
  assert.deepEqual(
    {
      goalId: run.actionFailures[0]?.goalId,
      skillId: run.actionFailures[0]?.skillId,
      failureCode: run.actionFailures[0]?.failureCode,
      targetKey: run.actionFailures[0]?.targetKey,
    },
    {
      goalId: "collect:oak_log",
      skillId: "minecraft.collect-log",
      failureCode: "RESOURCE_TARGET_CHANGED",
      targetKey: "-4,64,9",
    },
  );
});

test("the disappearing-log scenario keeps its farther replacement inside the initial wide scan", () => {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === "replanning-removed-log");
  assert.ok(scenario);
  for (const seed of evaluationSeeds(200)) {
    const world = scenario.world(seed);
    const removal = world.schedule.find((event) => event.type === "remove_block");
    assert.ok(removal && removal.type === "remove_block");
    const near = world.placements.find((block) => block.name === "oak_log" && block.x === removal.x && block.z === removal.z);
    const replacement = world.placements.find((block) => block.name === "oak_log" && (block.x !== removal.x || block.z !== removal.z));
    assert.ok(near && replacement, `seed ${seed} must contain the removed target and its replacement`);
    const player = { x: world.player.x + 0.5, y: world.groundY + 1, z: world.player.z + 0.5 };
    const distanceTo = (block: { x: number; y: number; z: number }): number =>
      Math.hypot(block.x + 0.5 - player.x, block.y + 0.5 - player.y, block.z + 0.5 - player.z);
    assert.ok(distanceTo(replacement) > distanceTo(near), `seed ${seed} replacement is farther`);
    assert.ok(distanceTo(replacement) <= 24, `seed ${seed} replacement is within the initial 24-block scan`);
  }
});

test("the suite covers every required behaviour family with bounded, explicit expectations", () => {
  const scenarios = evaluationScenarios();
  const families = new Set(scenarios.map((scenario) => scenario.family));
  for (const family of ["exploration", "crafting", "food", "survival", "recovery", "replanning"]) {
    assert.ok(families.has(family as never), `family '${family}' is covered`);
  }
  assert.ok(scenarios.length >= 10);
  for (const scenario of scenarios.filter((candidate) => candidate.expectation === "success")) {
    assert.ok(scenario.minSuccessRate >= 0.8, `${scenario.id} keeps the 80% acceptance floor`);
  }
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length, "scenario ids are unique");
});

test("evaluation is deterministic: the same seeds reproduce identical aggregates", async () => {
  const seeds = evaluationSeeds(3);
  const strip = (report: Awaited<ReturnType<typeof runEvaluationSuite>>) => ({
    ...report,
    generatedAt: "fixed",
  });
  const first = strip(await runEvaluationSuite(evaluationScenarios(), seeds));
  const second = strip(await runEvaluationSuite(evaluationScenarios(), seeds));
  assert.deepEqual(first, second);
});
