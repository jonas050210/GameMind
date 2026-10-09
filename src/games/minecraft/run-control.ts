import type { Logger } from "pino";
import { readFile } from "node:fs/promises";
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

/** Adapters that can arm or disarm combat while running; the control is hidden when they cannot. */
export interface CombatGateAdapter {
  readonly combatAllowed?: boolean;
  setCombatAllowed?(allowed: boolean): void;
}

/** Fields the run host updates as the agent acts, so the UI reflects the loop rather than a snapshot at boot. */
export interface RunControl {
  /** Set when an operator asks the run to stop; checked between actions. */
  stopRequested: string | null;
  task: MinecraftTask | null;
  result: MinecraftTaskResult | null;
  /** Kind of the last task that finished, so the UI still describes the run after it ends. */
  lastTaskKind: MinecraftTask["kind"] | null;
  actionsUsed: number;
  /** The budget the last started task carried, kept after it ends so the UI can still show the ratio. */
  startedMaxActions: number | null;
  startedAt: string | null;
}

export interface ControlCenterSource {
  readonly runtime: GameMindRuntime<MinecraftObservation>;
  readonly memory: WorldMemory;
  readonly learner: ExperienceLearner | null;
  /** Null when the host deliberately runs without a broker; every safety control then says so. */
  readonly safety: SafetyBroker | null;
  readonly traceSink: RingBufferTraceSink;
  readonly control: RunControl;
  readonly evaluationReportPath?: string | null;
  readonly worldKey?: string | null;
  readonly offlineNote?: string | null;
  readonly logger: Logger;
  /** Builds the next task from a UI request; throws with a readable message when the kind is unknown. */
  taskFor?(request: { readonly kind: string; readonly resource?: string; readonly count?: number }): MinecraftTask;
  /** Called when the operator asks the UI to start a task; resolves when the run finishes. */
  onStart?(task: MinecraftTask): Promise<void>;
  /** Optional extra fields merged into the snapshot (used by the simulated demo host). */
  decorate?(base: ControlCenterSnapshot): ControlCenterSnapshot;
}

const BAND_LABELS = ["safety", "survival", "progress"] as const;

/** Same ceiling the task schemas enforce, so a UI request cannot out-run the validated limits. */
const TASK_MAX_ACTIONS = 100;

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
  if (task.kind === "secure_food") return { have: state.player.food ?? 0, of: task.targetHunger, unit: "hunger points" };
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

  const noBroker = (): ControlCommandResult => ({
    ok: false,
    message: "This run has no Safety Broker attached, so nothing can be paused or tripped from here.",
  });

  const commands: ControlCenterCommands = {
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
    setActionBudget(payload) {
      const value = typeof payload === "number" ? payload : Number((payload as { maxActions?: unknown })?.maxActions);
      if (!Number.isInteger(value) || value < 1 || value > TASK_MAX_ACTIONS) {
        return { ok: false, message: `The action budget must be an integer between 1 and ${TASK_MAX_ACTIONS}.` };
      }
      // Both limits move together: the task's own budget and the broker's hard cap. The broker counts up
      // from zero only when the next run starts, so this applies to the rest of the current run as well.
      safety?.configure({ maxActionsPerRun: value });
      if (control.task) {
        control.task = { ...control.task, maxActions: value };
      }
      return {
        ok: true,
        message: `Action budget set to ${value}: the running task's remaining actions and the broker's per-run cap both use it from now on.`,
      };
    },
    stopTask(reason) {
      if (!control.task) return { ok: false, message: "No task is running." };
      control.stopRequested = typeof reason === "string" && reason.length > 0 ? reason : "stopped by the operator";
      return { ok: true, message: `Stop requested; the run ends after the current action (${control.stopRequested}).` };
    },
    startTask(request) {
      if (safety?.snapshot().tripped) {
        return { ok: false, message: "The safety trip is still raised; reset it before starting a task." };
      }
      if (safety?.snapshot().paused) {
        return { ok: false, message: "The run is paused; resume it before starting a task." };
      }
      if (!source.taskFor || !source.onStart) {
        return { ok: false, message: "This run does not accept a new task from the Control Center." };
      }
      if (control.task) {
        return { ok: false, message: "A task is already running; stop it first." };
      }
      let task: MinecraftTask;
      try {
        task = source.taskFor(request ?? { kind: "gather-logs" });
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      void source.onStart(task).catch((error: unknown) => {
        source.logger.error({ err: error }, "Task started from the Control Center failed");
      });
      return { ok: true, message: `Started task '${task.id}' (${task.kind}).` };
    },
    async promotePolicy() {
      if (!learner) return { ok: false, message: "No experience learner is attached to this run." };
      const snapshot = learner.snapshot();
      if (snapshot.contradictedConfirmations > 0) {
        return {
          ok: false,
          message: `Refusing to promote: ${snapshot.contradictedConfirmations} confirmation(s) were contradicted by the world.`,
        };
      }
      if (snapshot.episodes === 0) return { ok: false, message: "Nothing learned yet; no candidate policy to promote." };
      if (snapshot.candidatePolicy.contexts === 0) {
        return {
          ok: false,
          message:
            "The derived candidate is still the baseline: no context reached the sample threshold, so promoting it would change nothing.",
        };
      }
      await learner.promote(learner.candidateWeights, "promoted from the Control Center after the episode-level safety check");
      return {
        ok: true,
        message: `Promoted ${learner.candidateWeights.id} (${Object.keys(learner.candidateWeights.entries).length} weighted contexts). Run 'npm run eval:offline' for the full gate.`,
      };
    },
    async rejectPolicy() {
      if (!learner) return { ok: false, message: "No experience learner is attached to this run." };
      await learner.rollback("candidate policy rejected from the Control Center");
      return { ok: true, message: "Rolled back to the baseline policy; the candidate weights are no longer in force." };
    },
  };

  async function snapshot(): Promise<ControlCenterSnapshot> {
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
    const base: ControlCenterSnapshot = {
      generatedAt: new Date().toISOString(),
      connection: {
        adapterStatus: status.adapterStatus,
        gameId: runtime.adapter.gameId,
        sessionId: status.sessionId,
        gameVersion: runtime.adapter.session?.gameVersion ?? null,
        server: source.worldKey ?? null,
        lastObservationAt: status.lastObservationAt,
        sequence: status.sequence,
        connectedForMs: world ? Math.max(0, Date.now() - Date.parse(world.observedAt)) : null,
      },
      agent: {
        // An operator hold is reported even between tasks: pausing while idle still blocks the next run,
        // and the UI must not make that look like an ordinary idle agent.
        state: control.task
          ? broker?.paused
            ? "paused"
            : "running"
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
        maxActions: control.task?.maxActions ?? control.startedMaxActions,
        elapsedMs: control.result?.metrics.elapsedMs ?? null,
        status: control.result?.status ?? null,
        failure: control.result?.failure ?? null,
      },
      goal: decision ? goalFromDecision(decision, control.task, state) : null,
      world: {
        position: state?.player.position ?? null,
        dimension: state?.player.dimension ?? null,
        gameMode: state?.player.gameMode ?? null,
        health: state?.player.health ?? null,
        food: state?.player.food ?? null,
        saturation: state?.player.foodSaturation ?? null,
        airTicks: state?.player.oxygenLevel ?? null,
        onGround: state?.player.onGround ?? null,
        time: state?.time ? { dayTicks: state.time.dayTicks, isNight: state.time.isNight } : null,
        entities: (state?.entities ?? []).slice(0, 24).map((entity) => ({
          id: entity.id,
          name: entity.name,
          distance: entity.distance,
          hostile: isHostileMinecraftEntity(entity.name, entity.type),
        })),
        blocks: (state?.nearbyBlocks ?? []).slice(0, 260).map((block) => ({
          x: block.position.x,
          y: block.position.y,
          z: block.position.z,
          name: block.name,
          hazard: isHazardBlockName(block.name),
          resource: isResourceBlockName(block.name) || block.name === targetItem,
        })),
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
        maxActionsPerRun: broker.policy.maxActionsPerRun,
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
      learning: {
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
        lastRun: control.result?.learning
          ? {
              episodes: control.result.learning.episodes,
              successes: control.result.learning.successes,
              failures: control.result.learning.failures,
              blockedTargets: control.result.learning.blockedTargets,
            }
          : null,
        evaluation: await readEvaluationSummary(source.evaluationReportPath ?? null),
      },
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
      combatAllowed: adapter.combatAllowed ?? null,
      offlineNote: source.offlineNote ?? null,
    };
    return source.decorate ? source.decorate(base) : base;
  }

  return { snapshot, commands };
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
      runs: 0,
      successRate: null,
      unsafeActions: null,
      passed: null,
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
      totals?: { runs?: number; successRate?: number; unsafeActions?: number };
      passed?: boolean;
    };
    return {
      reportPath: file,
      generatedAt: parsed.generatedAt ?? null,
      model: typeof parsed.model === "string" ? parsed.model : null,
      seedsPerScenario: typeof parsed.seedCount === "number" ? parsed.seedCount : null,
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios.length : 0,
      runs: parsed.totals?.runs ?? 0,
      successRate: typeof parsed.totals?.successRate === "number" ? parsed.totals.successRate : null,
      unsafeActions: typeof parsed.totals?.unsafeActions === "number" ? parsed.totals.unsafeActions : null,
      passed: typeof parsed.passed === "boolean" ? parsed.passed : null,
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
      runs: 0,
      successRate: null,
      unsafeActions: null,
      passed: null,
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

