import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";
import { evaluationScenarios, type EvaluationScenario } from "../src/testing/eval/scenarios.js";
import { runEvaluationOnce } from "../src/testing/eval/harness.js";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { MinecraftTaskRunner } from "../src/games/minecraft/task-runner.js";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";

function scenario(id: string): EvaluationScenario {
  const found = evaluationScenarios().find((candidate) => candidate.id === id);
  assert.ok(found, `scenario ${id} exists`);
  return found;
}

test("a dropped food item is walked to, picked up, and eaten, and the food source is credited", async () => {
  const run = await runEvaluationOnce(scenario("food-dropped-bread"), 101);
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.actionGoals.slice(0, 2), ["pickup:bread", "restore-hunger"]);
  assert.equal(run.metrics.foodSourcesUsed, 1);
  assert.ok(run.metrics.foodGained > 0);
  assert.equal(run.metrics.unverifiedConfirmations, 0);
});

test("ripe berries beyond the scan are found by exploration, harvested, and eaten", async () => {
  const run = await runEvaluationOnce(scenario("food-remote-berries"), 101);
  assert.equal(run.status, "succeeded");
  assert.ok(run.metrics.explorationLegs >= 1, "the bush was not in the initial scan");
  assert.ok(run.actionGoals.some((goal) => goal.startsWith("harvest:")));
  assert.ok(run.actionGoals.includes("restore-hunger"));
  assert.ok(run.metrics.foodSourcesUsed >= 1);
});

test("the reachable food-seeking outcome holds across a seed sample for the berry scenario", async () => {
  const seeds = [101, 138, 175, 213, 250, 288, 325, 362];
  let successes = 0;
  for (const seed of seeds) {
    const run = await runEvaluationOnce(scenario("food-remote-berries"), seed);
    if (run.success) successes += 1;
    assert.equal(run.metrics.unverifiedConfirmations, 0, `seed ${seed}`);
  }
  assert.ok(successes >= 6, `at least 6 of ${seeds.length} seeds succeed, got ${successes}`);
});

test("maturing remembered berries remain reachable after exploration budget exhaustion", async () => {
  for (const seed of [397, 434]) {
    const run = await runEvaluationOnce(scenario("food-remote-berries"), seed);
    assert.equal(run.status, "succeeded", `seed ${seed}: ${run.failureCode ?? ""}`);
    assert.ok(run.actionGoals.includes("recheck:berry"), `seed ${seed} refreshed the remembered bush age`);
    assert.ok(run.actionGoals.some((goal) => goal.startsWith("harvest:")), `seed ${seed} harvested observed ripe berries`);
    assert.equal(run.metrics.unverifiedConfirmations, 0, `seed ${seed}`);
    assert.equal(run.metrics.unsafeActions, 0, `seed ${seed}`);
  }
});

test("a zombie guarding ripe berries is never approached to harvest while it is in range", async () => {
  for (const seed of [101, 138, 175, 213, 250]) {
    const run = await runEvaluationOnce(scenario("survival-zombie-guards-berries"), seed);
    assert.equal(run.metrics.unsafeActions, 0, `seed ${seed} started no action under threat`);
    assert.equal(run.died, false, `seed ${seed} stayed alive`);
  }
});

test("a hungry agent eats exactly once, before gathering, and keeps the rest of its food", async () => {
  const logger = pino({ level: "silent" });
  const sink = new MemoryTraceSink();
  const definition = scenario("survival-eat-before-gather").world(101);
  const adapter = new SimulatedMinecraftAdapter({ definition });
  const { runtime, skills } = createMinecraftAgent(adapter, new TraceRecorder(sink, logger), logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
  });
  const result = await runner.run(scenario("survival-eat-before-gather").task());
  assert.equal(result.status, "succeeded");
  assert.equal(result.actions[0]?.skillId, "minecraft.eat-food", "hunger 9 is at the threshold, so food comes first");
  assert.equal(result.actions.filter((action) => action.skillId === "minecraft.eat-food").length, 1);
  assert.equal(adapter.world.countItem("bread"), 0, "the single bread was eaten");
  await runtime.shutdown("food test complete");
});
