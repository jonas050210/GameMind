import assert from "node:assert/strict";
import test from "node:test";
import { evaluationScenarios, type EvaluationScenario } from "../src/testing/eval/scenarios.js";
import { aggregateScenario, evaluationSeeds, runEvaluationOnce, runEvaluationSuite, type EvaluationRun } from "../src/testing/eval/harness.js";

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

test("an attacking zombie is fought and killed offline, and every rule that refuses a fight is obeyed", async () => {
  const scenarios = evaluationScenarios();
  const byId = (id: string): EvaluationScenario => {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    assert.ok(scenario, `scenario '${id}' exists`);
    return scenario;
  };

  // The fight itself. Before the simulated adapter equipped a carried weapon like the live one does, this
  // scenario "passed" its goal gate on a swing that failed with COMBAT_NO_WEAPON: the goal was
  // executed, so nothing showed that no fight ever happened. These assertions are about world facts.
  const fight = byId("combat-opt-in-defence");
  const fightRuns: EvaluationRun[] = [];
  for (const seed of evaluationSeeds(4)) fightRuns.push(await runEvaluationOnce(fight, seed));
  assert.ok(fightRuns.every((run) => run.worldStats.hostilesKilled === 1), "every seed leaves the zombie dead in the world");
  assert.ok(fightRuns.every((run) => run.worldStats.damageTaken > 0), "the zombie attacks first, so this is a real fight and not a target practice");
  assert.ok(fightRuns.every((run) => run.successfulActionGoals.includes("defend")), "the swing succeeded; an attempt that failed does not count");
  assert.ok(fightRuns.every((run) => run.actionFailures.every((failure) => failure.goalId !== "defend")), "no seed has a failed attack");
  assert.ok(fightRuns.every((run) => !run.died), "the agent survives the fight it chose");
  assert.ok(aggregateScenario(fight, fightRuns).passed, "every gate of the combat scenario holds");

  // The refusals. Each of these has fighting enabled or a weapon carried, so only the rule under test can
  // be what stops the swing.
  for (const id of ["combat-denied-by-default", "combat-health-floor-refuses-fight", "combat-creeper-never-engaged"]) {
    const scenario = byId(id);
    for (const seed of evaluationSeeds(3)) {
      const run = await runEvaluationOnce(scenario, seed);
      assert.ok(!run.actionGoals.includes("defend"), `${id}: no swing may be attempted`);
      assert.equal(run.worldStats.hostilesKilled, 0, `${id}: the hostile stays alive`);
      assert.ok(!run.died, `${id}: the agent survives without fighting`);
      assert.ok(aggregateScenario(scenario, [run]).passed, `${id}: gates hold on seed ${seed}`);
    }
  }
});

function evaluationRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    scenarioId: "fake",
    seed: 0,
    status: "succeeded",
    success: true,
    safe: true,
    died: false,
    simulatedMs: 4_000,
    metrics: { actions: 4, wastedActions: 0, unsafeActions: 0, unverifiedConfirmations: 0, progressEvents: 1 } as unknown as EvaluationRun["metrics"],
    worldStats: { damageTaken: 0, minHealth: 20, starvationTicks: 0, hostilesKilled: 0 },
    actionGoals: [],
    successfulActionGoals: [],
    actionChoices: [],
    actionFailures: [],
    failureCode: null,
    ...overrides,
  };
}

function gateOf(scenario: EvaluationScenario, runs: EvaluationRun[], name: string): { passed: boolean; detail: string } {
  const gate = aggregateScenario(scenario, runs).gates.find((candidate) => candidate.name === name);
  assert.ok(gate, `${scenario.id} has a '${name}' gate`);
  return gate;
}

test("a required goal counts only when it succeeded, a forbidden one counts even when it failed", () => {
  // The two gates are deliberately asymmetric. A requirement is a claim that behaviour happened, so an
  // attempt that failed must not satisfy it - that asymmetry is the whole reason `requiredGoals`, which read
  // every executed action whatever its status, no longer exists. A prohibition is about what the agent was
  // willing to do, so a forbidden swing counts as a violation even when it landed on nothing.
  const freeing = evaluationScenarios().find((candidate) => candidate.id === "inventory-full-frees-space");
  const refusing = evaluationScenarios().find((candidate) => candidate.id === "combat-denied-by-default");
  assert.ok(freeing && refusing);

  const attemptedOnly = evaluationRun({ actionGoals: ["free-inventory"], successfulActionGoals: [] });
  const gate = gateOf(freeing, [attemptedOnly], "required-successful-goal");
  assert.equal(gate.passed, false, "a goal that was executed and failed must not satisfy the requirement");
  assert.match(gate.detail, /0\/1 seed/);

  const completed = evaluationRun({ actionGoals: ["free-inventory"], successfulActionGoals: ["free-inventory"] });
  assert.equal(gateOf(freeing, [completed], "required-successful-goal").passed, true, "the same goal, succeeded, does");

  const failedSwing = evaluationRun({ actionGoals: ["defend"], successfulActionGoals: [] });
  assert.equal(gateOf(refusing, [failedSwing], "forbidden-goal").passed, false, "a forbidden attempt is a violation even when it failed");
  assert.equal(gateOf(refusing, [evaluationRun({ actionGoals: ["explore:north"] })], "forbidden-goal").passed, true);
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
