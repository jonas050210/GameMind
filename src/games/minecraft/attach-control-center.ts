import type { Logger } from "pino";
import { resolve } from "node:path";
import { generateAutonomousTask } from "./autonomous-task.js";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import type { ExperienceLearner } from "../../core/learning/learner.js";
import type { RingBufferTraceSink } from "../../core/trace.js";
import type { SafetyBroker } from "../../core/safety-broker.js";
import { startControlCenter } from "../../control-center/server.js";
import type { ControlCenterHandle, ControlCenterSnapshot } from "../../control-center/types.js";
import type { MinecraftObservation } from "./observation.js";
import { PersistentWorldMemory } from "./persistent-world-memory.js";
import { WorldMemory } from "./world-memory.js";
import {
  DEFAULT_BUILD_SHELTER_TASK,
  DEFAULT_CRAFT_PICKAXE_TASK,
  DEFAULT_GATHER_LOG_TASK,
  DEFAULT_MINE_COBBLESTONE_TASK,
  DEFAULT_SECURE_FOOD_TASK,
  buildShelterTaskSchema,
  craftItemTaskSchema,
  gatherResourceTaskSchema,
  mineResourceTaskSchema,
  secureFoodTaskSchema,
  type MinecraftTask,
} from "./task.js";
import { minecraftLogNames, minecraftCraftTaskItemNames } from "./capabilities.js";
import { minecraftMineableBlockNames } from "./mining.js";
import type { MinecraftTaskResult, MinecraftTaskRunnerOptions } from "./task-runner.js";
import { createControlCenterSource, type RunControl } from "./run-control.js";
import { ProgressTracker } from "./progress-tracker.js";
import { CompanionMemory } from "./companion-memory.js";
import { CompanionController } from "./companion-controller.js";
import { MINECRAFT_ATTACK_HOSTILE_CAPABILITY } from "./capabilities.js";

/** Task kinds the Control Center may start. Each maps onto one validated task schema. */
export const controlCenterTaskKinds = ["gather-logs", "mine-stone", "craft-wooden-pickaxe", "secure-food", "build-shelter"] as const;
export type ControlCenterTaskKind = (typeof controlCenterTaskKinds)[number];

/**
 * Builds a task from a UI request through the same schemas the CLI uses, so an operator cannot smuggle a
 * task that skips the limits. Unknown kinds throw with the list of valid ones.
 */
export function taskFromControlCenterRequest(request: {
  readonly kind: string;
  readonly resource?: string;
  readonly count?: number;
}): MinecraftTask {
  const kind = request.kind.trim();
  const targetCount = request.count;
  if (kind === "gather-logs") {
    const resourceName = request.resource ?? DEFAULT_GATHER_LOG_TASK.resourceName;
    if (!(minecraftLogNames as readonly string[]).includes(resourceName)) {
      throw new Error(`'${resourceName}' is not a log this task can gather. Known: ${minecraftLogNames.join(", ")}.`);
    }
    return gatherResourceTaskSchema.parse({
      ...DEFAULT_GATHER_LOG_TASK,
      id: `ui-gather-${resourceName}`,
      resourceName,
      ...(targetCount === undefined ? {} : { targetCount }),
    });
  }
  if (kind === "mine-stone") {
    const resourceName = request.resource ?? DEFAULT_MINE_COBBLESTONE_TASK.resourceName;
    if (!(minecraftMineableBlockNames as readonly string[]).includes(resourceName)) {
      throw new Error(`'${resourceName}' is not a mineable block. Known: ${minecraftMineableBlockNames.join(", ")}.`);
    }
    return mineResourceTaskSchema.parse({
      ...DEFAULT_MINE_COBBLESTONE_TASK,
      id: `ui-mine-${resourceName}`,
      resourceName,
      ...(targetCount === undefined ? {} : { targetCount }),
    });
  }
  if (kind === "craft-wooden-pickaxe") {
    const targetItem = request.resource ?? DEFAULT_CRAFT_PICKAXE_TASK.targetItem;
    if (!(minecraftCraftTaskItemNames as readonly string[]).includes(targetItem)) {
      throw new Error(`'${targetItem}' is not a craftable task target. Known: ${minecraftCraftTaskItemNames.join(", ")}.`);
    }
    return craftItemTaskSchema.parse({
      ...DEFAULT_CRAFT_PICKAXE_TASK,
      id: `ui-craft-${targetItem}`,
      targetItem,
      ...(targetCount === undefined ? {} : { targetCount }),
    });
  }
  if (kind === "secure-food") {
    return secureFoodTaskSchema.parse({
      ...DEFAULT_SECURE_FOOD_TASK,
      id: "ui-secure-food",
      ...(targetCount === undefined ? {} : { targetHunger: Math.min(20, targetCount) }),
    });
  }
  if (kind === "build-shelter") {
    return buildShelterTaskSchema.parse({
      ...DEFAULT_BUILD_SHELTER_TASK,
      id: "ui-build-shelter",
    });
  }
  throw new Error(`Unknown task kind '${kind}'. Choose one of: ${controlCenterTaskKinds.join(", ")}.`);
}

export interface MinecraftRunHostOptions {
  readonly runtime: GameMindRuntime<MinecraftObservation>;
  /** When supplied, enables the persistent companion/chat coordinator over the same gated skills. */
  readonly skills?: SkillRuntime;
  readonly companionMemoryDirectory?: string | null;
  /** Exact Minecraft username allowed to issue companion commands. Chat is ignored when unset. */
  readonly minecraftCommander?: string | null;
  readonly logger: Logger;
  readonly safety: SafetyBroker | null;
  readonly traceSink: RingBufferTraceSink;
  readonly learner?: ExperienceLearner | null;
  readonly memory?: WorldMemory;
  readonly worldKey?: string | null;
  readonly offlineNote?: string | null;
  readonly evaluationReportPath?: string | null;
  /** Current complete scenario manifest required for the same-seed candidate comparison. */
  readonly evaluationScenarioIds?: readonly string[];
  readonly title?: string;
  readonly port?: number;
  readonly bindHost?: string;
  /** The CLI owns runner construction (it knows the clock); the host only asks for another one. */
  readonly createRunner: (options: MinecraftTaskRunnerOptions) => { run(task: MinecraftTask): Promise<MinecraftTaskResult> };
  /** Extra snapshot fields, used by the simulated host to mark the world as synthetic. */
  readonly decorate?: (base: ControlCenterSnapshot) => ControlCenterSnapshot;
  /**
   * Whether the world behind this run came from a live server. Left unset it is inferred from `offlineNote`,
   * because the simulated host is the only caller that sets one, and an unmarked live run is worse than a
   * double-marked simulated one.
   */
  readonly worldSource?: "live" | "simulated";
  /** Invoked when the operator starts a task from the UI and it finishes; the demo uses it to print a report. */
  readonly onTaskFinished?: (result: MinecraftTaskResult, source: "cli" | "control-center") => void;
}

export interface MinecraftRunHost {
  readonly control: RunControl;
  readonly memory: WorldMemory;
  readonly companion: CompanionController | null;
  /** Options the caller must spread into its own runner so live state, budgets and cancellation are shared. */
  readonly runnerOptions: MinecraftTaskRunnerOptions;
  readonly handle: ControlCenterHandle | null;
  /** Runs a task through the host's runner factory, so the UI sees it exactly as an operator-started run. */
  runTask(task: MinecraftTask): Promise<MinecraftTaskResult>;
  /** Resolves when the abort signal fires: keeps a finished offline run inspectable in the browser. */
  waitUntil(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/**
 * Bridges a running agent and the Control Center. It owns no state of its own beyond the run bookkeeping:
 * the snapshot is computed from the runtime, the broker, the memory and the learner on every request, and
 * every command is forwarded to those objects.
 */
export async function attachMinecraftRunHost(options: MinecraftRunHostOptions): Promise<MinecraftRunHost> {
  const control: RunControl = {
    stopRequested: null,
    stoppingRequestedAt: null,
    task: null,
    result: null,
    lastTaskKind: null,
    actionsUsed: 0,
    startedMaxActions: null,
    startedAt: null,
    autonomous: false,
  };
  const memory = options.memory ?? new WorldMemory();
  const progressTracker = new ProgressTracker();
  const evaluationReportPath = options.evaluationReportPath ?? resolve("data/eval/offline-report.json");
  const evaluationScenarioIds = options.evaluationScenarioIds ?? [];
  // The dashboard polls the snapshot, so the host has nothing to push when state changes; `worldSource`
  // and `sessionChange` only tell the poll what it is looking at.
  const worldSource = options.worldSource ?? (options.offlineNote ? "simulated" : "live");
  const sessionAdapter = options.runtime.adapter as unknown as {
    readonly sessionChange?: { readonly at: string; readonly kind: string; readonly detail: string } | null;
    readonly combatAllowed?: boolean;
    setCombatAllowed?(allowed: boolean): void;
    onCompanionChat?(listener: (username: string, message: string) => void): () => void;
    sendCompanionChat?(message: string, recipient: string | null): void;
  };
  const companionMemory = options.skills
    ? await CompanionMemory.open(options.companionMemoryDirectory ?? null, options.worldKey ?? "unscoped-world")
    : null;
  const companion = options.skills && companionMemory
    ? new CompanionController({
        runtime: options.runtime,
        skills: options.skills,
        memory,
        companionMemory,
        logger: options.logger,
        runTask: (task) => execute(task, "control-center"),
        taskRunning: () => control.task !== null,
        requestTaskStop: (reason) => { if (control.task) control.stopRequested = reason; },
        setCombatAllowed: (enabled) => {
          if (typeof sessionAdapter.setCombatAllowed !== "function") return { ok: false, message: "This adapter cannot arm combat at runtime." };
          sessionAdapter.setCombatAllowed(enabled);
          options.safety?.configure({ optedInCapabilities: enabled ? [MINECRAFT_ATTACK_HOSTILE_CAPABILITY] : [] });
          return { ok: true, message: enabled ? "Combat armed through adapter and safety broker." : "Combat disarmed." };
        },
        replyMinecraft: (message, recipient) => sessionAdapter.sendCompanionChat?.(message, recipient),
      })
    : null;
  companion?.start();

  // Autonomous survival loop: runs when no task is active and the agent is connected.
  // Generates implicit survival tasks based on the agent's current needs.
  let autonomousTimer: NodeJS.Timeout | null = null;
  let autonomousRunning = false;
  const startAutonomousLoop = (): void => {
    if (autonomousTimer) return;
    autonomousTimer = setInterval(() => {
      if (autonomousRunning || control.task !== null) return;
      if (options.runtime.adapter.status !== "connected") return;
      if (options.safety?.snapshot().tripped || options.safety?.snapshot().paused) return;
      const world = options.runtime.currentWorldState;
      if (!world?.state) return;
      autonomousRunning = true;
      try {
        const autoTask = generateAutonomousTask(world.state, progressTracker);
        if (autoTask) {
          control.autonomous = true;
          void execute(autoTask, "cli").then(() => {
            autonomousRunning = false;
            control.autonomous = false;
          }).catch((error: unknown) => {
            options.logger.warn({ err: error }, "Autonomous task failed");
            autonomousRunning = false;
            control.autonomous = false;
          });
        }
      } catch (error) {
        options.logger.warn({ err: error }, "Autonomous loop tick failed");
        autonomousRunning = false;
      }
    }, 5_000);
    autonomousTimer.unref();
  };
  startAutonomousLoop();
  const unsubscribeChat = companion && options.minecraftCommander && sessionAdapter.onCompanionChat
    ? sessionAdapter.onCompanionChat((username, message) => {
        if (username !== options.minecraftCommander) return;
        if (!message.startsWith("#") && !/\b(come|follow|need|help|build|gather)\b/i.test(message)) return;
        void companion.submit(message, "minecraft", username);
      })
    : null;

  const source = createControlCenterSource({
    runtime: options.runtime,
    memory,
    learner: options.learner ?? null,
    safety: options.safety,
    traceSink: options.traceSink,
    control,
    evaluationReportPath,
    evaluationScenarioIds,
    worldSource,
    sessionChange: () => sessionAdapter.sessionChange ?? null,
    ...(options.worldKey !== undefined ? { worldKey: options.worldKey } : {}),
    ...(options.offlineNote !== undefined ? { offlineNote: options.offlineNote } : {}),
    logger: options.logger,
    companion,
    taskFor: taskFromControlCenterRequest,
    progressTracker,
    ...(options.decorate ? { decorate: options.decorate } : {}),
    onStart: async (task) => {
      if (!control.task) {
        await execute(task, "control-center");
      }
    },
  });

  async function execute(task: MinecraftTask, origin: "cli" | "control-center"): Promise<MinecraftTaskResult> {
    if (control.task) throw new Error("A task is already running in this agent; stop it before starting another.");
    control.task = task;
    control.result = null;
    control.startedMaxActions = task.maxActions;
    control.stopRequested = null;
    control.stoppingRequestedAt = null;
    control.autonomous = false;
    control.actionsUsed = 0;
    control.startedAt = new Date().toISOString();
    const runner = options.createRunner(host.runnerOptions);
    try {
      const result = await runner.run(task);
      control.result = result;
      control.lastTaskKind = task.kind;
      options.onTaskFinished?.(result, origin);
      return result;
    } finally {
      if (memory instanceof PersistentWorldMemory) {
        try {
          await memory.flush();
        } catch (error) {
          options.logger.warn({ err: error }, "Could not flush persistent world memory after task completion");
        }
      }
      control.task = null;
    }
  }

  const handle = await startControlCenter(
    {
      title: options.title ?? "GameMind",
      snapshot: source.snapshot,
      commands: source.commands,
    },
    {
      ...(options.bindHost !== undefined ? { host: options.bindHost } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      logger: {
        info: (message: string) => options.logger.info(message),
        warn: (message: string) => options.logger.warn(message),
        error: (message: string) => options.logger.error(message),
      },
      banner: options.offlineNote ?? null,
    },
  );
  const host: MinecraftRunHost = {
    control,
    memory,
    companion,
    handle,
    runnerOptions: {
      memory,
      onAction: () => {
        control.actionsUsed += 1;
      },
      shouldStop: () => control.stopRequested,
    },
    runTask: (task) => execute(task, "cli"),
    async waitUntil(signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    async close() {
      companion?.stop();
      if (autonomousTimer) {
        clearInterval(autonomousTimer);
        autonomousTimer = null;
      }
      unsubscribeChat?.();
      await handle.stop("run host closing");
      if (memory instanceof PersistentWorldMemory) {
        try {
          await memory.flush();
        } catch (error) {
          options.logger.warn({ err: error }, "Could not flush persistent world memory during shutdown");
        }
      }
    },
  };

  options.logger.info({ url: handle.url }, "Control Center available; open it in a browser to watch and steer this run");
  return host;
}
