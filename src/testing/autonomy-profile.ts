/**
 * Profiles the autonomous task cycle in the simulated world: generate the next autonomous task, run it to
 * completion, and generate the next one. It reproduces the production cycle without the Control Center so
 * the "what does the agent do after it finishes a task" question has a measured answer.
 *
 *   npm run profile:autonomy -- --scenario berries --seed 101 --virtual-seconds 300
 *
 * Output is simulated behaviour (virtual clock, simplified physics), not live Minecraft evidence.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pino from "pino";
import { MemoryTraceSink, TraceRecorder } from "../core/trace.js";
import { createMinecraftAgent } from "../games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../games/minecraft/decision-model.js";
import { MinecraftTaskRunner, type MinecraftTaskResult } from "../games/minecraft/task-runner.js";
import { AutonomyController } from "../games/minecraft/autonomy-controller.js";
import { ProgressTracker } from "../games/minecraft/progress-tracker.js";
import { SimulatedMinecraftAdapter } from "./simulated-minecraft/adapter.js";
import { simulatedWorld, berryBushAt, treeAt } from "./simulated-minecraft/scenarios.js";
import { evaluationScenarios } from "./eval/scenarios.js";
import { WorldMemory } from "../games/minecraft/world-memory.js";
import type { SimWorldDefinition } from "./simulated-minecraft/world.js";

export interface AutonomyProfileTaskRecord {
  readonly taskId: string;
  readonly status: MinecraftTaskResult["status"];
  readonly failureCode: string | null;
  readonly actions: number;
  readonly simulatedMs: number;
  readonly foodAfter: number | null;
}

export interface AutonomyProfileReport {
  /** When the profile finished (ISO). The improvement roadmap uses it as the evidence timestamp. */
  readonly generatedAt?: string;
  readonly scenario: string;
  readonly seed: number;
  readonly virtualSeconds: number;
  readonly tasks: readonly AutonomyProfileTaskRecord[];
  readonly totalActions: number;
  /** Every failed action in the run, counted by failure code (not only each task's final failure). */
  readonly actionFailureCodes?: Readonly<Record<string, number>>;
  /** Each failed action with its skill and target key, in order; shows which targets were refused or too far. */
  readonly failedActions?: readonly { readonly code: string; readonly skillId: string; readonly targetKey: string | null }[];
  readonly zeroActionTasks: number;
  readonly idleVirtualSeconds: number;
  readonly finalFood: number | null;
  readonly distinctTaskIds: number;
  /** Times the controller chose a fallback because the preferred subgoal was cooling down. */
  readonly fallbacksUsed: number;
  /** Subgoal decisions made, including the ones that waited for a cooldown to expire. */
  readonly decisions: number;
}

export function profileWorld(scenario: string, seed: number): SimWorldDefinition {
  if (scenario === "berries") {
    // A ripe bush just outside the scan; hunger is low, which is the situation the user reported.
    const bush = { x: 9, z: 7 };
    return simulatedWorld({
      seed,
      placements: [berryBushAt(bush.x, bush.z, 3), ...treeAt(-14, 10, 4)],
      player: { food: 6 },
    });
  }
  if (scenario === "berries-fed") {
    // Same bush, but the player is not hungry: the agent should move on to progression, not stop.
    const bush = { x: 9, z: 7 };
    return simulatedWorld({
      seed,
      placements: [berryBushAt(bush.x, bush.z, 3), ...treeAt(-14, 10, 4)],
      player: { food: 20 },
    });
  }
  // Any offline evaluation scenario can be profiled through the production autonomous cycle, e.g. explore-remote-log.
  const evaluated = evaluationScenarios().find((candidate) => candidate.id === scenario);
  if (evaluated) return evaluated.world(seed);
  throw new Error(`Unknown profile scenario '${scenario}'. Use berries, berries-fed or an evaluation scenario id.`);
}

/** Runs the production autonomous cycle for a fixed virtual duration and reports what the agent did. */
export async function profileAutonomy(options: {
  readonly scenario: string;
  readonly seed: number;
  readonly virtualSeconds: number;
  /** Gap between a finished task and the next autonomous decision (5000 in the original host). */
  readonly idleGapMs?: number;
  readonly maxTasks?: number;
}): Promise<AutonomyProfileReport> {
  const logger = pino({ level: "silent" });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const adapter = new SimulatedMinecraftAdapter({ definition: profileWorld(options.scenario, options.seed) });
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  // One world memory for the whole profile, as the production host shares it across subgoals.
  const memory = new WorldMemory();
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
    memory,
  });
  const tracker = new ProgressTracker();
  // The autonomy controller runs on the virtual clock, so cooldowns are measured in simulated seconds.
  const autonomy = new AutonomyController({ tracker, now: () => adapter.simulatedNowMs });
  const idleGapMs = options.idleGapMs ?? 5_000;
  const limitMs = options.virtualSeconds * 1_000;
  const maxTasks = options.maxTasks ?? 200;
  const tasks: AutonomyProfileTaskRecord[] = [];
  const actionFailureCodes: Record<string, number> = {};
  const failedActions: { code: string; skillId: string; targetKey: string | null }[] = [];
  let idleVirtualMs = 0;
  try {
    await runtime.connect();
    while (adapter.simulatedNowMs < limitMs && tasks.length < maxTasks) {
      const world = await runtime.observe();
      const decision = autonomy.next(world.state);
      if (!decision.task) {
        if (decision.retryAt === null) {
          idleVirtualMs += idleGapMs;
          break;
        }
        // Every candidate is cooling down: the host waits, so the virtual clock waits until the first retry.
        const wait = Math.max(idleGapMs, decision.retryAt - adapter.simulatedNowMs);
        idleVirtualMs += wait;
        adapter.world.advance(wait);
        continue;
      }
      const task = decision.task;
      const startedAt = adapter.simulatedNowMs;
      const result = await runner.run(task);
      autonomy.record(task, result);
      for (const action of result.actions) {
        if (action.failureCode) {
          actionFailureCodes[action.failureCode] = (actionFailureCodes[action.failureCode] ?? 0) + 1;
          failedActions.push({ code: action.failureCode, skillId: action.skillId, targetKey: action.targetKey });
        }
      }
      tasks.push({
        taskId: task.id,
        status: result.status,
        failureCode: result.failure?.code ?? null,
        actions: result.actions.length,
        simulatedMs: adapter.simulatedNowMs - startedAt,
        foodAfter: result.finalObservation?.state.player.food ?? null,
      });
      // The production host waits for its next timer tick before deciding again. The virtual clock is
      // advanced by the same amount so an unproductive cycle is charged to idle time.
      if (result.actions.length === 0 || result.status !== "succeeded") {
        idleVirtualMs += idleGapMs;
        adapter.world.advance(idleGapMs);
      }
    }
  } finally {
    await runtime.shutdown(`autonomy profile ${options.scenario} finished`);
  }
  const finalFood = adapter.world.food;
  return {
    generatedAt: new Date().toISOString(),
    scenario: options.scenario,
    seed: options.seed,
    virtualSeconds: Math.round(adapter.simulatedNowMs / 100) / 10,
    tasks,
    totalActions: tasks.reduce((sum, task) => sum + task.actions, 0),
    actionFailureCodes,
    failedActions,
    zeroActionTasks: tasks.filter((task) => task.actions === 0).length,
    idleVirtualSeconds: idleVirtualMs / 1_000,
    finalFood,
    distinctTaskIds: new Set(tasks.map((task) => task.taskId.replace(/:\d+$/, ""))).size,
    fallbacksUsed: autonomy.snapshot().fallbacksUsed,
    decisions: autonomy.snapshot().decided,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const read = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
  };
  const report = await profileAutonomy({
    scenario: read("--scenario", "berries"),
    seed: Number(read("--seed", "101")),
    virtualSeconds: Number(read("--virtual-seconds", "300")),
  });
  // Written next to the other evidence so the Control Center's improvement roadmap can read it.
  const out = read("--out", `data/profile/autonomy-${report.scenario}-${report.seed}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report written to ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
