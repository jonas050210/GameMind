import type { MinecraftObservation } from "./observation.js";
import {
  buildShelterTaskSchema,
  craftItemTaskSchema,
  gatherResourceTaskSchema,
  mineResourceTaskSchema,
  type MinecraftTask,
} from "./task.js";
import { generateAutonomousTask, MAX_AUTONOMOUS_DURATION } from "./autonomous-task.js";
import { ProgressTracker, type ProgressSnapshot } from "./progress-tracker.js";
import type { MinecraftTaskResult, TaskStatus } from "./task-runner.js";
import { heldCount } from "./inventory-accounting.js";

/**
 * The strategic layer of autonomous play: the current objective, the subgoal (one bounded task), its
 * completion criterion, and what to do when progress stops.
 *
 * The controller owns no game logic. It asks the milestone generator for the next subgoal and remembers
 * what each subgoal achieved. A subgoal that produced no observable progress twice in a row is put on
 * cooldown, and the controller falls back to another productive subgoal instead of repeating the failing
 * approach. Cooldowns expire, so a changed world (a new tree, an explored area) can re-open the subgoal.
 */

export const DEFAULT_SUBGOAL_COOLDOWN_MS = 120_000;
export const DEFAULT_FAILURES_BEFORE_COOLDOWN = 2;
const OUTCOME_HISTORY = 20;
/** Runaway guard for one autonomous subgoal. It is not a progress budget; see the task runner for stuck detection. */
const SUBGOAL_ACTION_GUARD = 5_000;

export type SubgoalOutcomeKind = "progress" | "no-progress" | "neutral";

export interface AutonomyOutcome {
  readonly taskId: string;
  readonly signature: string;
  readonly kind: SubgoalOutcomeKind;
  readonly status: TaskStatus;
  readonly actions: number;
  readonly reason: string;
  readonly at: string;
}

export interface AutonomyDecision {
  /** The subgoal to run now, or null when every candidate is cooling down or nothing needs doing. */
  readonly task: MinecraftTask | null;
  readonly objective: string;
  readonly subgoal: string;
  readonly completion: string;
  readonly reason: string;
  readonly fallback: boolean;
  /** Epoch milliseconds when a cooling subgoal becomes eligible again; null when none is cooling. */
  readonly retryAt: number | null;
}

export interface AutonomySnapshot {
  readonly objective: string;
  readonly subgoal: string | null;
  readonly completion: string | null;
  readonly reason: string;
  readonly fallback: boolean;
  readonly cooldowns: readonly { readonly signature: string; readonly until: string; readonly reason: string }[];
  readonly consecutiveNoProgress: number;
  readonly recentOutcomes: readonly AutonomyOutcome[];
  readonly decided: number;
  readonly fallbacksUsed: number;
}

export interface AutonomyControllerOptions {
  readonly tracker: ProgressTracker;
  readonly now?: () => number;
  readonly cooldownMs?: number;
  readonly failuresBeforeCooldown?: number;
}

/** Stable identity of a subgoal, so cooldowns follow the approach and not the generated task id. */
export function subgoalSignature(task: MinecraftTask): string {
  switch (task.kind) {
    case "gather_resource":
      return `gather:${task.resourceName}`;
    case "mine_resource":
      return `mine:${task.resourceName}`;
    case "craft_item":
      return `craft:${task.targetItem}`;
    case "secure_food":
      return "secure-food";
    case "build_shelter":
      return "build-shelter";
  }
}

export function describeSubgoal(task: MinecraftTask): { subgoal: string; completion: string } {
  switch (task.kind) {
    case "gather_resource":
      return {
        subgoal: `Gather ${task.targetCount} ${task.resourceName}`,
        completion: `inventory holds ${task.targetCount} ${task.resourceName}`,
      };
    case "mine_resource":
      return {
        subgoal: `Mine ${task.resourceName} (target ${task.targetCount})`,
        completion: `inventory holds ${task.targetCount} of the mined drop`,
      };
    case "craft_item":
      return {
        subgoal: `Craft ${task.targetCount} ${task.targetItem}`,
        completion: `inventory or equipment holds ${task.targetCount} ${task.targetItem}`,
      };
    case "secure_food":
      return { subgoal: "Restore hunger with food", completion: `hunger reaches ${task.targetHunger}/20` };
    case "build_shelter":
      return { subgoal: "Close the four cardinal sides", completion: "all four cardinal sides are observed solid" };
  }
}

/** Productive alternatives, in the order they are tried when the preferred subgoal is cooling down. */
function fallbackTasks(state: MinecraftObservation, progress: ProgressSnapshot): MinecraftTask[] {
  const inv = progress.inventory;
  const tasks: MinecraftTask[] = [];
  const logs = heldCount(state, ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"]);
  const cobble = heldCount(state, ["cobblestone"]);
  if (logs < 16) {
    tasks.push(gatherResourceTaskSchema.parse({
      id: `fallback:gather-logs:${logs}`,
      kind: "gather_resource",
      resourceName: "oak_log",
      targetCount: Math.min(64, logs + 4),
      maxActions: SUBGOAL_ACTION_GUARD,
      maxDurationMs: MAX_AUTONOMOUS_DURATION,
      maxExplorationLegs: 12,
    }));
  }
  if (inv.hasWoodenPickaxe || inv.hasStonePickaxe || inv.hasIronPickaxe) {
    tasks.push(mineResourceTaskSchema.parse({
      id: `fallback:mine-stone:${cobble}`,
      kind: "mine_resource",
      resourceName: "stone",
      targetCount: Math.min(64, cobble + 8),
      maxActions: SUBGOAL_ACTION_GUARD,
      maxDurationMs: MAX_AUTONOMOUS_DURATION,
      maxExplorationLegs: 16,
    }));
  }
  if (logs >= 1 && inv.planks < 8) {
    tasks.push(craftItemTaskSchema.parse({
      id: `fallback:craft-planks:${inv.planks}`,
      kind: "craft_item",
      targetItem: "oak_planks",
      targetCount: 4,
      maxActions: SUBGOAL_ACTION_GUARD,
      maxDurationMs: MAX_AUTONOMOUS_DURATION,
      maxExplorationLegs: 4,
    }));
  }
  if (inv.placeableBlocks >= 4) {
    tasks.push(buildShelterTaskSchema.parse({
      id: "fallback:build-shelter",
      kind: "build_shelter",
      targetStyle: "cardinal",
      maxActions: SUBGOAL_ACTION_GUARD,
      maxDurationMs: MAX_AUTONOMOUS_DURATION,
      maxRestMs: 0,
      maxExplorationLegs: 10,
    }));
  }
  return tasks;
}

function objectiveName(progress: ProgressSnapshot): string {
  return progress.currentMilestoneName || String(progress.currentMilestone).replace(/-/g, " ");
}

export class AutonomyController {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly failuresBeforeCooldown: number;
  private readonly streaks = new Map<string, number>();
  private readonly cooldowns = new Map<string, { until: number; reason: string }>();
  private outcomes: AutonomyOutcome[] = [];
  private current: AutonomyDecision | null = null;
  private decidedCount = 0;
  private fallbackCount = 0;
  private consecutiveNoProgress = 0;

  constructor(private readonly options: AutonomyControllerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = options.cooldownMs ?? DEFAULT_SUBGOAL_COOLDOWN_MS;
    this.failuresBeforeCooldown = options.failuresBeforeCooldown ?? DEFAULT_FAILURES_BEFORE_COOLDOWN;
  }

  /** Chooses the next subgoal from the observed world. Pure with respect to the game: it sends nothing. */
  next(state: MinecraftObservation): AutonomyDecision {
    this.expireCooldowns();
    const progress = this.options.tracker.getProgress(state);
    const objective = objectiveName(progress);
    this.decidedCount += 1;
    const preferred = generateAutonomousTask(state, this.options.tracker);
    if (!preferred) {
      return this.remember({
        task: null,
        objective,
        subgoal: "none",
        completion: "no milestone currently needs an action",
        reason: "The milestone generator has no subgoal for the current inventory and hunger.",
        fallback: false,
        retryAt: null,
      });
    }
    const preferredSignature = subgoalSignature(preferred);
    if (!this.cooldowns.has(preferredSignature)) {
      const described = describeSubgoal(preferred);
      return this.remember({
        task: preferred,
        objective,
        subgoal: described.subgoal,
        completion: described.completion,
        reason: `Objective "${objective}" needs: ${described.subgoal.toLowerCase()}.`,
        fallback: false,
        retryAt: null,
      });
    }
    const cooling = this.cooldowns.get(preferredSignature);
    for (const candidate of fallbackTasks(state, progress)) {
      if (this.cooldowns.has(subgoalSignature(candidate))) continue;
      this.fallbackCount += 1;
      const described = describeSubgoal(candidate);
      return this.remember({
        task: candidate,
        objective,
        subgoal: described.subgoal,
        completion: described.completion,
        reason: `"${preferredSignature}" is cooling down (${cooling?.reason ?? "no progress"}); falling back to ${described.subgoal.toLowerCase()}.`,
        fallback: true,
        retryAt: null,
      });
    }
    const retryAt = Math.min(...[...this.cooldowns.values()].map((entry) => entry.until));
    return this.remember({
      task: null,
      objective,
      subgoal: "waiting",
      completion: "a cooling subgoal becomes eligible again",
      reason: `Every candidate subgoal is cooling down after repeated no-progress attempts; retrying at ${new Date(retryAt).toISOString()}.`,
      fallback: true,
      retryAt,
    });
  }

  /** Folds a finished subgoal into the controller's memory. Interrupted or disconnected runs are neutral. */
  record(task: MinecraftTask, result: MinecraftTaskResult): AutonomyOutcome {
    const signature = subgoalSignature(task);
    const productive = result.metrics.progressEvents > 0 || result.metrics.targetItemsGained > 0 || result.metrics.foodGained > 0;
    const neutral = result.status === "aborted" || result.status === "disconnected";
    let kind: SubgoalOutcomeKind;
    let reason: string;
    if (neutral) {
      kind = "neutral";
      reason = `Run ended as ${result.status}; the subgoal is not judged.`;
    } else if (productive || (result.status === "succeeded" && result.actions.length > 0)) {
      kind = "progress";
      reason = `${result.metrics.progressEvents} observed progress event(s), ${result.metrics.targetItemsGained} target item(s) gained.`;
      this.streaks.set(signature, 0);
      this.cooldowns.delete(signature);
      this.consecutiveNoProgress = 0;
    } else {
      kind = "no-progress";
      reason = `${result.status}${result.failure ? ` (${result.failure.code})` : ""} after ${result.actions.length} action(s) with no observed progress.`;
      const streak = (this.streaks.get(signature) ?? 0) + 1;
      this.streaks.set(signature, streak);
      this.consecutiveNoProgress += 1;
      if (streak >= this.failuresBeforeCooldown) {
        this.cooldowns.set(signature, { until: this.now() + this.cooldownMs, reason: `${streak} no-progress attempts in a row` });
        reason += ` Cooling "${signature}" for ${Math.round(this.cooldownMs / 1000)} s.`;
      }
    }
    const outcome: AutonomyOutcome = {
      taskId: task.id,
      signature,
      kind,
      status: result.status,
      actions: result.actions.length,
      reason,
      at: new Date(this.now()).toISOString(),
    };
    this.outcomes = [outcome, ...this.outcomes].slice(0, OUTCOME_HISTORY);
    return outcome;
  }

  snapshot(): AutonomySnapshot {
    this.expireCooldowns();
    return {
      objective: this.current?.objective ?? "none",
      subgoal: this.current?.task ? this.current.subgoal : null,
      completion: this.current?.task ? this.current.completion : null,
      reason: this.current?.reason ?? "Autonomy has not chosen a subgoal yet.",
      fallback: this.current?.fallback ?? false,
      cooldowns: [...this.cooldowns.entries()].map(([signature, entry]) => ({
        signature,
        until: new Date(entry.until).toISOString(),
        reason: entry.reason,
      })),
      consecutiveNoProgress: this.consecutiveNoProgress,
      recentOutcomes: this.outcomes,
      decided: this.decidedCount,
      fallbacksUsed: this.fallbackCount,
    };
  }

  private remember(decision: AutonomyDecision): AutonomyDecision {
    this.current = decision;
    return decision;
  }

  private expireCooldowns(): void {
    const nowMs = this.now();
    for (const [signature, entry] of this.cooldowns) {
      if (entry.until <= nowMs) {
        this.cooldowns.delete(signature);
        this.streaks.set(signature, 0);
      }
    }
  }
}

