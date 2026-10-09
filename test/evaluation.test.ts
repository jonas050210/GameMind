import assert from "node:assert/strict";
import test from "node:test";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { evaluationSeeds, runEvaluationSuite } from "../src/testing/eval/harness.js";

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
