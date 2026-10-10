import assert from "node:assert/strict";
import { test } from "node:test";
import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { MinecraftTaskRunner, type TaskActionSummary } from "../src/games/minecraft/task-runner.js";
import { chooseExplorationWaypoint, type ExplorationRequest } from "../src/games/minecraft/exploration.js";
import { REFUSED_AREA_RADIUS, REFUSED_RECHECK_DISTANCE, WorldMemory } from "../src/games/minecraft/world-memory.js";
import { profileAutonomy } from "../src/testing/autonomy-profile.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";

/*
 * Regression tests for repeated autonomous failures:
 *  - a target refused with PATH_NOT_FOUND or NAVIGATION_TARGET_TOO_FAR is not chosen again by a later subgoal
 *    while the agent is still near the place it was refused (unreachable targets);
 *  - a refused exploration frontier is not re-entered after the agent moves on (PATH_NOT_FOUND repeats);
 *  - an identical route stall is retried at most once, then the target is excluded (no-progress retries).
 */

function request(overrides: Partial<ExplorationRequest> = {}): ExplorationRequest {
  return {
    from: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    maxRadius: 64,
    minLeg: 12,
    maxLeg: 40,
    hostileAvoidRadius: 0,
    excludedKeys: new Set<string>(),
    destinationUnsafe: () => false,
    routeRisk: () => 0,
    ...overrides,
  };
}

test("refused targets are avoided only near the place they were refused", () => {
  const memory = new WorldMemory();
  memory.markRefused("refresh:0,67,34", { x: 0, z: 0 });

  assert.ok(memory.refusedTargetKeys({ x: 5, z: 5 }).has("refresh:0,67,34"), "still near the refusal: avoided");
  assert.equal(
    memory.refusedTargetKeys({ x: REFUSED_RECHECK_DISTANCE + 1, z: 0 }).has("refresh:0,67,34"),
    false,
    "after walking away the target may be tried again, because it can become reachable",
  );
  assert.equal(memory.refusedCount, 1);
});

test("a refused exploration frontier is skipped with its neighbourhood, permanently", () => {
  const memory = new WorldMemory();
  const first = chooseExplorationWaypoint(memory, request());
  assert.ok(first, "an empty memory offers a waypoint");
  // Pretend the frontier point was refused, as the runner does on PATH_NOT_FOUND.
  memory.markRefused(first.key, { x: 0, z: 0 }, { x: first.x, z: first.z });

  assert.equal(memory.isInRefusedArea({ x: first.x, z: first.z }), true);
  const next = chooseExplorationWaypoint(memory, request());
  assert.ok(next, "exploration continues elsewhere");
  assert.notEqual(next.key, first.key);
  const distance = Math.hypot(next.x - first.x, next.z - first.z);
  assert.ok(distance > REFUSED_AREA_RADIUS, `the next waypoint is outside the refused radius (${distance.toFixed(1)} blocks)`);

  // The refusal is geometry, not a position, so it still holds after the agent has moved far away.
  assert.equal(memory.isInRefusedArea({ x: first.x, z: first.z }), true);
});

test("explore PATH_NOT_FOUND is not repeated in an autonomous run beyond the loaded area", async () => {
  // explore-remote-log: the simulated world only loads 64 blocks around the origin; exploration reaches past that.
  const report = await profileAutonomy({ scenario: "explore-remote-log", seed: 101, virtualSeconds: 300 });
  const refusedExplore = (report.failedActions ?? []).filter(
    (action) => action.code === "PATH_NOT_FOUND" && action.targetKey?.startsWith("explore:"),
  );
  const keys = refusedExplore.map((action) => action.targetKey);
  assert.equal(new Set(keys).size, keys.length, `no exploration target is refused twice: ${keys.join(", ")}`);
  assert.ok(report.totalActions > 0, "the autonomous cycle still acts");
});

async function runScenario(id: string, seed: number, memory?: WorldMemory) {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === id);
  assert.ok(scenario, `scenario ${id} exists`);
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(seed) });
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
    ...(memory ? { memory } : {}),
  });
  try {
    await runtime.connect();
    return await runner.run(scenario.task());
  } finally {
    await runtime.shutdown(`${id} test finished`);
  }
}

test("a persistent route stall is bounded per target and is not reported as success", async () => {
  const result = await runScenario("recovery-persistent-stall", 101);
  const stalls = result.actions.filter((action: TaskActionSummary) => action.failureCode === "NAVIGATION_STUCK");
  const perTarget = new Map<string, number>();
  for (const action of stalls) perTarget.set(action.targetKey ?? "", (perTarget.get(action.targetKey ?? "") ?? 0) + 1);
  // The in-run bound is three identical stalls (MAX_ATTEMPTS_WITHOUT_PROGRESS); the learned block then applies across runs.
  for (const [key, count] of perTarget) {
    assert.ok(count <= 3, `target ${key} was stalled ${count} times; the in-run limit is 3`);
  }
  assert.notEqual(result.status, "succeeded", "a persistent stall must not be reported as success");
});

test("a single hidden obstacle is still beaten by one sidestep and one retry", async () => {
  const result = await runScenario("recovery-single-hidden-obstacle", 101);
  assert.equal(result.status, "succeeded", "the recovery path still works after the stall limit change");
});
