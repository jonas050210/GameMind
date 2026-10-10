import type { Logger } from "pino";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import type { SafetyBroker } from "../../core/safety-broker.js";
import type { ExperienceLearner } from "../../core/learning/learner.js";
import type { TraceEvent } from "../../core/trace.js";
import type { RingBufferTraceSink } from "../../core/trace.js";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { MinecraftObservation } from "./observation.js";
import type { MinecraftTask } from "./task.js";
import type { MinecraftTaskResult } from "./task-runner.js";
import type { WorldMemory } from "./world-memory.js";
import type {
  ControlCenterActionView,
  ControlCenterCommands,
  ControlCenterRuntimePerformance,
  ControlCenterFailureView,
  ControlCenterSkillMetric,
  ControlCenterSnapshot,
  ControlCommandResult,
} from "../../control-center/types.js";
import { countItemAndEquipment } from "./recipes.js";
import { isHazardBlockName, isResourceBlockName } from "./block-classes.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { miningDropFor } from "./mining.js";
import { MINECRAFT_ATTACK_HOSTILE_CAPABILITY } from "./capabilities.js";
import type { EvaluationSummary } from "../../control-center/types.js";
import { shelterCardinalSolidCount } from "./skill-contracts.js";
import { classifyFailure, type FailureKind } from "../../core/failure-taxonomy.js";
import { MINECRAFT_SAFETY_POLICY } from "./safety-context.js";
import { runtimeEvidenceOf } from "../../roadmap/evidence.js";
import type { RoadmapService, RoadmapSnapshot } from "../../roadmap/service.js";
import type { AgentLoopPerformance } from "./runtime-metrics.js";

/** The roadmap view with the newest live measurements applied. The refresh itself runs in the background. */
function roadmapView(service: RoadmapService, loop: AgentLoopPerformance | null): RoadmapSnapshot | null {
  service.observeRuntime(runtimeEvidenceOf(loop));
  return service.snapshot();
}
import { policyPromotionRefusalReasons } from "./policy-promotion.js";
import { buildLocalTerrainModel } from "./terrain-model.js";
import { LibraryExecutor, createMinecraftLibraryRegistry } from "./library.js";
import { createRuntimePerformanceSampler } from "./runtime-performance.js";
import type { SchedulerSnapshot, SchedulerTicketView, Submission, TaskOrigin, TaskScheduler } from "./task-scheduler.js";

/** Adapters that can arm or disarm combat while running; the control is hidden when they cannot. */
export interface CombatGateAdapter {
  readonly combatAllowed?: boolean;
  setCombatAllowed?(allowed: boolean): void;
}

/** Fields the run host updates as the agent acts, so the UI reflects the loop rather than a snapshot at boot. */
export interface RunControl {
  /** Set when an operator asks the run to stop; checked between actions. */
  stopRequested: string | null;
  /** When the stop was requested, so the UI can show "stopping..." with elapsed time. */
  stoppingRequestedAt: string | null;
  task: MinecraftTask | null;
  result: MinecraftTaskResult | null;
  /** Kind of the last task that finished, so the UI still describes the run after it ends. */
  lastTaskKind: MinecraftTask["kind"] | null;
  actionsUsed: number;
  startedAt: string | null;
  /** True when the agent is running in autonomous survival mode (no explicit task). */
  autonomous: boolean;
}

export interface ControlCenterSource {
  readonly runtime: GameMindRuntime<MinecraftObservation>;
  /**
   * What the world data behind this snapshot is made of. `"simulated"` forces the banner and the
   * provenance line, because a simulated world must never be presented as a live observation.
   */
  readonly worldSource?: "live" | "simulated";
  /** Last dimension/game-mode change the live session reported, when the adapter can say. */
  readonly sessionChange?: () => { at: string; kind: string; detail: string } | null;
  readonly memory: WorldMemory;
  readonly learner: ExperienceLearner | null;
  /** Null when the host deliberately runs without a broker; every safety control then says so. */
  readonly safety: SafetyBroker | null;
  readonly traceSink: RingBufferTraceSink;
  readonly control: RunControl;
  readonly evaluationReportPath?: string | null;
  readonly evaluationScenarioIds?: readonly string[];
  readonly worldKey?: string | null;
  readonly offlineNote?: string | null;
  readonly logger: Logger;
  /** Skill runtime for direct Library skill execution; null when the host runs without skills. */
  readonly skills?: import("../../core/skill-runtime.js").SkillRuntime | null;
  readonly companion?: import("./library.js").LibraryCompanion & {
    snapshot(): import("./companion-controller.js").CompanionSnapshot;
  } | null;
  /** Builds the next task from a UI request; throws with a readable message when the kind is unknown. */
  taskFor?(request: { readonly kind: string; readonly resource?: string; readonly count?: number }): MinecraftTask;
  /** Called when the operator asks the UI to start a task; resolves when the run finishes. */
  onStart?(task: MinecraftTask, request?: { readonly origin?: TaskOrigin; readonly whenBusy?: "queue" | "reject" }): Promise<void>;
  /** The authoritative scheduler. When present, task admission is decided there and refusals carry its codes. */
  readonly scheduler?: TaskScheduler | null;
  /** Synchronous admission through the scheduler; the `startTask` command uses it to report queued/refused honestly. */
  submitTask?(task: MinecraftTask, request: { readonly origin: TaskOrigin; readonly whenBusy?: "queue" | "reject"; readonly label?: string }): Submission;
  /** Runtime switch for autonomous idle behaviour, and its current value. */
  setAutonomy?(enabled: boolean): void;
  autonomyEnabled?(): boolean;
  /** Optional extra fields merged into the snapshot (used by the simulated demo host). */
  decorate?(base: ControlCenterSnapshot): ControlCenterSnapshot;
  /** Optional progress tracker for multi-task autonomous progression. */
  readonly progressTracker?: import("./progress-tracker.js").ProgressTracker | null;
  /** Optional landmark memory for persistent world knowledge. */
  readonly landmarkMemory?: import("./landmark-memory.js").LandmarkMemory | null;
  /** Measured timing of the fast observation loop, decisions and actions. */
  readonly metrics?: import("./runtime-metrics.js").RuntimeMetrics | null;
  /** Subgoal strategy layer whose cooldowns and outcomes are shown as the objective. */
  readonly autonomy?: import("./autonomy-controller.js").AutonomyController | null;
  /** The fast loop itself, for its running and in-flight state. */
  readonly loop?: import("./agent-loop.js").FastObservationLoop | null;
  /** Improvement roadmap; refreshed from evidence and the live loop. */
  readonly roadmap?: import("../../roadmap/service.js").RoadmapService | null;
  /** Operator-entered world seed (manual; never auto-detected). */
  readonly worldSeed?: import("./world-seed.js").WorldSeedStore | null;
  /** Training and evaluation as separate processes; null when the host has no training support. */
  readonly training?: import("../../training/manager.js").TrainingControl | null;
}

const BAND_LABELS = ["safety", "survival", "progress"] as const;

/** How young the world panel's observation must be before the Control Center asks the game for another. */
const WORLD_VIEW_MAX_AGE_MS = 2_000;

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Live progress of the running task, recomputed from the newest observation rather than the trace. */
export function goalProgress(
  state: MinecraftObservation | null,
  task: MinecraftTask | null,
): { have: number; of: number; unit: string } | null {
  if (!state || !task) return null;
  // A hunger the session never reported is not 0/20; showing that would advertise starvation the agent
  // cannot see, so the panel reports no progress instead of a fabricated one.
  if (task.kind === "secure_food") {
    return state.player.food === null
      ? null
      : { have: state.player.food, of: task.targetHunger, unit: "hunger points" };
  }
  if (task.kind === "build_shelter") {
    return { have: shelterCardinalSolidCount(state), of: 4, unit: "closed sides" };
  }
  const item =
    task.kind === "gather_resource"
      ? task.resourceName
      : task.kind === "craft_item"
        ? task.targetItem
        : (miningDropFor(task.resourceName) ?? task.resourceName);
  return { have: countItemAndEquipment(state.inventory, state.equipment, item), of: task.targetCount, unit: item };
}

function traceView(event: TraceEvent) {
  return {
    traceId: event.traceId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    correlationId: event.correlationId,
    data: event.data,
  };
}

interface ActionDraft {
  at: string;
  correlationId: string | null;
  skillId: string | null;
  capability: string | null;
  goalId: string | null;
  status: string;
  confirmed: boolean | null;
  verification: string | null;
  durationMs: number | null;
  note: string | null;
}

/**
 * Single pass over the in-memory trace ring. Everything the UI shows as an executed action, a failure or a
 * per-skill statistic is derived here from the events the runtime actually wrote, so the dashboard cannot
 * drift from the log and there is no second bookkeeping to keep in sync.
 */
function foldTrace(sink: RingBufferTraceSink): {
  actions: readonly ControlCenterActionView[];
  failures: readonly ControlCenterFailureView[];
  skillMetrics: readonly ControlCenterSkillMetric[];
} {
  const byCorrelation = new Map<string, ActionDraft>();
  const order: string[] = [];
  const failures: ControlCenterFailureView[] = [];
  const bySkill = new Map<string, { attempts: number; successes: number; totalMs: number }>();
  const draftFor = (key: string, event: TraceEvent): ActionDraft => {
    const existing = byCorrelation.get(key);
    if (existing) return existing;
    const created: ActionDraft = {
      at: event.timestamp,
      correlationId: event.correlationId,
      skillId: null,
      capability: null,
      goalId: null,
      status: "executing",
      confirmed: null,
      verification: null,
      durationMs: null,
      note: null,
    };
    byCorrelation.set(key, created);
    order.push(key);
    return created;
  };

  for (const event of sink.recent) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.eventType === "skill.completed") {
      const action = draftFor(event.correlationId ?? event.traceId, event);
      const skillId = str(data.skillId, "unknown");
      action.skillId = skillId;
      action.status = str(data.status, action.status);
      action.confirmed = typeof data.confirmed === "boolean" ? data.confirmed : action.confirmed;
      action.durationMs = typeof data.durationMs === "number" ? data.durationMs : action.durationMs;
      const entry = bySkill.get(skillId) ?? { attempts: 0, successes: 0, totalMs: 0 };
      entry.attempts += 1;
      if (action.status === "succeeded" && action.confirmed === true) entry.successes += 1;
      entry.totalMs += action.durationMs ?? 0;
      bySkill.set(skillId, entry);
      continue;
    }
    if (event.eventType === "task.action") {
      const action = draftFor(event.correlationId ?? event.traceId, event);
      const record = (data.action ?? {}) as Record<string, unknown>;
      const decision = (data.decision ?? {}) as Record<string, unknown>;
      const verification = (data.verification ?? {}) as Record<string, unknown>;
      action.capability = str(record.capability, "") || action.capability;
      action.status = str(record.status, action.status);
      action.confirmed = typeof record.confirmed === "boolean" ? record.confirmed : action.confirmed;
      // `task.action` stores the whole decision record; the chosen goal is under `selected`.
      const selected = (decision.selected ?? {}) as Record<string, unknown>;
      action.goalId = typeof selected.goalId === "string" ? selected.goalId : action.goalId;
      const verified = verification.verified;
      action.verification =
        verified === true ? "verified" : verified === false ? "contradicted" : "unavailable";
      const failure = record.failure;
      if (failure && typeof failure === "object") {
        action.note = str((failure as Record<string, unknown>).message, "action failed");
      }
      if (action.status !== "succeeded" || verified === false) {
        failures.push({
          at: event.timestamp,
          kind: "action",
          summary: `${action.skillId ?? action.capability ?? "action"} ${action.status === "succeeded" ? "not verified" : `ended ${action.status}`}`,
          detail: action.note ?? (verified === false ? str(verification.evidence, "the world did not change as expected") : null),
        });
      }
      continue;
    }
    if (event.eventType === "safety.verdict" && data.allowed === false) {
      failures.push({
        at: event.timestamp,
        kind: "safety",
        summary: `${str(data.capability, "capability")} denied · ${str(data.code, "unknown")}`,
        detail: str(data.message),
      });
      continue;
    }
    if (event.eventType === "task.completed") {
      const status = str(data.status, "unknown");
      if (status !== "succeeded") {
        const failure = (data.failure ?? {}) as Record<string, unknown>;
        failures.push({
          at: event.timestamp,
          kind: "run",
          summary: `task ${status}`,
          detail: [str(failure.code), str(failure.message)].filter(Boolean).join(": ") || null,
        });
      }
    }
  }

  const actions = order
    .reverse()
    .slice(0, 24)
    .map((key) => byCorrelation.get(key))
    .filter((entry): entry is ActionDraft => entry !== undefined);
  return {
    actions,
    failures: failures.slice(-14).reverse(),
    skillMetrics: [...bySkill.entries()]
      .map(([skillId, entry]) => ({
        skillId,
        attempts: entry.attempts,
        successes: entry.successes,
        meanDurationMs: entry.attempts === 0 ? 0 : Math.round(entry.totalMs / entry.attempts),
      }))
      .sort((left, right) => right.attempts - left.attempts || left.skillId.localeCompare(right.skillId)),
  };
}

/**
 * Turns the live objects of a running agent into the Control Center snapshot plus its command surface.
 * Nothing here stores a copy of the truth: every field is read from the runtime, the memory, the broker
 * or the learner at request time, and every command calls a method on one of those.
 */
export function createControlCenterSource(source: ControlCenterSource): {
  snapshot(): Promise<ControlCenterSnapshot>;
  commands: ControlCenterCommands;
} {
  const { runtime, memory, learner, safety, traceSink, control } = source;
  const sampleRuntimePerformance = createRuntimePerformanceSampler();

  const noBroker = (): ControlCommandResult => ({
    ok: false,
    message: "This run has no Safety Broker attached, so nothing can be paused or tripped from here.",
  });

  // Central Library: one registry for the run, sharing the live runtime/skill/companion/task
  // objects. `hostCommands` is filled after `commands` is defined so Library safety/learning
  // entries delegate to the exact same handlers as the existing panels (no second code path).
  const libraryHostCommands: ControlCenterCommands = {};
  const library = new LibraryExecutor(createMinecraftLibraryRegistry(), {
    skills: source.skills ?? null,
    companion: source.companion ?? null,
    runtime,
    safety,
    control,
    learner,
    training: source.training ?? null,
    worldSeed: source.worldSeed ?? null,
    advertisedCapabilities: runtime.adapter.capabilities.map((capability) => capability.name),
    combatSwitchAvailable: typeof (runtime.adapter as unknown as CombatGateAdapter).setCombatAllowed === "function",
    ...(source.taskFor ? { taskFor: source.taskFor } : {}),
    ...(source.onStart ? { onStart: source.onStart } : {}),
    hostCommands: libraryHostCommands,
    logger: source.logger,
  });

  const commands: ControlCenterCommands = {
    async libraryExecute(payload) {
      const id = typeof payload === "object" && payload !== null && typeof (payload as { id?: unknown }).id === "string"
        ? ((payload as { id: string }).id)
        : "";
      const params = typeof payload === "object" && payload !== null && typeof (payload as { params?: unknown }).params === "object" && (payload as { params?: unknown }).params !== null
        ? ((payload as { params: Readonly<Record<string, unknown>> }).params)
        : {};
      if (!id) return { ok: false, message: "Library entry id is required." };
      const operation = await library.execute(id, params);
      // HTTP status follows the measured outcome: running/succeeded => 200, refused/failed => 409.
      // The operation itself carries the specific failure code and message.
      if (operation.state === "succeeded" || operation.state === "running") {
        return { ok: true, message: operation.message, data: operation };
      }
      return { ok: false, message: operation.message, data: operation };
    },
    pause(reason) {
      if (!safety) return noBroker();
      safety.pause(typeof reason === "string" && reason.length > 0 ? reason : "paused from the Control Center");
      return { ok: true, message: "Run paused: the Safety Broker now refuses every world-changing action." };
    },
    resume() {
      if (!safety) return noBroker();
      if (safety.snapshot().tripped) {
        return { ok: false, message: "Still tripped. Reset the trip before resuming." };
      }
      safety.resume();
      return { ok: true, message: "Run resumed." };
    },
    trip(reason) {
      if (!safety) return noBroker();
      safety.trip(typeof reason === "string" && reason.length > 0 ? reason : "tripped from the Control Center");
      return { ok: true, message: "Safety trip raised: nothing but read-only actions will run until an operator resets it." };
    },
    resetTrip() {
      if (!safety) return noBroker();
      // Clearing a trip also lifts the pause the trip itself imposed, but never a pause an operator set
      // on their own; the message says which of the two states the run is in now.
      safety.clearTrip();
      const after = safety.snapshot();
      return {
        ok: true,
        message: after.paused
          ? `Trip cleared, but this run is still paused (${after.pauseReason ?? "no reason given"}); resume it when you want actions to run again.`
          : "Trip cleared; the run accepts actions again.",
      };
    },
    enableCombat(payload) {
      const adapter = runtime.adapter as unknown as CombatGateAdapter;
      if (typeof adapter.setCombatAllowed !== "function") {
        return {
          ok: false,
          message: "This adapter has no runtime combat switch; restart the run with --allow-combat.",
        };
      }
      const enabled = payload === true || (typeof payload === "object" && payload !== null && (payload as { enabled?: boolean }).enabled === true);
      adapter.setCombatAllowed(enabled);
      safety?.configure({ optedInCapabilities: enabled ? [MINECRAFT_ATTACK_HOSTILE_CAPABILITY] : [] });
      return {
        ok: true,
        message: enabled
          ? "Combat armed: the adapter accepts attack actions and the safety policy lists the capability."
          : "Combat disarmed: attacks are refused at both the adapter and the safety policy.",
      };
    },
    setWorldSeed(seed) {
      if (!source.worldSeed) return { ok: false, message: "This host has no world-seed store." };
      try {
        const stored = source.worldSeed.set(seed);
        return {
          ok: true,
          message: stored
            ? `World seed saved as ${stored}. It is an operator-entered value and is not verified against the server.`
            : "World seed cleared.",
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    async startTraining(options) {
      if (!source.training) return { ok: false, message: "Training is not available in this host." };
      return source.training.start(options ?? {});
    },
    async pauseTraining() {
      if (!source.training) return { ok: false, message: "Training is not available in this host." };
      return source.training.pause();
    },
    async resumeTraining() {
      if (!source.training) return { ok: false, message: "Training is not available in this host." };
      return source.training.resume();
    },
    async refreshRoadmap() {
      if (!source.roadmap) return { ok: false, message: "The roadmap is not available in this host." };
      const snapshot = await source.roadmap.refresh();
      return { ok: true, message: `Roadmap refreshed: ${snapshot.items.length} open item(s).` };
    },
    async roadmapAction(payload) {
      if (!source.roadmap) return { ok: false, message: "The roadmap is not available in this host." };
      return source.roadmap.act(payload ?? {});
    },
    async stopTraining() {
      if (!source.training) return { ok: false, message: "Training is not available in this host." };
      return source.training.stop();
    },
    async evaluateTraining(checkpointId) {
      if (!source.training) return { ok: false, message: "Training is not available in this host." };
      return source.training.evaluate(checkpointId);
    },
    stopTask(reason) {
      if (!control.task) return { ok: false, message: "No task is running." };
      control.stopRequested = typeof reason === "string" && reason.length > 0 ? reason : "stopped by the operator";
      control.stoppingRequestedAt = new Date().toISOString();
      return { ok: true, message: `Stop requested; the run ends after the current action (${control.stopRequested}).` };
    },
    panic() {
      // Emergency stop: simultaneously trip safety, stop task, and disarm combat.
      const messages: string[] = [];
      if (safety) {
        safety.trip("emergency panic from the Control Center");
        messages.push("safety tripped");
      }
      if (control.task) {
        control.stopRequested = "emergency stop";
        control.stoppingRequestedAt = new Date().toISOString();
        messages.push("task stop requested");
      }
      const adapter = runtime.adapter as unknown as CombatGateAdapter;
      if (typeof adapter.setCombatAllowed === "function") {
        adapter.setCombatAllowed(false);
        safety?.configure({ optedInCapabilities: [] });
        messages.push("combat disarmed");
      }
      return { ok: true, message: `Emergency stop activated: ${messages.join(", ")}. Reset trip and resume when safe.` };
    },
    startTask(request) {
      if (safety?.snapshot().tripped) {
        return { ok: false, message: "The safety trip is still raised; reset it before starting a task." };
      }
      if (safety?.snapshot().paused) {
        return { ok: false, message: "The run is paused; resume it before starting a task." };
      }
      if (!source.taskFor || (!source.onStart && !source.submitTask)) {
        return { ok: false, message: "This run does not accept a new task from the Control Center." };
      }
      let task: MinecraftTask;
      try {
        task = source.taskFor(request ?? { kind: "gather-logs" });
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (source.submitTask) {
        // The scheduler decides synchronously: started now, queued, or refused with a code and a sentence.
        const submission = source.submitTask(task, {
          origin: "control-center",
          whenBusy: request?.queue === true ? "queue" : "reject",
        });
        if (!submission.accepted) {
          return { ok: false, message: submission.message, data: { code: submission.code } };
        }
        submission.done.catch((error: unknown) => {
          source.logger.error({ err: error }, "Task started from the Control Center failed");
        });
        const message = submission.position === 0
          ? `Started task '${task.id}' (${task.kind}).`
          : submission.preempting
            ? `Queued task '${task.id}' next: the autonomous task is stopping at its next action boundary.`
            : `Queued task '${task.id}' at position ${submission.position}; it runs after the current task.`;
        return { ok: true, message, data: { ticketId: submission.ticketId, position: submission.position, preempting: submission.preempting } };
      }
      if (control.task) {
        return { ok: false, message: "A task is already running; stop it first." };
      }
      void source.onStart!(task).catch((error: unknown) => {
        source.logger.error({ err: error }, "Task started from the Control Center failed");
      });
      return { ok: true, message: `Started task '${task.id}' (${task.kind}).` };
    },
    cancelQueuedTask(payload) {
      if (!source.scheduler) return { ok: false, message: "This run has no task scheduler." };
      const ticketId = typeof payload === "string" ? payload : typeof payload === "object" && payload !== null ? String((payload as { ticketId?: unknown }).ticketId ?? "") : "";
      if (ticketId.length === 0) return { ok: false, message: "A queued task id is required." };
      const outcome = source.scheduler.cancel(ticketId, "cancelled from the Control Center");
      if (outcome === null) return { ok: false, message: `No queued or running task has the id '${ticketId}'.` };
      return {
        ok: true,
        message: outcome === "cancelled" ? "Queued task cancelled." : "Stop requested; the run ends after the current action.",
      };
    },
    clearTaskQueue() {
      if (!source.scheduler) return { ok: false, message: "This run has no task scheduler." };
      const cancelled = source.scheduler.clearQueue("queue cleared from the Control Center");
      return { ok: true, message: cancelled === 0 ? "The queue was already empty." : `Cancelled ${cancelled} queued task(s).` };
    },
    setAutonomy(payload) {
      if (!source.setAutonomy) return { ok: false, message: "This run cannot change autonomy at runtime." };
      const enabled = typeof payload === "boolean" ? payload : typeof payload === "object" && payload !== null && (payload as { enabled?: unknown }).enabled === true;
      source.setAutonomy(enabled);
      return {
        ok: true,
        message: enabled
          ? "Autonomy is on: the agent starts its own survival and progress subgoals when idle. Safety limits are unchanged."
          : "Autonomy is off: the agent acts only on tasks you start. Safety limits are unchanged.",
      };
    },
    async promotePolicy() {
      if (!learner) return { ok: false, message: "No experience learner is attached to this run." };
      const snapshot = learner.snapshot();
      const report = await readEvaluationSummary(source.evaluationReportPath ?? null);
      const problems = policyPromotionRefusalReasons(
        {
          episodes: snapshot.episodes,
          candidateContexts: snapshot.candidatePolicy.contexts,
          contradictedConfirmations: snapshot.contradictedConfirmations,
          candidateWeightsId: learner.candidateWeights.id,
        },
        report,
        source.evaluationScenarioIds ?? [],
      );
      if (problems.length > 0) return { ok: false, message: `Refusing to promote: ${problems.join("; ")}.` };
      await learner.promote(
        learner.candidateWeights,
        `promoted from the Control Center; evaluation report ${report.generatedAt}`,
      );
      return {
        ok: true,
        message: `Promoted ${learner.candidateWeights.id} (${Object.keys(learner.candidateWeights.entries).length} weighted contexts) after a passing full-suite offline comparison.`,
      };
    },
    async rejectPolicy() {
      if (!learner) return { ok: false, message: "No experience learner is attached to this run." };
      await learner.rollback("candidate policy rejected from the Control Center");
      return { ok: true, message: "Rolled back to the baseline policy; the candidate weights are no longer in force." };
    },
  };
  Object.assign(libraryHostCommands, commands);

  async function snapshot(): Promise<ControlCenterSnapshot> {
    // A viewer that opens the page between runs would otherwise show the last observation of the run that
    // ended — indistinguishable from a live view. Refreshing only while nothing is running keeps the
    // world-model sequence out of the way of an in-flight action verification.
    // While the fast loop runs it already refreshes the view about once a second; an extra observation from
    // a UI poll could overlap with it, so the poll only refreshes when the loop is not running.
    const loopRunning = source.loop?.state.running === true;
    if (!loopRunning && source.worldSource !== "simulated" && control.task === null && runtime.status().adapterStatus === "connected") {
      await runtime.observeIfStale(WORLD_VIEW_MAX_AGE_MS);
    }
    const status = runtime.status();
    const world = runtime.currentWorldState;
    const state = world?.state ?? null;
    const memorySummary = memory.summary();
    const learning = learner?.snapshot() ?? null;
    const decision = traceSink.find("decision.made");
    const broker = safety?.snapshot() ?? null;
    const folded = foldTrace(traceSink);
    const adapter = runtime.adapter as unknown as CombatGateAdapter;
    // Blocks the operator's task is about are highlighted, so the map answers "did I see what I want?"
    const targetItem = control.task
      ? control.task.kind === "gather_resource"
        ? control.task.resourceName
        : control.task.kind === "craft_item"
          ? control.task.targetItem
          : control.task.kind === "mine_resource"
            ? (miningDropFor(control.task.resourceName) ?? control.task.resourceName)
            : ""
      : "";
    const observedAt = world?.observedAt ?? null;
    // How the world data below relates to the live session. A viewer must be able to tell "the agent is
    // looking at the world" from "the viewer is looking at the last thing it saw" from "there is nothing
    // to look at", because those three used to render identically.
    const ageMs = world ? Math.max(0, Date.now() - (Date.parse(world.observedAt) || Date.now())) : null;
    const maxAgeMs = MINECRAFT_SAFETY_POLICY.maxObservationAgeMs;
    const worldFreshness: ControlCenterSnapshot["world"]["freshness"] = world === null
      ? { sequence: null, observedAt: null, ageMs: null, stale: true, reason: source.worldSource === "simulated" ? "simulated" : "no-observation" }
      : !status.worldLive
        ? { sequence: world.sequence, observedAt: world.observedAt, ageMs, stale: true, reason: "session-changed" }
        : ageMs !== null && ageMs > maxAgeMs
          ? { sequence: world.sequence, observedAt: world.observedAt, ageMs, stale: true, reason: "stale" }
          : { sequence: world.sequence, observedAt: world.observedAt, ageMs, stale: false, reason: "fresh" };
    const worldProvenance: ControlCenterSnapshot["world"]["provenance"] = source.worldSource === "simulated"
      ? { source: "simulated", note: "This run is against the built-in simulated world; no live Minecraft server is involved." }
      : world !== null && status.worldLive
        ? { source: "live-observation", note: `Every value below came from observation #${world.sequence} of the connected session.` }
        : { source: "world-memory", note: "No live observation is available; the blocks shown are what the world model still remembers from an earlier observation." };
    const worldSessionFacts: ControlCenterSnapshot["world"]["sessionFacts"] = state === null
      ? null
      : {
          dimension: factView(state.player.session?.dimension, state.player.dimension, "observation.player.dimension"),
          gameMode: factView(state.player.session?.gameMode, state.player.gameMode, "observation.player.gameMode"),
          vitalsObservedAt: state.player.session?.vitalsObservedAt ?? null,
          airEvidence: state.player.session?.airEvidence ?? null,
          vitalsEvidence: state.player.session?.vitalsObserved ?? null,
          lastChange: source.sessionChange?.() ?? null,
        };

    const blocker = describeBlocker({
      adapterStatus: status.adapterStatus,
      statusReason: status.statusReason,
      paused: broker?.paused ?? false,
      pauseReason: broker?.pauseReason ?? null,
      tripped: broker?.tripped ?? false,
      tripReason: broker?.tripReason ?? null,
      taskStatus: control.result?.status ?? null,
      failure: control.result?.failure ?? null,
      blockingCode: strOrNull((decision?.data as Record<string, unknown> | undefined)?.blockingCode),
      decisionSummary: strOrNull((decision?.data as Record<string, unknown> | undefined)?.summary),
      running: control.task !== null,
      worldLive: status.worldLive,
      sequenceNote: status.sequence === null ? null : String(status.sequence),
      at: status.statusChangedAt ?? status.lastObservationAt,
    });

    const base: ControlCenterSnapshot = {
      generatedAt: new Date().toISOString(),
      performance: sampleRuntimePerformance(),
      connection: {
        adapterStatus: status.adapterStatus,
        gameId: runtime.adapter.gameId,
        sessionId: status.sessionId,
        gameVersion: runtime.adapter.session?.gameVersion ?? null,
        server: source.worldKey ?? null,
        lastObservationAt: status.lastObservationAt,
        sequence: status.sequence,
        connectedForMs: world ? Math.max(0, Date.now() - Date.parse(world.observedAt)) : null,
        statusReason: status.statusReason,
        statusChangedAt: status.statusChangedAt,
        worldAvailable: status.adapterStatus === "connected" && status.worldLive,
      },
      companion: source.companion?.snapshot() ?? null,
      scheduler: source.scheduler ? withClassification(source.scheduler.snapshot()) : null,
      autonomyEnabled: source.autonomyEnabled ? source.autonomyEnabled() : null,
      agent: {
        // An operator hold is reported even between tasks: pausing while idle still blocks the next run,
        // and the UI must not make that look like an ordinary idle agent.
        state: control.task
          ? control.stopRequested
            ? "stopping"
            : broker?.paused
              ? "paused"
              : "running"
          : control.autonomous
            ? "autonomous"
            : broker?.tripped
              ? "tripped"
              : broker?.paused
                ? "paused"
                : control.result
                  ? "stopped"
                  : "idle",
        taskId: control.task?.id ?? control.result?.taskId ?? null,
        taskKind: control.task?.kind ?? control.lastTaskKind,
        decisionModel: str((decision?.data as Record<string, unknown> | undefined)?.modelId, "minecraft-task-decision-model"),
        startedAt: control.startedAt,
        actionsUsed: control.actionsUsed,
        elapsedMs: control.result?.metrics.elapsedMs ?? null,
        status: control.result?.status ?? null,
        failure: control.result?.failure ?? null,
        blocker,
        stoppingRequestedAt: control.stoppingRequestedAt ?? null,
        autonomous: control.autonomous ?? false,
      },
      goal: decision ? goalFromDecision(decision, control.task, state) : null,
      world: {
        // No block or entity coordinates and no terrain census leave the agent: the Control Center is a status
        // surface, and those fields were only ever low-level diagnostics that the operator views did not need.
        position: state
          ? { x: Math.round(state.player.position.x), y: Math.round(state.player.position.y), z: Math.round(state.player.position.z) }
          : null,
        dimension: state?.player.dimension ?? null,
        gameMode: state?.player.gameMode ?? null,
        health: state?.player.health ?? null,
        food: state?.player.food ?? null,
        saturation: state?.player.foodSaturation ?? null,
        airTicks: state?.player.oxygenLevel ?? null,
        onGround: state?.player.onGround ?? null,
        alive: state?.player.alive ?? null,
        deathCount: state?.player.deathCount ?? null,
        time: state?.time
          ? {
              dayTicks: state.time.dayTicks,
              isNight: state.time.isNight,
              day: state.time.day ?? null,
              source: state.time.source ?? null,
            }
          : null,
        vitalsObservedAt: state?.player.session?.vitalsObservedAt ?? null,
        perception: state?.perception
          ? {
              ...state.perception,
              loadedChunks: state.perception.loadedChunks ?? state.resourceScan.loadedChunks?.length ?? null,
              resourceScanRadius: state.resourceScan.radius,
              resourceScanTruncated: state.resourceScan.truncated,
              minableScanRadius: state.minableScan?.radius ?? null,
              minableScanTruncated: state.minableScan?.truncated ?? null,
            }
          : null,
        entities: (state?.entities ?? []).slice(0, 24).map((entity) => ({
          id: entity.id,
          name: entity.name,
          distance: entity.distance,
          hostile: isHostileMinecraftEntity(entity.name, entity.type),
        })),
        provenance: worldProvenance,
        freshness: worldFreshness,
        sessionFacts: worldSessionFacts,
        knownResourceBlocks: memorySummary.resourceBlocks,
        minableBlocks: memorySummary.minableBlocks ?? 0,
        exploredCells: memorySummary.exploredCells,
        inventory: (state?.inventory ?? []).map((item) => ({ slot: item.slot, name: item.name, count: item.count })),
        equipment: {
          hand: state?.equipment.hand?.name ?? null,
          offhand: state?.equipment.offhand?.name ?? null,
          head: state?.equipment.head?.name ?? null,
          torso: state?.equipment.torso?.name ?? null,
          legs: state?.equipment.legs?.name ?? null,
          feet: state?.equipment.feet?.name ?? null,
        },
        inventoryFull: state?.player.inventoryFull ?? null,
      },
      safety: broker
        ? {
        policyId: broker.policy.id,
        enabled: broker.policy.enabled,
        maxRisk: broker.policy.maxRisk,
        paused: broker.paused,
        pauseReason: broker.pauseReason,
        tripped: broker.tripped,
        tripReason: broker.tripReason,
        actionsApproved: broker.actionsApproved,
        actionsDenied: broker.actionsDenied,
        deniedByCode: broker.deniedByCode,
        optedInCapabilities: broker.policy.optedInCapabilities,
        world: broker.world
          ? {
              health: broker.world.health,
              food: broker.world.food,
              visibleHostiles: broker.world.visibleHostiles,
              nearestHostileDistance: broker.world.nearestHostileDistance,
              isNight: broker.world.isNight,
              nearestHazardDistance: broker.world.nearestHazardDistance ?? null,
              nearestHazardName: broker.world.nearestHazardName ?? null,
              oxygenTicks: broker.world.oxygenTicks ?? null,
            }
          : null,
        recentVerdicts: (broker.recentVerdicts ?? []).slice(0, 12).map((verdict) => ({
          capability: verdict.capability,
          risk: verdict.risk,
          allowed: verdict.allowed,
          code: verdict.code,
          message: verdict.message,
          evaluatedAt: verdict.evaluatedAt,
        })),
      }
        : null,
      learning: buildLearningView(learning, control.result?.learning ?? null, await readEvaluationSummary(source.evaluationReportPath ?? null)),
      capabilities: runtime.adapter.capabilities.map((capability) => ({
        name: capability.name,
        risk: capability.risk,
        advertised: true,
        skillId: capability.name.replace(/^minecraft\./, "minecraft.").replace(/_/g, "-"),
      })),
      recentActions: folded.actions,
      recentFailures: folded.failures,
      recentDecisions: traceSink
        .filter((event) => event.eventType === "decision.made")
        .slice(-10)
        .reverse()
        .map(traceView),
      skillMetrics: folded.skillMetrics,
      progression: source.progressTracker && state
        ? (() => {
            const progress = source.progressTracker!.getProgress(state);
            return {
              currentMilestone: progress.currentMilestone,
              currentMilestoneName: progress.currentMilestoneName,
              completedMilestones: progress.completedMilestones,
              milestones: progress.milestones.map((m) => ({
                id: m.id,
                name: m.name,
                description: m.description,
                completed: m.completed,
              })),
              inventorySummary: {
                logs: progress.inventory.logs,
                planks: progress.inventory.planks,
                cobblestone: progress.inventory.cobblestone,
                food: progress.inventory.food,
                hasWoodenPickaxe: progress.inventory.hasWoodenPickaxe,
                hasStonePickaxe: progress.inventory.hasStonePickaxe,
                hasIronPickaxe: progress.inventory.hasIronPickaxe,
              },
            };
          })()
        : null,
      landmarks: source.landmarkMemory
        ? source.landmarkMemory.all.map((lm) => ({
            id: lm.id,
            type: lm.type,
            label: lm.label,
            position: { x: lm.position.x, y: lm.position.y, z: lm.position.z },
            createdAt: lm.createdAt,
            lastConfirmedSequence: lm.lastConfirmedSequence,
          }))
        : null,
      combatAllowed: adapter.combatAllowed ?? null,
      combatAllowedSource: typeof adapter.setCombatAllowed === "function"
        ? (adapter.combatAllowed ? "adapter" : "safety-policy")
        : null,
      offlineNote: source.offlineNote ?? null,
      agentLoop: source.metrics?.summary() ?? null,
      objective: source.autonomy?.snapshot() ?? null,
      worldSeed: source.worldSeed
        ? {
            value: source.worldSeed.value,
            source: source.worldSeed.value === null ? "unset" : "manual",
            verified: false,
            note: source.worldSeed.error
              ?? "Entered by the operator. It is not auto-detected or checked against the server, so anything derived from it is a prediction until verified.",
          }
        : null,
      training: source.training ? await source.training.snapshot() : null,
      roadmap: source.roadmap ? roadmapView(source.roadmap, source.metrics?.summary() ?? null) : null,
      library: {
        catalog: library.catalog,
        operations: library.listOperations(),
      },
    };
    return source.decorate ? source.decorate(base) : base;
  }

  return { snapshot, commands };
}

/** Adds the shared failure classification to every ticket that ended with a failure, so the page can explain it. */
function withClassification(snapshot: SchedulerSnapshot): SchedulerSnapshot {
  const annotate = (ticket: SchedulerTicketView): SchedulerTicketView =>
    ticket.failure ? { ...ticket, classification: classifyFailure(ticket.failure.code, ticket.failure.message) } : ticket;
  return { ...snapshot, active: snapshot.active ? annotate(snapshot.active) : null, queue: snapshot.queue.map(annotate), history: snapshot.history.map(annotate) };
}

/**
 * The learning panel's data from a learner snapshot. A pure function of its inputs so the same view is built for a live
 * session and for the app when no session exists: the policy store is on disk either way.
 */
export function buildLearningView(
  learning: ReturnType<ExperienceLearner["snapshot"]> | null,
  lastRun: { readonly episodes: number; readonly successes: number; readonly failures: number; readonly blockedTargets: number } | null,
  evaluation: EvaluationSummary | null,
): NonNullable<ControlCenterSnapshot["learning"]> {
  return {
    enabled: learning?.enabled ?? false,
    runs: learning?.runs ?? 0,
    episodes: learning?.episodes ?? 0,
    contexts: learning?.contexts ?? [],
    activePolicy: learning?.activePolicy ?? null,
    candidatePolicy: learning?.candidatePolicy ?? { id: "baseline-v1", contexts: 0 },
    blockedTargets: learning?.failureMemory ?? [],
    history: (learning?.history ?? []).map((entry) => ({
      runId: entry.runId,
      at: entry.at,
      note: entry.note,
      promoted: entry.promoted,
    })),
    lastRun: lastRun
      ? { episodes: lastRun.episodes, successes: lastRun.successes, failures: lastRun.failures, blockedTargets: lastRun.blockedTargets }
      : null,
    evaluation,
    reward: learning?.reward ?? null,
    classPatterns: learning?.classPatterns ?? [],
    checkpoints: learning?.checkpoints ?? null,
    experiments: learning?.experiments ?? [],
    rlReadiness: learning?.rlReadiness ?? null,
  };
}

/** Rebuilds a session fact for the dashboard from whatever the observation carried. */
function factView(
  reported:
    | {
        readonly value: string | null;
        readonly evidence: "verified" | "single-source" | "conflicting" | "unreported";
        readonly source: string;
        readonly observed: string;
        readonly note: string | null;
      }
    | undefined,
  value: string | null,
  fallbackSource: string,
): ControlCenterSnapshot["world"]["sessionFacts"] extends infer _T
  ? import("../../control-center/types.js").ControlCenterSessionFact
  : never {
  return {
    value,
    evidence: reported?.evidence ?? (value === null ? "unreported" : "single-source"),
    source: reported?.source ?? fallbackSource,
    observed:
      reported?.observed ?? `${fallbackSource.split(".").at(-1)}=${JSON.stringify(value) ?? "undefined"}`,
    note: reported?.note ?? null,
  };
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface BlockerInput {
  readonly adapterStatus: string;
  readonly statusReason: string | null;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly tripped: boolean;
  readonly tripReason: string | null;
  readonly taskStatus: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly blockingCode: string | null;
  readonly decisionSummary: string | null;
  readonly running: boolean;
  readonly worldLive: boolean;
  readonly sequenceNote: string | null;
  readonly at: string | null;
}

/**
 * Turns "blocked" into a sentence with a cause and an owner. Exactly one blocker is reported, chosen by
 * what actually stopped the loop: an operator hold, then the task's own failure, then the planner's
 * refusal, then the session. Each branch keeps the source's own wording — the classification only adds
 * the category, it never overwrites the reason.
 */
function describeBlocker(input: BlockerInput): ControlCenterSnapshot["agent"]["blocker"] {
  const clear = (): ControlCenterSnapshot["agent"]["blocker"] => ({
    kind: "none",
    code: null,
    label: input.running ? "running" : "idle",
    headline: input.running
      ? "The agent is acting; nothing is blocking it."
      : "No explicit task is active.",
    detail: input.running
      ? `The agent is between actions; the last observation is #${input.sequenceNote ?? "n/a"}.`
      : (input.statusReason ?? "The agent is idle. Start a task from the dashboard, run a Library action such as Follow player or Explore frontier, or let autonomous mode handle survival."),
    hint: input.running ? null : "Start a task, run a Library action, or wait for autonomous survival to activate.",
    owner: "unknown",
    source: "run control",
    at: input.at,
    retryable: false,
  });
  const shape = (
    kind: FailureKind | "connection",
    code: string | null,
    detail: string,
    source: string,
    owner: "agent" | "operator" | "server" | "unknown",
    retryable: boolean,
  ): ControlCenterSnapshot["agent"]["blocker"] => {
    const classified = classifyFailure(code, detail);
    return {
      // A connection-shaped status has no failure code of its own, so the category comes from the caller.
      kind,
      code: classified.code ?? code,
      label: classified.code ? classified.label : kind === "connection" ? "connection error" : classified.label,
      headline: `${input.taskStatus ?? "blocked"} · ${classified.code ?? "no code"} — ${truncate(detail, 220)}`,
      detail,
      hint: classified.hint,
      owner,
      source,
      at: input.at,
      retryable,
    };
  };

  if (input.tripped) {
    return shape("safety", "SAFETY_TRIPPED", input.tripReason ?? "The safety broker tripped and no reason was recorded.", "safety-broker", "operator", false);
  }
  if (input.paused) {
    return shape("safety", "SAFETY_PAUSED", input.pauseReason ?? "Paused from Run control.", "safety-broker", "operator", false);
  }
  if (input.failure) {
    const classified = classifyFailure(input.failure.code, input.failure.message);
    const owner = classified.kind === "connection" ? "server" : classified.kind === "capability" ? "operator" : "agent";
    return shape(classified.kind, input.failure.code, input.failure.message, "task runner", owner, classified.retryable);
  }
  if (input.taskStatus && input.taskStatus !== "succeeded") {
    return shape("task", input.blockingCode, `The task ended as '${input.taskStatus}' without a failure record.`, "task runner", "agent", true);
  }
  if (input.blockingCode) {
    return shape("planner", input.blockingCode, input.decisionSummary ?? "The decision model stopped without giving a reason.", "decision model", "agent", true);
  }
  if (input.adapterStatus !== "connected") {
    return shape(
      "connection",
      input.adapterStatus === "disconnected" ? "ADAPTER_DISCONNECTED" : "NOT_CONNECTED",
      input.statusReason ?? `The adapter reports '${input.adapterStatus}'.`,
      "adapter",
      "server",
      false,
    );
  }
  if (!input.worldLive) {
    return shape("perception", "NO_ACTIVE_OBSERVATION", "The agent has no observation from the current session yet.", "world model", "agent", true);
  }
  return clear();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function goalFromDecision(
  event: TraceEvent,
  task: MinecraftTask | null,
  state: MinecraftObservation | null,
): ControlCenterSnapshot["goal"] {
  const data = event.data as Record<string, unknown>;
  const selected = (data.selected ?? null) as Record<string, unknown> | null;
  const alternatives = Array.isArray(data.alternatives) ? (data.alternatives as Record<string, unknown>[]) : [];
  const rejected = Array.isArray(data.rejected) ? (data.rejected as Record<string, unknown>[]) : [];
  const band = num(selected?.priorityBand, 2);
  return {
    goalId: str(selected?.goalId, str(data.terminalStatus, "idle")),
    band,
    bandLabel: BAND_LABELS[band] ?? "progress",
    skillId: typeof selected?.skillId === "string" ? selected.skillId : null,
    targetKey: typeof selected?.targetKey === "string" ? selected.targetKey : null,
    rationale: str(data.summary) || str(selected?.rationale),
    blockingCode: typeof data.blockingCode === "string" ? data.blockingCode : null,
    progress: goalProgress(state, task),
    plan: Array.isArray(data.plan) ? (data.plan as unknown[]).map((step) => String(step)) : [],
    alternatives: alternatives.map((entry) => ({
      goalId: str(entry.goalId, "unknown"),
      skillId: typeof entry.skillId === "string" ? entry.skillId : null,
      targetKey: typeof entry.targetKey === "string" ? entry.targetKey : null,
      score: num(entry.score),
    })),
    rejected: rejected.map((entry) => ({
      goalId: str(entry.goalId, "unknown"),
      targetKey: typeof entry.targetKey === "string" ? entry.targetKey : null,
      reason: str(entry.reason, "unknown"),
      detail: str(entry.detail),
    })),
    safety:
      typeof data.safety === "object" && data.safety !== null
        ? {
            allowed: (data.safety as Record<string, unknown>).allowed === true,
            code: str((data.safety as Record<string, unknown>).code),
            message: str((data.safety as Record<string, unknown>).message),
          }
        : null,
  };
}

export async function readEvaluationSummary(file: string | null): Promise<EvaluationSummary> {
  if (!file) {
    return {
      reportPath: null,
      generatedAt: null,
      model: null,
      seedsPerScenario: null,
      scenarios: 0,
      scenarioIds: [],
      runs: 0,
      successRate: null,
      unsafeActions: null,
      passed: null,
      policyCandidateId: null,
      policyPromotable: null,
      policyGateReasons: [],
      learning: null,
    };
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      generatedAt?: string;
      model?: string;
      seedCount?: number;
      scenarios?: unknown[];
      learning?: unknown[];
      policyComparison?: {
        candidatePolicyId?: string;
        decision?: { promote?: boolean; reasons?: unknown[] };
      } | null;
      totals?: { runs?: number; successRate?: number; unsafeActions?: number };
      passed?: boolean;
    };
    return {
      reportPath: file,
      generatedAt: parsed.generatedAt ?? null,
      model: typeof parsed.model === "string" ? parsed.model : null,
      seedsPerScenario: typeof parsed.seedCount === "number" ? parsed.seedCount : null,
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios.length : 0,
      scenarioIds: Array.isArray(parsed.scenarios)
        ? parsed.scenarios.flatMap((entry) => {
            if (typeof entry !== "object" || entry === null) return [];
            const id = (entry as { scenarioId?: unknown }).scenarioId;
            return typeof id === "string" ? [id] : [];
          })
        : [],
      runs: parsed.totals?.runs ?? 0,
      successRate: typeof parsed.totals?.successRate === "number" ? parsed.totals.successRate : null,
      unsafeActions: typeof parsed.totals?.unsafeActions === "number" ? parsed.totals.unsafeActions : null,
      passed: typeof parsed.passed === "boolean" ? parsed.passed : null,
      policyCandidateId: parsed.policyComparison?.candidatePolicyId ?? null,
      policyPromotable: typeof parsed.policyComparison?.decision?.promote === "boolean"
        ? parsed.policyComparison.decision.promote
        : null,
      policyGateReasons: Array.isArray(parsed.policyComparison?.decision?.reasons)
        ? parsed.policyComparison.decision.reasons.filter((reason): reason is string => typeof reason === "string")
        : [],
      learning: Array.isArray(parsed.learning)
        ? summarizeLearningEvidence(parsed.learning as Record<string, unknown>[])
        : null,
    };
  } catch {
    return {
      reportPath: file,
      generatedAt: null,
      model: null,
      seedsPerScenario: null,
      scenarios: 0,
      scenarioIds: [],
      runs: 0,
      successRate: null,
      unsafeActions: null,
      passed: null,
      policyCandidateId: null,
      policyPromotable: null,
      policyGateReasons: [],
      learning: null,
    };
  }
}

/**
 * Folds the repeat-run evidence the offline evaluation writes at the top level of its report. Reported as
 * measured facts, never as a general claim: wasted actions stay non-zero wherever progress genuinely
 * requires those actions (crafting a tool, freeing inventory), and the panel says so through the gates.
 */
function summarizeLearningEvidence(entries: readonly Record<string, unknown>[]): EvaluationSummary["learning"] {
  let baseline = 0;
  let candidate = 0;
  let improved = 0;
  let passed = true;
  let measured = 0;
  for (const entry of entries) {
    const cold = entry.cold;
    const repeated = entry.repeated;
    if (typeof cold !== "object" || cold === null || typeof repeated !== "object" || repeated === null) continue;
    const before = num((cold as Record<string, unknown>).wastedActions);
    const after = num((repeated as Record<string, unknown>).wastedActions);
    baseline += before;
    candidate += after;
    if (after < before) improved += 1;
    if (entry.passed !== true) passed = false;
    measured += 1;
  }
  if (measured === 0) return null;
  return {
    baselineWastedActions: baseline,
    candidateWastedActions: candidate,
    scenarios: measured,
    improved,
    passed,
  };
}

