import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";
import type { DecisionCandidate } from "../src/core/decision-model.js";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import {
  MinecraftTaskDecisionModel,
  type MinecraftDecisionContext,
  type MinecraftDecisionRecord,
} from "../src/games/minecraft/decision-model.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { DEFAULT_GATHER_LOG_TASK, type MinecraftTask } from "../src/games/minecraft/task.js";
import { MinecraftTaskRunner } from "../src/games/minecraft/task-runner.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";
import { logAt, simulatedWorld } from "../src/testing/simulated-minecraft/scenarios.js";

/** Alternates between two navigation targets forever unless the runner requests recovery. */
class OscillatingModel extends MinecraftTaskDecisionModel {
  private calls = 0;

  override decide(
    state: MinecraftObservation,
    task: MinecraftTask,
    context: MinecraftDecisionContext,
    observationSequence = 0,
  ): MinecraftDecisionRecord {
    if (context.stuck) return super.decide(state, task, { ...context, stuck: context.stuck }, observationSequence);
    // Targets three blocks apart keep each navigation a real move, so only the oscillation check can fire.
    const x = this.calls % 2 === 0 ? 2 : -1;
    this.calls += 1;
    const selected: DecisionCandidate = {
      goalId: "oscillate",
      priorityBand: 2,
      score: 1,
      skillId: "minecraft.navigate",
      input: { x, y: 64, z: 0, range: 1 },
      targetKey: null,
      rationale: "Alternate between two cells (test double).",
    };
    return {
      modelId: "oscillating-test-double",
      decidedAt: new Date().toISOString(),
      observationSequence,
      selected,
      alternatives: [],
      terminalStatus: null,
      summary: "oscillating test double",
      plan: ["oscillate"],
      band: 2,
      knowledge: { observations: 0, resourceBlocks: {}, ripeBerryBushes: 0, foodItems: 0, exploredCells: 0, trackedHostiles: 0 },
    };
  }
}

test("oscillation between nearby cells is detected and triggers a recovery request, within the action budget", async () => {
  const logger = pino({ level: "silent" });
  const sink = new MemoryTraceSink();
  const adapter = new SimulatedMinecraftAdapter({ definition: simulatedWorld({ seed: 31 }) });
  const { runtime, skills } = createMinecraftAgent(adapter, new TraceRecorder(sink, logger), logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new OscillatingModel(), logger, {
    clock: () => adapter.simulatedNowMs,
  });
  const result = await runner.run({ ...DEFAULT_GATHER_LOG_TASK, maxActions: 12, maxExplorationLegs: 0 });

  assert.ok(result.metrics.oscillations >= 1, "the back-and-forth pattern was detected");
  assert.ok(result.actions.some((action) => action.goalId === "recover:sidestep"), "a recovery sidestep was requested");
  assert.ok(result.metrics.actions <= 12, "the task stayed within its action budget");
  assert.notEqual(result.status, "succeeded");
  await runtime.shutdown("oscillation test complete");
});

test("a single unobservable obstacle stalls the route; the agent sidesteps, retries, and succeeds", async () => {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === "recovery-single-hidden-obstacle");
  assert.ok(scenario);
  const logger = pino({ level: "silent" });
  // Seed 102 routes through the hidden cell; seed 101 routes around it and never stalls.
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(102) });
  const { runtime, skills } = createMinecraftAgent(adapter, new TraceRecorder(new MemoryTraceSink(), logger), logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
  });
  const result = await runner.run(scenario.task());

  assert.equal(result.status, "succeeded", result.failure?.message);
  assert.ok(result.metrics.stuckActions >= 1);
  assert.ok(result.metrics.recoveryAttempts >= 1);
  assert.ok(result.metrics.successfulRecoveries >= 1);
  assert.equal(result.actions[0]?.failureCode, "NAVIGATION_STUCK");
  await runtime.shutdown("hidden obstacle test complete");
});

test("failed route recovery does not end the run before an alternative tree can be tried", async () => {
  const logger = pino({ level: "silent" });
  const blockedTree = { x: 8, z: 0 };
  const ring = [-1, 0, 1]
    .flatMap((dx) => [-1, 0, 1].map((dz) => ({ x: blockedTree.x + dx, z: blockedTree.z + dz })))
    .filter((cell) => cell.x !== blockedTree.x || cell.z !== blockedTree.z);
  const adapter = new SimulatedMinecraftAdapter({
    definition: simulatedWorld({
      seed: 404,
      placements: [logAt(blockedTree.x, blockedTree.z), logAt(0, 16)],
      stallCells: ring,
    }),
  });
  const { runtime, skills } = createMinecraftAgent(adapter, new TraceRecorder(new MemoryTraceSink(), logger), logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
  });
  const result = await runner.run({ ...DEFAULT_GATHER_LOG_TASK, maxActions: 18, maxConsecutiveFailures: 2, maxExplorationLegs: 0 });

  assert.equal(result.status, "succeeded", result.failure?.message);
  assert.ok(result.metrics.stuckActions >= 1);
  assert.ok(result.actions.some((action) => action.failureCode === "NAVIGATION_STUCK"));
  assert.ok(result.actions.some((action) => action.goalId === "collect:oak_log" && action.status === "succeeded"));
  await runtime.shutdown("alternative target recovery complete");
});

test("a route with no way around ends in a bounded, explicit stop rather than a loop", async () => {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === "recovery-persistent-stall");
  assert.ok(scenario);
  const logger = pino({ level: "silent" });
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(101) });
  const { runtime, skills } = createMinecraftAgent(adapter, new TraceRecorder(new MemoryTraceSink(), logger), logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
  });
  const result = await runner.run(scenario.task());

  assert.notEqual(result.status, "succeeded");
  assert.ok(result.metrics.actions <= scenario.task().maxActions);
  assert.ok(["blocked", "failed", "max_actions"].includes(result.status), `terminal status '${result.status}'`);
  assert.equal(result.metrics.unsafeActions, 0);
  await runtime.shutdown("persistent stall test complete");
});
