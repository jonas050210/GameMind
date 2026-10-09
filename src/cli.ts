import { resolve } from "node:path";
import { createLogger } from "./core/logger.js";
import { JsonlTraceSink, TraceRecorder } from "./core/trace.js";
import { createMinecraftAgent } from "./games/minecraft/create-agent.js";
import {
  DEFAULT_MINECRAFT_CONFIG,
  MinecraftAdapter,
  minecraftAdapterConfigFromEnv,
} from "./games/minecraft/minecraft-adapter.js";
import { MinecraftTaskDecisionModel } from "./games/minecraft/decision-model.js";
import {
  DEFAULT_CRAFT_PICKAXE_TASK,
  DEFAULT_GATHER_LOG_TASK,
  DEFAULT_SECURE_FOOD_TASK,
  craftItemTaskSchema,
  gatherResourceTaskSchema,
  secureFoodTaskSchema,
  type MinecraftTask,
} from "./games/minecraft/task.js";
import { MinecraftTaskRunner } from "./games/minecraft/task-runner.js";
import { minecraftLogNames } from "./games/minecraft/capabilities.js";
import { createFakeMinecraftFixture, FakeMinecraftAdapter } from "./testing/fake-minecraft-adapter.js";
import { evaluationScenarios } from "./testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "./testing/simulated-minecraft/adapter.js";
import { loadScenario } from "./testing/scenario.js";
import { ScenarioRunner } from "./testing/scenario-runner.js";

type TaskChoice = "gather-logs" | "craft-wooden-pickaxe" | "secure-food";

const TASK_CHOICES: readonly TaskChoice[] = ["gather-logs", "craft-wooden-pickaxe", "secure-food"];

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
          throw new Error("--demo-task supports 'gather-logs', 'craft-wooden-pickaxe', or 'secure-food'.");
        }
        if (next && !next.startsWith("--")) index += 1;
        demoTaskKind = taskValue;
        break;
      }
      case "--task": {
        const taskValue = value();
        if (!isTaskChoice(taskValue)) {
          throw new Error("--task supports 'gather-logs', 'craft-wooden-pickaxe', or 'secure-food'.");
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
  if ((demo || demoTask) && (lookYaw !== undefined || lookPitchProvided)) {
    throw new Error("Orientation flags cannot be combined with an offline demo.");
  }
  const selectedTask = task ?? demoTaskKind;
  if (resource !== undefined && (!demoTask && task === undefined || selectedTask !== "gather-logs")) {
    throw new Error("--resource is supported only by the gather-logs task.");
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
  };
}

function printHelp(): void {
  console.log(`GameMind — bounded Minecraft agent loop

Usage:
  npm run dev -- --demo
  npm run dev -- --demo-task [gather-logs|craft-wooden-pickaxe|secure-food]
  npm run dev -- --sim food-remote-berries --seed 101
  npm run dev -- --task craft-wooden-pickaxe --host 127.0.0.1
  npm run dev -- --task secure-food --target-hunger 18 --host 127.0.0.1

Offline:
  --demo               Run the seeded look scenario against the offline fake adapter
  --demo-task [TASK]   Run gather-logs (default), craft-wooden-pickaxe (fixture) or secure-food (simulated world) offline
  --sim SCENARIO       Run one offline simulated scenario (see src/testing/eval/scenarios.ts; e.g. explore-remote-log)
  --seed N             Seed for --sim scenarios (default 101)

Live Java server (requires an authorized private/local server):
  --task TASK          Run gather-logs, craft-wooden-pickaxe, or secure-food on a Java server
  --resource NAME      Log item to gather (oak_log, birch_log, spruce_log, ...)
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

function configuredGatherTask(options: CliOptions, offline = false) {
  const resourceName = options.resource ?? DEFAULT_GATHER_LOG_TASK.resourceName;
  if (!minecraftLogNames.includes(resourceName as (typeof minecraftLogNames)[number])) {
    throw new Error(`Unsupported log resource '${resourceName}'.`);
  }
  return gatherResourceTaskSchema.parse({
    ...DEFAULT_GATHER_LOG_TASK,
    id: offline ? "offline-gather-log-demo" : `gather-${resourceName}`,
    resourceName,
    targetCount: options.count ?? DEFAULT_GATHER_LOG_TASK.targetCount,
    ...taskLimitOverrides(options),
  });
}

function configuredTask(options: CliOptions, offline = false): MinecraftTask {
  const taskKind = options.task ?? options.demoTaskKind ?? "gather-logs";
  if (taskKind === "craft-wooden-pickaxe") {
    return craftItemTaskSchema.parse({
      ...DEFAULT_CRAFT_PICKAXE_TASK,
      id: offline ? "offline-craft-wooden-pickaxe-demo" : "craft-wooden-pickaxe",
      targetCount: options.count ?? DEFAULT_CRAFT_PICKAXE_TASK.targetCount,
      ...taskLimitOverrides(options),
    });
  }
  if (taskKind === "secure-food") {
    return secureFoodTaskSchema.parse({
      ...DEFAULT_SECURE_FOOD_TASK,
      id: offline ? "offline-secure-food-demo" : "secure-food",
      targetHunger: options.targetHunger ?? DEFAULT_SECURE_FOOD_TASK.targetHunger,
      ...taskLimitOverrides(options),
    });
  }
  return configuredGatherTask(options, offline);
}

async function runDemoTask(
  options: CliOptions,
  trace: TraceRecorder,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const taskKind = options.demoTaskKind ?? "gather-logs";
  if (taskKind === "secure-food") {
    // Berries and drops only exist in the simulated world, so the food demo runs there.
    await runSimulatedScenario(
      "food-remote-berries",
      options.seed ?? 101,
      trace,
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
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  try {
    const result = await new MinecraftTaskRunner(
      runtime,
      skills,
      new MinecraftTaskDecisionModel(),
      logger,
    ).run(configuredTask(options, true));
    console.log(JSON.stringify({ type: "task-report", offlineFixture: true, ...result }, null, 2));
    if (result.status !== "succeeded") {
      throw new Error(`Offline ${taskKind} task ended with status '${result.status}'.`);
    }
  } finally {
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
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(seed) });
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  try {
    const result = await new MinecraftTaskRunner(
      runtime,
      skills,
      new MinecraftTaskDecisionModel(),
      logger,
      { clock: () => adapter.simulatedNowMs },
    ).run(task);
    console.log(
      JSON.stringify(
        {
          type: "sim-task-report",
          simulatedWorld: true,
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
        },
        null,
        2,
      ),
    );
    if (result.status !== "succeeded" && scenario.expectation === "success") {
      throw new Error(`Simulated scenario '${scenarioId}' ended with status '${result.status}'.`);
    }
  } finally {
    await runtime.shutdown(`simulated scenario ${scenarioId} complete`);
  }
}

async function runMinecraft(
  options: CliOptions,
  trace: TraceRecorder,
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
  };
  const adapter = new MinecraftAdapter(logger, config);
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);

  const onSignal = (signal: NodeJS.Signals): void => {
    logger.warn({ signal }, "Shutdown signal received; closing Minecraft session safely");
    void runtime.shutdown(signal).catch((error: unknown) => {
      logger.error({ err: error }, "Safe shutdown after signal failed");
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const session = await runtime.connect();
    logger.info(
      {
        sessionId: session.id,
        gameVersion: session.gameVersion,
        host: config.host,
        port: config.port,
        capabilities: adapter.capabilities.map(({ name }) => name),
      },
      "Minecraft observation loop connected",
    );

    if (task) {
      const result = await new MinecraftTaskRunner(
        runtime,
        skills,
        new MinecraftTaskDecisionModel(),
        logger,
      ).run(task);
      console.log(JSON.stringify({ type: "task-report", ...result }, null, 2));
      if (result.status !== "succeeded") {
        throw new Error(
          `Minecraft ${options.task} task ended with status '${result.status}': ${result.failure?.message ?? "unknown task result"}`,
        );
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
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
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
  const trace = new TraceRecorder(new JsonlTraceSink(options.traceDirectory), logger);
  if (options.demo) {
    await runDemo(trace, logger);
    return;
  }
  if (options.sim !== undefined) {
    await runSimulatedScenario(options.sim, options.seed ?? 101, trace, logger, options, false);
    return;
  }
  if (options.demoTask) {
    await runDemoTask(options, trace, logger);
    return;
  }
  await runMinecraft(options, trace, logger);
}

main().catch((error: unknown) => {
  const logger = createLogger();
  logger.error({ err: error }, "GameMind exited with an error");
  process.exitCode = 1;
});
