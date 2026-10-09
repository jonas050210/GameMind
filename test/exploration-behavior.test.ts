import assert from "node:assert/strict";
import test from "node:test";
import { evaluationScenarios, type EvaluationScenario } from "../src/testing/eval/scenarios.js";
import { runEvaluationOnce } from "../src/testing/eval/harness.js";
import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import { MinecraftTaskRunner } from "../src/games/minecraft/task-runner.js";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";

function scenario(id: string): EvaluationScenario {
  const found = evaluationScenarios().find((candidate) => candidate.id === id);
  assert.ok(found, `scenario ${id} exists`);
  return found;
}

test("a log outside the initial scan is found by exploration and then collected", async () => {
  let explored = 0;
  for (const seed of [101, 138, 175, 213, 250, 288]) {
    const run = await runEvaluationOnce(scenario("explore-remote-log"), seed);
    assert.equal(run.status, "succeeded", `seed ${seed}`);
    assert.ok(run.metrics.explorationLegs >= 1, `seed ${seed} needed exploration`);
    explored += run.metrics.explorationLegs;
  }
  assert.ok(explored > 6, "exploration was used across the sample");
});

test("with exploration disabled the same remote log is never found and nothing is risked", async () => {
  const base = scenario("explore-remote-log");
  const disabled: EvaluationScenario = {
    ...base,
    task: () => gatherResourceTaskSchema.parse({ id: "no-explore", resourceName: "oak_log", targetCount: 1, maxExplorationLegs: 0 }),
  };
  const run = await runEvaluationOnce(disabled, 101);
  assert.equal(run.status, "blocked");
  assert.equal(run.metrics.explorationLegs, 0);
  assert.equal(run.metrics.actions, 0);
});

test("every exploration waypoint stays within the configured radius of the task start", async () => {
  const base = scenario("explore-remote-log");
  const radius = 30;
  const bounded: EvaluationScenario = {
    ...base,
    task: () => gatherResourceTaskSchema.parse({
      id: "bounded-explore",
      resourceName: "oak_log",
      targetCount: 1,
      maxExplorationLegs: 6,
      explorationRadius: radius,
    }),
  };
  const logger = pino({ level: "silent" });
  for (const seed of [101, 138, 175]) {
    const sink = new MemoryTraceSink();
    const adapter = new SimulatedMinecraftAdapter({ definition: bounded.world(seed) });
    const { runtime, skills } = createMinecraftAgent(adapter, new TraceRecorder(sink, logger), logger);
    const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
      clock: () => adapter.simulatedNowMs,
    });
    await runner.run(bounded.task());
    const waypoints = sink.events
      .filter((event) => event.eventType === "decision.made")
      .map((event) => (event.data as { selected: { goalId: string; input: { x: number; z: number } } | null }).selected)
      .filter((selected): selected is { goalId: string; input: { x: number; z: number } } => selected?.goalId.startsWith("explore:") === true);
    for (const waypoint of waypoints) {
      // Waypoints are cell centres inside the radius; one coverage cell (8 blocks) of rounding is allowed.
      const distance = Math.hypot(waypoint.input.x - 0.5, waypoint.input.z - 0.5);
      assert.ok(distance <= radius + 8, `seed ${seed}: waypoint ${waypoint.input.x},${waypoint.input.z} is ${distance.toFixed(1)} from the start`);
    }
    assert.ok(waypoints.length <= 6, "the leg budget is never exceeded");
    await runtime.shutdown("bounded exploration test complete");
  }
});

test("exploration never leaves the bounded legs: blocked runs report an explicit reason", async () => {
  const base = scenario("food-none-reachable");
  const run = await runEvaluationOnce(base, 101);
  assert.equal(run.status, "blocked");
  assert.ok(run.metrics.explorationLegs <= 6);
  assert.equal(run.metrics.unsafeActions, 0);
});
