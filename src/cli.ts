import { resolve } from "node:path";
import { createLogger } from "./core/logger.js";
import { FanOutTraceSink, JsonlTraceSink, RingBufferTraceSink, TraceRecorder } from "./core/trace.js";
import { ExperienceLearner } from "./core/learning/learner.js";
import { createMinecraftAgent } from "./games/minecraft/create-agent.js";
import {
  attachMinecraftRunHost,
  controlCenterTaskKinds,
  taskFromControlCenterRequest,
  type ControlCenterTaskKind,
  type MinecraftRunHost,
} from "./games/minecraft/attach-control-center.js";
import {
  DEFAULT_MINECRAFT_CONFIG,
  MinecraftAdapter,
  minecraftAdapterConfigFromEnv,
} from "./games/minecraft/minecraft-adapter.js";
import { MinecraftTaskDecisionModel } from "./games/minecraft/decision-model.js";
import { secureFoodTaskSchema, type MinecraftTask } from "./games/minecraft/task.js";
import {
  MinecraftTaskRunner,
  type MinecraftTaskResult,
  type MinecraftTaskRunnerOptions,
} from "./games/minecraft/task-runner.js";
import { readEvaluationSummary } from "./games/minecraft/run-control.js";
import { policyPromotionRefusalReasons } from "./games/minecraft/policy-promotion.js";
import { PersistentWorldMemory } from "./games/minecraft/persistent-world-memory.js";
import type { WorldMemory } from "./games/minecraft/world-memory.js";
import { MINECRAFT_ATTACK_HOSTILE_CAPABILITY } from "./games/minecraft/capabilities.js";
import { createFakeMinecraftFixture, FakeMinecraftAdapter } from "./testing/fake-minecraft-adapter.js";
import { evaluationScenarios } from "./testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "./testing/simulated-minecraft/adapter.js";
import { loadScenario } from "./testing/scenario.js";
import { ScenarioRunner } from "./testing/scenario-runner.js";
import { classifyFailure } from "./core/failure-taxonomy.js";

type TaskChoice = ControlCenterTaskKind;

/**
 * The failure category the Control Center shows, attached to the CLI report too so stdout and the
 * dashboard can never disagree about whether a stop was a safety refusal, a missing capability, a
 * connection fault or a task that ran out of budget.
 */
function failureClassification(result: MinecraftTaskResult): Record<string, unknown> {
  if (result.status === "succeeded" && result.failure === null) return {};
  const classified = classifyFailure(result.failure?.code ?? null, result.failure?.message ?? null);
  return {
    classification: {
      status: result.status,
      kind: classified.kind,
      label: classified.label,
      code: classified.code,
      owner: classified.owner,
      retryable: classified.retryable,
      ...(classified.hint ? { hint: classified.hint } : {}),
    },
  };
}

/** One line for the process error: what stopped, in whose component, with the source's own words kept. */
function failureLine(result: MinecraftTaskResult, taskDescription: string): string {
  const classified = classifyFailure(result.failure?.code ?? null, result.failure?.message ?? null);
  const head = `${classified.label} · ${classified.code ?? "no code"} · ${classified.owner}`;
  return `Minecraft ${taskDescription} task ended with status '${result.status}' (${head}): ${result.failure?.message ?? "the task reported no reason"}`;
}

type PolicyChoice = "status" | "promote" | "reject";

const POLICY_CHOICES: readonly PolicyChoice[] = ["status", "promote", "reject"];

const TASK_CHOICES: readonly TaskChoice[] = controlCenterTaskKinds;

interface CliOptions {
  readonly demo: boolean;
  readonly demoTask: boolean;
  readonly demoTaskKind?: TaskChoice;
  readonly task?: TaskChoice;
  readonly resource?: string;
  readonly count?: number;
  readonly targetHunger?: number;
  readonly exploreLegs?: number;
  readonly exploreRadius?: number;
  readonly maxActions?: number;
  readonly maxDurationMs?: number;
  readonly sim?: string;
  readonly seed?: number;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly version?: string;
  readonly auth?: "offline" | "microsoft";
  readonly lookYaw?: number;
  readonly lookPitch: number;
  readonly traceDirectory: string;
  readonly help: boolean;
  /** Serve the live Control Center for this run. */
  readonly controlCenter: boolean;
  readonly controlPort?: number;
  readonly controlHost: string;
  /** Experience recording is on by default; --no-learning turns persistence off. */
  readonly learning: boolean;
  readonly learningDirectory: string;
  readonly memoryDirectory: string;
  readonly worldKey?: string;
  /** Operator opt-in for the combat capability, at the adapter and the safety policy together. */
  readonly allowCombat: boolean;
  readonly policy?: PolicyChoice;
}

function isTaskChoice(value: string): value is TaskChoice {
  return (TASK_CHOICES as readonly string[]).includes(value);
}

function parseArgs(args: readonly string[]): CliOptions {
  let demo = false;
  let demoTask = false;
  let demoTaskKind: TaskChoice | undefined;
  let task: TaskChoice | undefined;
  let resource: string | undefined;
  let count: number | undefined;
  let targetHunger: number | undefined;
  let exploreLegs: number | undefined;
  let exploreRadius: number | undefined;
  let maxActions: number | undefined;
  let maxDurationMs: number | undefined;
  let sim: string | undefined;
  let seed: number | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let username: string | undefined;
  let version: string | undefined;
  let auth: "offline" | "microsoft" | undefined;
  let lookYaw: number | undefined;
  let lookPitch = 0;
  let lookPitchProvided = false;
  let traceDirectory = process.env.GAMEMIND_TRACE_DIR ?? "data/traces";
  let controlCenter = false;
  let controlPort: number | undefined;
  let controlHost = process.env.GAMEMIND_CONTROL_HOST ?? "127.0.0.1";
  let learning = true;
  let learningDirectory = process.env.GAMEMIND_LEARNING_DIR ?? "data/learning";
  let memoryDirectory = process.env.GAMEMIND_MEMORY_DIR ?? "data/world-memory";
  let worldKey = process.env.GAMEMIND_WORLD_KEY?.trim() || undefined;
  let allowCombat = false;
  let policy: PolicyChoice | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    const value = (): string => {
      if (!next || next.startsWith("--")) throw new Error(`Option '${arg}' requires a value.`);
      index += 1;
      return next;
    };

    switch (arg) {
      case "--demo":
        demo = true;
        break;
      case "--demo-task": {
        demoTask = true;
        const taskValue = next && !next.startsWith("--") ? next : "gather-logs";
        if (!isTaskChoice(taskValue)) {
          throw new Error(`--demo-task supports ${controlCenterTaskKinds.join(", ")}.`);
        }
        if (next && !next.startsWith("--")) index += 1;
        demoTaskKind = taskValue;
        break;
      }
      case "--task": {
        const taskValue = value();
        if (!isTaskChoice(taskValue)) {
          throw new Error(`--task supports ${controlCenterTaskKinds.join(", ")}.`);
        }
        task = taskValue;
        break;
      }
      case "--resource":
        resource = value();
        break;
      case "--count":
        count = Number(value());
        if (!Number.isInteger(count) || count < 1 || count > 64) {
          throw new Error("--count must be an integer from 1 through 64.");
        }
        break;
      case "--target-hunger":
        targetHunger = Number(value());
        if (!Number.isInteger(targetHunger) || targetHunger < 1 || targetHunger > 20) {
          throw new Error("--target-hunger must be an integer from 1 through 20.");
        }
        break;
      case "--explore-legs":
        exploreLegs = Number(value());
        if (!Number.isInteger(exploreLegs) || exploreLegs < 0 || exploreLegs > 30) {
          throw new Error("--explore-legs must be an integer from 0 through 30.");
        }
        break;
      case "--explore-radius":
        exploreRadius = Number(value());
        if (!Number.isFinite(exploreRadius) || exploreRadius < 8 || exploreRadius > 96) {
          throw new Error("--explore-radius must be a number from 8 through 96.");
        }
        break;
      case "--max-actions":
        maxActions = Number(value());
        if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) {
          throw new Error("--max-actions must be an integer from 1 through 100.");
        }
        break;
      case "--max-duration-ms":
        maxDurationMs = Number(value());
        if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1_000 || maxDurationMs > 600_000) {
          throw new Error("--max-duration-ms must be an integer from 1000 through 600000.");
        }
        break;
      case "--sim":
        sim = value();
        break;
      case "--seed":
        seed = Number(value());
        if (!Number.isInteger(seed)) throw new Error("--seed must be an integer.");
        break;
      case "--minecraft":
        break;
      case "--host":
        host = value();
        break;
      case "--port":
        port = Number(value());
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new Error("--port must be an integer from 1 through 65535.");
        }
        break;
      case "--username":
        username = value();
        break;
      case "--version":
        version = value();
        break;
      case "--auth": {
        const authValue = value();
        if (authValue !== "offline" && authValue !== "microsoft") {
          throw new Error("--auth must be either 'offline' or 'microsoft'.");
        }
        auth = authValue;
        break;
      }
      case "--look-yaw":
        lookYaw = Number(value());
        if (!Number.isFinite(lookYaw)) throw new Error("--look-yaw must be finite.");
        break;
      case "--look-pitch":
        lookPitchProvided = true;
        lookPitch = Number(value());
        if (!Number.isFinite(lookPitch)) throw new Error("--look-pitch must be finite.");
        break;
      case "--trace-dir":
        traceDirectory = value();
        break;
      case "--control-center":
        controlCenter = true;
        break;
      case "--control-port":
        controlPort = Number(value());
        if (!Number.isInteger(controlPort) || controlPort < 0 || controlPort > 65_535) {
          throw new Error("--control-port must be an integer from 0 through 65535 (0 picks a free port).");
        }
        controlCenter = true;
        break;
      case "--control-host":
        controlHost = value();
        break;
      case "--learn":
        learning = true;
        break;
      case "--no-learning":
        learning = false;
        break;
      case "--learning-dir":
        learningDirectory = value();
        break;
      case "--memory-dir":
        memoryDirectory = value();
        break;
      case "--world-key": {
        const key = value().trim();
        if (!key) throw new Error("--world-key must not be empty.");
        worldKey = key;
        break;
      }
      case "--allow-combat":
        allowCombat = true;
        break;
      case "--policy": {
        const policyValue = value();
        if (!(POLICY_CHOICES as readonly string[]).includes(policyValue)) {
          throw new Error("--policy supports 'status', 'promote' or 'reject'.");
        }
        policy = policyValue as PolicyChoice;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown option '${arg}'. Use --help to see available options.`);
    }
  }

  if (demo && (demoTask || task || sim !== undefined)) {
    throw new Error("--demo cannot be combined with --demo-task, --task, or --sim.");
  }
  if (demoTask && task) throw new Error("Choose either --demo-task or --task, not both.");
  if (sim !== undefined && (demoTask || task || lookYaw !== undefined || lookPitchProvided)) {
    throw new Error("--sim runs a complete offline scenario and cannot be combined with other task or look options.");
  }
  if (seed !== undefined && sim === undefined) throw new Error("--seed requires --sim.");
  if (task && (lookYaw !== undefined || lookPitchProvided)) {
    throw new Error("--task cannot be combined with --look-yaw or --look-pitch.");
  }
  if (lookPitchProvided && lookYaw === undefined) {
    throw new Error("--look-pitch requires --look-yaw.");
  }
  if (policy !== undefined && (demo || demoTask || task || sim !== undefined)) {
    throw new Error("--policy inspects or changes the learned policy on its own; do not combine it with a run.");
  }
  if (controlPort !== undefined && !controlCenter) {
    throw new Error("--control-port is only meaningful together with --control-center.");
  }
  if (allowCombat && policy !== undefined) {
    throw new Error("--allow-combat applies to a run, not to --policy.");
  }
  if ((demo || demoTask) && (lookYaw !== undefined || lookPitchProvided)) {
    throw new Error("Orientation flags cannot be combined with an offline demo.");
  }
  const selectedTask = task ?? demoTaskKind;
  if (resource !== undefined && !demoTask && task === undefined) {
    throw new Error("--resource requires --demo-task or --task.");
  }
  if (resource !== undefined && selectedTask === "secure-food") {
    throw new Error("--resource is not used by the secure-food task; use --target-hunger.");
  }
  if (count !== undefined && selectedTask === "secure-food") {
    throw new Error("--count is not used by the secure-food task; use --target-hunger.");
  }
  if (targetHunger !== undefined && selectedTask !== "secure-food") {
    throw new Error("--target-hunger is supported only by the secure-food task.");
  }
  if ((resource !== undefined || count !== undefined || targetHunger !== undefined || exploreLegs !== undefined || exploreRadius !== undefined || maxActions !== undefined || maxDurationMs !== undefined) && !demoTask && !task) {
    throw new Error("Task options (--resource, --count, --target-hunger, --explore-*, --max-*) require --demo-task or --task.");
  }

  return {
    demo,
    demoTask,
    ...(demoTaskKind !== undefined ? { demoTaskKind } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(targetHunger !== undefined ? { targetHunger } : {}),
    ...(exploreLegs !== undefined ? { exploreLegs } : {}),
    ...(exploreRadius !== undefined ? { exploreRadius } : {}),
    ...(maxActions !== undefined ? { maxActions } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(sim !== undefined ? { sim } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(lookYaw !== undefined ? { lookYaw } : {}),
    lookPitch,
    traceDirectory,
    help,
    controlCenter,
    ...(controlPort !== undefined ? { controlPort } : {}),
    controlHost,
    learning,
    learningDirectory,
    memoryDirectory,
    ...(worldKey !== undefined ? { worldKey } : {}),
    allowCombat,
    ...(policy !== undefined ? { policy } : {}),
  };
}

function printHelp(): void {
  console.log(`GameMind — bounded Minecraft agent loop

Usage:
  npm run dev -- --demo
  npm run dev -- --demo-task [gather-logs|craft-wooden-pickaxe|secure-food]
  npm run dev -- --sim food-remote-berries --seed 101
  npm run dev -- --task craft-wooden-pickaxe --host 127.0.0.1
  npm run dev -- --task mine-stone --resource iron_ore --count 4 --host 127.0.0.1 --control-center
  npm run dev -- --task secure-food --target-hunger 18 --host 127.0.0.1

Offline:
  --demo               Run the seeded look scenario against the offline fake adapter
  --demo-task [TASK]   Run gather-logs (default) or craft-wooden-pickaxe on the offline fixture, or
                       secure-food in the simulated world. Mining offline: npm run task:demo:mine
  --sim SCENARIO       Run one offline simulated scenario (see src/testing/eval/scenarios.ts; e.g. explore-remote-log)
  --seed N             Seed for --sim scenarios (default 101)

Live Java server (requires an authorized private/local server):
  --task TASK          Run gather-logs, mine-stone, craft-wooden-pickaxe or secure-food on a Java server
  --resource NAME      Target block or item for the task (oak_log, stone, iron_ore, wooden_pickaxe, ...)
  --count N            Inventory target for gather/craft, from 1 through 64 (default: 1)
  --target-hunger N    Hunger target for secure-food, from 1 through 20 (default: 18)
  --explore-legs N     Exploration legs allowed per task, 0 through 30 (default: 8; 0 disables exploration)
  --explore-radius R   Exploration radius around the start, 8 through 96 blocks (default: 48)
  --max-actions N      Action budget per task, 1 through 100 (default: 12)
  --max-duration-ms N  Task time budget in milliseconds (default: 120000)
  --minecraft          Explicitly select the live Minecraft adapter (the default)
  --host HOST          Minecraft Java server host (default: MINECRAFT_HOST or 127.0.0.1)
  --port PORT          Server port (default: MINECRAFT_PORT or 25565)
  --username NAME      Offline name / Microsoft account profile name
  --version VERSION    Minecraft version (default: MINECRAFT_VERSION or 1.20.4)
  --auth MODE          offline or microsoft (default: offline)
  --look-yaw RADIANS   After observing, orient to this yaw; pitch defaults to 0
  --look-pitch RADIANS Look pitch in radians (range -pi/2 through pi/2)
  --trace-dir PATH     JSONL trace directory (default: data/traces)

Control Center (real state, real controls; serve it from a run):
  --control-center     Serve the dashboard for this run and keep the process open until Ctrl-C
  --control-port PORT  Port for the dashboard (default 8787, 0 picks a free one)
  --control-host HOST  Interface to bind (default 127.0.0.1; use 0.0.0.0 only on a trusted network)

Learning and policy:
  --learn              Record episodes and reuse them (on by default)
  --no-learning        Turn the experience store off for this run
  --learning-dir PATH  Experience store directory (default: data/learning)
  --memory-dir PATH    World knowledge directory (default: data/world-memory or GAMEMIND_MEMORY_DIR)
  --world-key KEY      Stable base identity for this world (default: server host + port)
  --policy STATUS|PROMOTE|REJECT
                       Inspect, promote or roll back the learned policy; promotion also requires a
                       passing 'npm run eval:offline' report
  --allow-combat       Arm the combat capability for this run (adapter and safety policy together)
  --help               Show this help

Task runs have fixed limits for action count, time, target distance, exploration, rest, and consecutive failures. Nearby visible hostile mobs take priority; collection, pickup, berry harvesting, and placement are refused when a visible hostile is within the task's danger radius of the target.
Connection credentials are never accepted through command-line flags or written to traces.`);
}

async function runDemo(trace: TraceRecorder, logger: ReturnType<typeof createLogger>): Promise<void> {
  const scenarioPath = resolve("scenarios/minecraft-look-roundtrip.json");
  const scenario = await loadScenario(scenarioPath);
  const adapter = new FakeMinecraftAdapter({ seed: scenario.seed });
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  const report = await new ScenarioRunner(runtime, skills).run(scenario);
  console.log(JSON.stringify({ type: "scenario-report", ...report }, null, 2));
}

/** Only the limits the user explicitly set; defaults stay in the task schemas. */
function taskLimitOverrides(options: CliOptions): Record<string, number> {
  const overrides: Record<string, number> = {};
  if (options.exploreLegs !== undefined) overrides.maxExplorationLegs = options.exploreLegs;
  if (options.exploreRadius !== undefined) overrides.explorationRadius = options.exploreRadius;
  if (options.maxActions !== undefined) overrides.maxActions = options.maxActions;
  if (options.maxDurationMs !== undefined) overrides.maxDurationMs = options.maxDurationMs;
  return overrides;
}

/**
 * One task builder for both entry points: the CLI flags and the Control Center requests are parsed by the
 * same schemas, so a dashboard-started task carries exactly the same limits as a command-line one.
 */
function configuredTask(options: CliOptions, offline = false): MinecraftTask {
  const taskKind = options.task ?? options.demoTaskKind ?? "gather-logs";
  const task = taskFromControlCenterRequest({
    kind: taskKind,
    ...(options.resource !== undefined ? { resource: options.resource } : {}),
    ...(options.count !== undefined ? { count: options.count } : {}),
    ...(options.targetHunger !== undefined && taskKind === "secure-food" ? { count: options.targetHunger } : {}),
  });
  const overrides = taskLimitOverrides(options);
  const id = offline ? `offline-${taskKind}-demo` : task.id.replace(/^ui-/, "");
  return Object.keys(overrides).length === 0 && !offline
    ? task
    : ({ ...task, id, ...overrides } as MinecraftTask);
}

interface RunHostParts {
  readonly options: CliOptions;
  readonly trace: TraceRecorder;
  readonly ring: RingBufferTraceSink;
  readonly logger: ReturnType<typeof createLogger>;
  readonly runtime: ReturnType<typeof createMinecraftAgent>["runtime"];
  readonly skills: ReturnType<typeof createMinecraftAgent>["skills"];
  readonly safety: ReturnType<typeof createMinecraftAgent>["safety"];
  readonly decisionModel: MinecraftTaskDecisionModel;
  readonly learner: ExperienceLearner | null;
  readonly worldKey: string | null;
  readonly memory?: WorldMemory;
  readonly offlineNote: string | null;
  readonly extraRunnerOptions: MinecraftTaskRunnerOptions;
  readonly report: (result: MinecraftTaskResult, source: "cli" | "control-center") => void;
}

/**
 * Builds the runner and, when asked, the Control Center that watches it. The CLI and the dashboard start
 * tasks through the same host, so a UI-started run is connected, traced, budgeted and verified identically.
 */
async function openRunHost(
  parts: RunHostParts,
): Promise<{ host: MinecraftRunHost | null; run(task: MinecraftTask): Promise<MinecraftTaskResult> }> {
  const makeRunner = (extra: MinecraftTaskRunnerOptions) =>
    new MinecraftTaskRunner(parts.runtime, parts.skills, parts.decisionModel, parts.logger, {
      ...(parts.learner ? { learner: parts.learner } : {}),
      worldKey: parts.worldKey,
      ...(parts.memory ? { memory: parts.memory } : {}),
      allowCombat: parts.options.allowCombat,
      ...parts.extraRunnerOptions,
      ...extra,
    });
  if (!parts.options.controlCenter) {
    return { host: null, run: (task) => makeRunner({}).run(task) };
  }
  const host = await attachMinecraftRunHost({
    runtime: parts.runtime,
    skills: parts.skills,
    companionMemoryDirectory: resolve(parts.options.memoryDirectory),
    minecraftCommander: process.env.MINECRAFT_COMMANDER ?? null,
    safety: parts.safety,
    traceSink: parts.ring,
    logger: parts.logger,
    ...(parts.learner ? { learner: parts.learner } : {}),
    worldKey: parts.worldKey,
    ...(parts.memory ? { memory: parts.memory } : {}),
    offlineNote: parts.offlineNote,
    evaluationScenarioIds: evaluationScenarios().map((scenario) => scenario.id),
    title: parts.offlineNote ? "GameMind (offline world)" : "GameMind",
    ...(parts.options.controlPort !== undefined ? { port: parts.options.controlPort } : {}),
    bindHost: parts.options.controlHost,
    createRunner: makeRunner,
    onTaskFinished: (result, source) => {
      if (source === "control-center") parts.report(result, source);
    },
  });
  return { host, run: (task) => host.runTask(task) };
}

function createLearner(options: CliOptions, logger: ReturnType<typeof createLogger>): ExperienceLearner | null {
  if (!options.learning) return null;
  return ExperienceLearner.forDirectory(resolve(options.learningDirectory), { logger });
}

/**
 * Operator-facing policy commands. Promotion is deliberately gated: the candidate weights come from
 * observed failures, but a policy that has not passed the offline evaluation must not go live silently.
 */
async function runPolicyCommand(options: CliOptions, logger: ReturnType<typeof createLogger>): Promise<void> {
  const learner = ExperienceLearner.forDirectory(resolve(options.learningDirectory), { logger });
  await learner.load();
  // Read from the learner every time, so a report printed after a change describes the state after it.
  const describe = () => {
    const snapshot = learner.snapshot();
    return {
      type: "policy-status",
      learningDirectory: resolve(options.learningDirectory),
      enabled: snapshot.enabled,
      runs: snapshot.runs,
      episodes: snapshot.episodes,
      contradictedConfirmations: snapshot.contradictedConfirmations,
      safetyDenials: snapshot.safetyDenials,
      activePolicy: snapshot.activePolicy,
      candidatePolicy: snapshot.candidatePolicy,
      candidateWeights: learner.candidateWeights,
      weightedContexts: snapshot.contexts.length,
      blockedTargets: snapshot.failureMemory.filter((entry) => entry.blocked).length,
      history: snapshot.history.slice(-8),
    };
  };
  if (options.policy === "status") {
    console.log(JSON.stringify(describe(), null, 2));
    return;
  }
  if (options.policy === "reject") {
    await learner.rollback("candidate policy rejected from the CLI");
    console.log(
      JSON.stringify(
        { ...describe(), type: "policy-reject", ok: true, message: "Rolled back: no promoted policy is in force, so the hand-tuned weights rank decisions again." },
        null,
        2,
      ),
    );
    return;
  }
  const report = await readEvaluationSummary(resolve("data/eval/offline-report.json"));
  const snapshot = learner.snapshot();
  const problems = policyPromotionRefusalReasons(
    {
      episodes: snapshot.episodes,
      candidateContexts: snapshot.candidatePolicy.contexts,
      contradictedConfirmations: snapshot.contradictedConfirmations,
      candidateWeightsId: learner.candidateWeights.id,
    },
    report,
    evaluationScenarios().map((scenario) => scenario.id),
  );
  if (problems.length > 0) {
    throw new Error(`Refusing to promote the learned policy: ${problems.join("; ")}.`);
  }
  const promotedId = learner.candidateWeights.id;
  await learner.promote(learner.candidateWeights, `promoted from the CLI; evaluation report ${report.generatedAt}`);
  console.log(
    JSON.stringify(
      {
        ...describe(),
        type: "policy-promote",
        ok: true,
        message: `Promoted ${promotedId}. The next run uses these weights; the state file lives in the learning directory.`,
        evaluation: report,
      },
      null,
      2,
    ),
  );
}

async function runDemoTask(
  options: CliOptions,
  trace: TraceRecorder,
  ring: RingBufferTraceSink,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const taskKind = options.demoTaskKind ?? "gather-logs";
  if (taskKind === "mine-stone") {
    // The offline fixture has no stone to dig, so mining is demonstrated in the simulated world instead.
    throw new Error(
      "--demo-task does not support mine-stone: the offline fixture has no diggable stone. Use 'npm run task:demo:mine' (simulated world) or --task mine-stone against a server.",
    );
  }
  if (taskKind === "build-shelter") {
    // The shelter needs mutable block state, which the tiny fake fixture does not model.
    await runSimulatedScenario(
      "shelter-close-cardinal-sides",
      options.seed ?? 101,
      trace,
      ring,
      logger,
      options,
      true,
    );
    return;
  }
  if (taskKind === "secure-food") {
    // Berries and drops only exist in the simulated world, so the food demo runs there.
    await runSimulatedScenario(
      "food-remote-berries",
      options.seed ?? 101,
      trace,
      ring,
      logger,
      { ...options, targetHunger: options.targetHunger ?? 8 },
      true,
    );
    return;
  }
  const fixture = createFakeMinecraftFixture(1337);
  const adapter = new FakeMinecraftAdapter({
    seed: 1337,
    ...(taskKind === "craft-wooden-pickaxe"
      ? {
          initialObservation: {
            ...fixture,
            inventory: [{
              slot: 9,
              name: "oak_log",
              type: 17,
              count: 2,
              metadata: null,
              durabilityUsed: null,
            }],
          },
        }
      : {}),
  });
  const { runtime, skills, safety } = createMinecraftAgent(adapter, trace, logger);
  const decisionModel = new MinecraftTaskDecisionModel();
  const learner = createLearner(options, logger);
  const task = configuredTask(options, true);
  const signal = new AbortController();
  const onSignal = (name: NodeJS.Signals): void => {
    logger.warn({ signal: name }, "Shutdown signal received; ending the offline demo");
    signal.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { host, run } = await openRunHost({
      options,
      trace,
      ring,
      logger,
      runtime,
      skills,
      safety,
      decisionModel,
      learner,
      worldKey: "offline-fixture-1337",
      offlineNote: "Offline demo: the world is a fixture, not a Minecraft server.",
      extraRunnerOptions: {},
      report: (result) =>
        console.log(JSON.stringify({ type: "task-report", offlineFixture: true, ...result, ...failureClassification(result) }, null, 2)),
    });
    const result = await run(task);
    console.log(JSON.stringify({ type: "task-report", offlineFixture: true, ...result, ...failureClassification(result) }, null, 2));
    if (host) {
      console.log(`Control Center for this offline run: ${host.handle?.url} (left open until Ctrl-C)`);
      await host.waitUntil(signal.signal);
      await host.close();
    }
    if (result.status !== "succeeded") {
      throw new Error(`Offline ${taskKind} task ended with status '${result.status}'.`);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await runtime.shutdown("offline task demo complete");
  }
}

/**
 * Runs one offline simulated scenario from the evaluation suite. The world is not a Minecraft
 * server: this demonstrates control behaviour, and the report says so.
 */
async function runSimulatedScenario(
  scenarioId: string,
  seed: number,
  trace: TraceRecorder,
  ring: RingBufferTraceSink,
  logger: ReturnType<typeof createLogger>,
  options: CliOptions,
  demo: boolean,
): Promise<void> {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === scenarioId);
  if (!scenario) {
    const ids = evaluationScenarios().map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown simulated scenario '${scenarioId}'. Available: ${ids}.`);
  }
  const baseTask = scenario.task();
  const task =
    baseTask.kind === "secure_food" && options.targetHunger !== undefined
      ? secureFoodTaskSchema.parse({ ...baseTask, targetHunger: options.targetHunger })
      : baseTask;
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(seed), allowCombat: options.allowCombat });
  const { runtime, skills, safety } = createMinecraftAgent(adapter, trace, logger);
  const decisionModel = new MinecraftTaskDecisionModel();
  const learner = createLearner(options, logger);
  const signal = new AbortController();
  const onSignal = (name: NodeJS.Signals): void => {
    logger.warn({ signal: name }, "Shutdown signal received; ending the simulated run");
    signal.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const report = (result: MinecraftTaskResult, source: "cli" | "control-center"): void => {
    console.log(
      JSON.stringify(
        {
          type: "sim-task-report",
          simulatedWorld: true,
          startedBy: source,
          scenarioId,
          seed,
          description: scenario.description,
          expectation: scenario.expectation,
          ...(demo ? { offlineDemo: true } : {}),
          simulatedElapsedMs: adapter.simulatedNowMs,
          worldStats: {
            damageTaken: adapter.world.stats.damageTaken,
            minHealth: adapter.world.stats.minHealth,
            starvationTicks: adapter.world.stats.starvationTicks,
          },
          ...result,
          ...failureClassification(result),
        },
        null,
        2,
      ),
    );
    // The scenario's own expectation gates the run the CLI started. A task an operator starts from the
    // dashboard afterwards is not part of the scenario, so it reports without turning the demo red.
    if (source === "cli" && result.status !== "succeeded" && scenario.expectation === "success") {
      throw new Error(`Simulated scenario '${scenarioId}' ended with status '${result.status}'.`);
    }
  };
  try {
    const { host, run } = await openRunHost({
      options,
      trace,
      ring,
      logger,
      runtime,
      skills,
      safety,
      decisionModel,
      learner,
      worldKey: `${scenarioId}#${seed}`,
      offlineNote: "Simulated world: this is the offline evaluation adapter, not a Minecraft server.",
      extraRunnerOptions: { clock: () => adapter.simulatedNowMs },
      report,
    });
    const result = await run(task);
    report(result, "cli");
    if (host) {
      console.log(`Control Center for this simulated run: ${host.handle?.url} (left open until Ctrl-C)`);
      await host.waitUntil(signal.signal);
      await host.close();
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await runtime.shutdown(`simulated scenario ${scenarioId} complete`);
  }
}

async function runMinecraft(
  options: CliOptions,
  trace: TraceRecorder,
  ring: RingBufferTraceSink,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const task = options.task ? configuredTask(options) : null;
  const configFromEnv = minecraftAdapterConfigFromEnv();
  const config = {
    ...DEFAULT_MINECRAFT_CONFIG,
    ...configFromEnv,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.username !== undefined ? { username: options.username } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.auth !== undefined ? { auth: options.auth } : {}),
    ...(options.allowCombat ? { allowCombat: true } : {}),
  };
  const adapter = new MinecraftAdapter(logger, config);
  const { runtime, skills, safety } = createMinecraftAgent(adapter, trace, logger, {
    // Combat is opt-in at three layers; this is the operator's explicit second and third "yes".
    ...(options.allowCombat ? { optedInCapabilities: [MINECRAFT_ATTACK_HOSTILE_CAPABILITY] } : {}),
  });
  const decisionModel = new MinecraftTaskDecisionModel();
  const learner = createLearner(options, logger);

  const signal = new AbortController();
  const onSignal = (name: NodeJS.Signals): void => {
    logger.warn({ signal: name }, "Shutdown signal received; closing Minecraft session safely");
    signal.abort();
    void runtime.shutdown(name).catch((error: unknown) => {
      logger.error({ err: error }, "Safe shutdown after signal failed");
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let persistentMemory: PersistentWorldMemory | null = null;

  try {
    const session = await runtime.connect();
    const dimension = runtime.currentWorldState?.state.player.dimension ?? "unknown";
    const worldKey = options.worldKey
      ? `minecraft-java:${options.worldKey}:${dimension}`
      : `minecraft-java:${config.host.toLowerCase()}:${config.port}:${dimension}`;
    persistentMemory = await PersistentWorldMemory.open(resolve(options.memoryDirectory), worldKey, { logger });
    const initialWorld = runtime.currentWorldState;
    if (initialWorld) persistentMemory.observe(initialWorld.state, initialWorld.sequence);
    logger.info(
      {
        sessionId: session.id,
        worldKey,
        memoryFile: persistentMemory.filePath,
        gameVersion: session.gameVersion,
        host: config.host,
        port: config.port,
        capabilities: adapter.capabilities.map(({ name }) => name),
      },
      "Minecraft observation loop connected",
    );

    let host: MinecraftRunHost | null = null;
    if (options.controlCenter) {
      host = (
        await openRunHost({
          options,
          trace,
          ring,
          logger,
          runtime,
          skills,
          safety,
          decisionModel,
          learner,
          worldKey,
          memory: persistentMemory,
          offlineNote: null,
          extraRunnerOptions: {},
          report: (result, source) =>
            console.log(JSON.stringify({ type: "task-report", startedBy: source, ...result, ...failureClassification(result) }, null, 2)),
        })
      ).host;
    }
    if (task) {
      const result = host
        ? await host.runTask(task)
        : await new MinecraftTaskRunner(runtime, skills, decisionModel, logger, {
            ...(learner ? { learner } : {}),
            worldKey,
            memory: persistentMemory,
            allowCombat: options.allowCombat,
          }).run(task);
      console.log(JSON.stringify({ type: "task-report", startedBy: "cli", ...result, ...failureClassification(result) }, null, 2));
      if (host) {
        // The operator keeps the dashboard open after the task so the trace and the learning result stay
        // readable; a second task can be started from the UI against the same live session.
        console.log(`Control Center for this live run: ${host.handle?.url} (left open until Ctrl-C)`);
        await host.waitUntil(signal.signal);
        await host.close();
      }
      if (result.status !== "succeeded") {
        throw new Error(failureLine(result, String(options.task)));
      }
    } else if (options.lookYaw !== undefined) {
      const result = await skills.run("minecraft.orient", {
        yaw: options.lookYaw,
        pitch: options.lookPitch,
      });
      console.log(JSON.stringify({ type: "skill-result", ...result }, null, 2));
      if (result.action.status !== "succeeded") {
        throw new Error(
          `Minecraft look action ended with status '${result.action.status}': ${result.action.failure?.message ?? "unconfirmed"}`,
        );
      }
    } else {
      console.log(
        JSON.stringify(
          {
            type: "initial-observation",
            sessionId: session.id,
            observation: runtime.currentWorldState,
            availableSkills: skills.list().map(({ id, description }) => ({ id, description })),
          },
          null,
          2,
        ),
      );
      if (host) {
        // Observation-only mode with a dashboard: the agent acts only when an operator starts a task.
        console.log(`Control Center for this session: ${host.handle?.url} (left open until Ctrl-C)`);
        await host.waitUntil(signal.signal);
        await host.close();
      }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (persistentMemory) {
      try {
        await persistentMemory.flush();
      } catch (error) {
        logger.warn({ err: error }, "Persistent world memory did not flush cleanly at shutdown");
      }
    }
    await runtime.shutdown("CLI run complete");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const logger = createLogger();
  if (options.policy) {
    await runPolicyCommand(options, logger);
    return;
  }
  // The ring keeps recent events for the Control Center; the fan-out guarantees a dead UI client can
  // never break the durable JSONL log or the action path that awaits the write.
  const ring = new RingBufferTraceSink(400);
  const trace = new TraceRecorder(new FanOutTraceSink([new JsonlTraceSink(options.traceDirectory), ring], logger), logger);
  if (options.demo) {
    await runDemo(trace, logger);
    return;
  }
  if (options.sim !== undefined) {
    await runSimulatedScenario(options.sim, options.seed ?? 101, trace, ring, logger, options, false);
    return;
  }
  if (options.demoTask) {
    await runDemoTask(options, trace, ring, logger);
    return;
  }
  await runMinecraft(options, trace, ring, logger);
}

main().catch((error: unknown) => {
  const logger = createLogger();
  logger.error({ err: error }, "GameMind exited with an error");
  process.exitCode = 1;
});
