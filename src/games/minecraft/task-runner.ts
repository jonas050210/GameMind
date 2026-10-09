import type { ActionStatus, WorldState } from "../../core/types.js";
import { GameMindRuntime } from "../../core/game-mind-runtime.js";
import { type SkillExecutionResult, SkillRuntime } from "../../core/skill-runtime.js";
import type { Logger } from "pino";
import { MinecraftTaskDecisionModel } from "./decision-model.js";
import type { MinecraftObservation } from "./observation.js";
import type { MinecraftTask } from "./task.js";
import { countItemAndEquipment } from "./recipes.js";

export type TaskStatus =
  | "succeeded"
  | "blocked"
  | "failed"
  | "timed_out"
  | "max_actions"
  | "disconnected"
  | "aborted";

export interface TaskActionSummary {
  readonly actionId: string;
  readonly goalId: string;
  readonly skillId: string;
  readonly status: ActionStatus;
  readonly confirmed: boolean;
  readonly durationMs: number;
  readonly failureCode: string | null;
  readonly targetKey: string | null;
}

export interface TaskMetrics {
  readonly taskSucceeded: boolean;
  readonly targetItem: string;
  readonly targetCount: number;
  readonly targetItemsGained: number;
  readonly progressRatio: number;
  readonly decisions: number;
  readonly actions: number;
  readonly replans: number;
  readonly successfulActions: number;
  readonly failedActions: number;
  readonly progressEvents: number;
  readonly recoveryAttempts: number;
  readonly successfulRecoveries: number;
  readonly stuckActions: number;
  readonly itemsGained: Readonly<Record<string, number>>;
  readonly resourcesConsumed: Readonly<Record<string, number>>;
  readonly foodGained: number;
  readonly resourceCollected: number;
  readonly damageTaken: number;
  readonly elapsedMs: number;
}

export interface MinecraftTaskResult {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly metrics: TaskMetrics;
  readonly actions: readonly TaskActionSummary[];
  readonly finalObservation: WorldState<MinecraftObservation> | null;
}

function countItem(state: MinecraftObservation, itemName: string): number {
  return countItemAndEquipment(state.inventory, state.equipment, itemName);
}

function taskTarget(task: MinecraftTask): { item: string; count: number } {
  return task.kind === "gather_resource"
    ? { item: task.resourceName, count: task.targetCount }
    : { item: task.targetItem, count: task.targetCount };
}

function itemCounts(state: MinecraftObservation): Map<string, number> {
  const counts = new Map<string, number>();
  const occupiedSlots = new Set<number>();
  for (const item of state.inventory) {
    occupiedSlots.add(item.slot);
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  for (const item of Object.values(state.equipment)) {
    if (!item || occupiedSlots.has(item.slot)) continue;
    occupiedSlots.add(item.slot);
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return counts;
}

function observationFingerprint(state: MinecraftObservation): string {
  return JSON.stringify({
    player: {
      position: state.player.position,
      health: state.player.health,
      food: state.player.food,
    },
    inventory: state.inventory,
    equipment: state.equipment,
    entities: state.entities.map(({ id, position, name }) => ({ id, position, name })),
    nearbyBlocks: state.nearbyBlocks.map(({ position, name }) => ({ position, name })),
  });
}

function sameWorldState(
  before: WorldState<MinecraftObservation> | null,
  after: WorldState<MinecraftObservation> | null,
): boolean {
  if (!before || !after) return false;
  return observationFingerprint(before.state) === observationFingerprint(after.state);
}

class TaskDeadlineExceeded extends Error {
  constructor(operation: string) {
    super(`Task exceeded its overall time budget during ${operation}.`);
    this.name = "TaskDeadlineExceeded";
  }
}

function actionSummary(
  decisionGoalId: string,
  decisionTargetKey: string | null,
  skillId: string,
  result: SkillExecutionResult<MinecraftObservation>,
): TaskActionSummary {
  return {
    actionId: result.action.actionId,
    goalId: decisionGoalId,
    skillId,
    status: result.action.status,
    confirmed: result.action.confirmed,
    durationMs: result.action.durationMs,
    failureCode: result.action.failure?.code ?? null,
    targetKey: decisionTargetKey,
  };
}

export class MinecraftTaskRunner {
  constructor(
    private readonly runtime: GameMindRuntime<MinecraftObservation>,
    private readonly skills: SkillRuntime<MinecraftObservation>,
    private readonly decisionModel: MinecraftTaskDecisionModel,
    private readonly logger: Logger,
  ) {}

  private withinDeadline<T>(
    operation: () => Promise<T>,
    deadline: number,
    label: string,
  ): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return Promise.reject(new TaskDeadlineExceeded(label));

    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TaskDeadlineExceeded(label)), remainingMs);
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async run(task: MinecraftTask): Promise<MinecraftTaskResult> {
    const startedClock = Date.now();
    const deadline = startedClock + task.maxDurationMs;
    const actions: TaskActionSummary[] = [];
    const excludedTargets = new Set<string>();
    let decisions = 0;
    let successfulActions = 0;
    let failedActions = 0;
    let progressEvents = 0;
    let consecutiveFailures = 0;
    let consecutiveNoProgress = 0;
    let initialTargetCount = 0;
    let maximumTargetCount = 0;
    let accumulatedDamage = 0;
    let foodGained = 0;
    let recoveryAttempts = 0;
    let successfulRecoveries = 0;
    let stuckActions = 0;
    let awaitingRecovery = false;
    const itemsGained = new Map<string, number>();
    const resourcesConsumed = new Map<string, number>();
    const target = taskTarget(task);
    let lastFailureCode: string | null = null;
    let status: TaskStatus = "failed";
    let failure: MinecraftTaskResult["failure"] = null;

    await this.runtime.trace.record({
      eventType: "task.started",
      gameId: this.runtime.adapter.gameId,
      sessionId: this.runtime.session?.id ?? null,
      data: {
        task,
        decisionModel: this.decisionModel.modelId,
        startedAt: new Date(startedClock).toISOString(),
      },
    });

    try {
      if (this.runtime.adapter.status !== "connected" || !this.runtime.session) {
        await this.withinDeadline(() => this.runtime.connect(), deadline, "connection/initial observation");
      }
      if (!this.runtime.currentWorldState) {
        await this.withinDeadline(() => this.runtime.observe(), deadline, "initial observation");
      }

      const firstState = this.runtime.currentWorldState?.state ?? null;
      if (!firstState) throw new Error("Task started without a valid initial world state.");
      initialTargetCount = countItem(firstState, target.item);
      maximumTargetCount = initialTargetCount;

      while (true) {
        if (Date.now() >= deadline) {
          status = "timed_out";
          failure = { code: "TASK_DEADLINE", message: "Task exceeded its overall time budget." };
          break;
        }
        const world = this.runtime.currentWorldState;
        if (!world) {
          status = "disconnected";
          failure = { code: "WORLD_STATE_UNAVAILABLE", message: "No current world state is available." };
          break;
        }

        const decision = this.decisionModel.decide(
          world.state,
          task,
          { excludedTargets, previousFailureCode: lastFailureCode },
          world.sequence,
        );
        decisions += 1;
        await this.runtime.trace.record({
          eventType: "decision.made",
          gameId: world.gameId,
          sessionId: world.sessionId,
          correlationId: actions.at(-1)?.actionId ?? null,
          data: { ...decision },
        });

        if (decision.terminalStatus === "completed") {
          status = "succeeded";
          break;
        }
        if (decision.terminalStatus === "blocked" || !decision.selected) {
          status = "blocked";
          failure = {
            code: "NO_FEASIBLE_GOAL",
            message: decision.summary,
          };
          break;
        }
        if (actions.length >= task.maxActions) {
          status = "max_actions";
          failure = {
            code: "TASK_ACTION_BUDGET",
            message: `Task reached its limit of ${task.maxActions} actions before completion.`,
          };
          break;
        }

        const selected = decision.selected;
        const skill = this.skills.get(selected.skillId ?? "");
        if (!skill) {
          status = "failed";
          failure = {
            code: "SKILL_NOT_REGISTERED",
            message: `Decision selected unavailable skill '${selected.skillId}'.`,
          };
          break;
        }
        const capability = this.skills.capabilityRegistry.get(skill.capability);
        const timeoutBudget = Math.max(1, deadline - Date.now());
        const defaultTimeout = skill.defaultTimeoutMs ?? capability?.defaultTimeoutMs ?? timeoutBudget;
        const timeoutMs = Math.max(1, Math.min(defaultTimeout, timeoutBudget));

        const before = this.runtime.currentWorldState;
        let skillResult: SkillExecutionResult<MinecraftObservation>;
        try {
          skillResult = await this.skills.run(skill.id, selected.input, {
            timeoutMs,
            source: `decision:${decision.modelId}:${selected.goalId}`,
          });
        } catch (error) {
          this.logger.error(
            { err: error, taskId: task.id, skillId: skill.id },
            "Skill runtime threw while executing an autonomous task decision",
          );
          status = "failed";
          failure = {
            code: "SKILL_RUNTIME_EXCEPTION",
            message: error instanceof Error ? error.message : String(error),
          };
          break;
        }

        const summary = actionSummary(selected.goalId, selected.targetKey, skill.id, skillResult);
        actions.push(summary);
        const after = skillResult.observationAfter ?? this.runtime.currentWorldState;
        await this.runtime.trace.record({
          eventType: "task.action",
          gameId: this.runtime.adapter.gameId,
          sessionId: skillResult.action.sessionId,
          correlationId: skillResult.action.actionId,
          data: {
            taskId: task.id,
            decision,
            action: skillResult.action,
            observationBeforeSequence: before?.sequence ?? null,
            observationAfterSequence: after?.sequence ?? null,
          },
        });

        const beforeCount = before ? countItem(before.state, target.item) : 0;
        const afterCount = after ? countItem(after.state, target.item) : beforeCount;
        let observedProgress = afterCount > beforeCount;
        maximumTargetCount = Math.max(maximumTargetCount, afterCount);
        if (before && after) {
          const beforeCounts = itemCounts(before.state);
          const afterCounts = itemCounts(after.state);
          for (const [itemName, countBefore] of beforeCounts) {
            const countAfter = afterCounts.get(itemName) ?? 0;
            const decrease = countBefore - countAfter;
            if (decrease > 0) resourcesConsumed.set(itemName, (resourcesConsumed.get(itemName) ?? 0) + decrease);
          }
          for (const [itemName, countAfter] of afterCounts) {
            const gained = countAfter - (beforeCounts.get(itemName) ?? 0);
            if (gained > 0) {
              itemsGained.set(itemName, (itemsGained.get(itemName) ?? 0) + gained);
              observedProgress = true;
            }
          }
          if (before.state.player.food !== null && after.state.player.food !== null) {
            const gained = Math.max(0, after.state.player.food - before.state.player.food);
            foodGained += gained;
            if (gained > 0) observedProgress = true;
          }
          if (before.state.player.health !== null && after.state.player.health !== null) {
            accumulatedDamage += Math.max(0, before.state.player.health - after.state.player.health);
          }
        }
        if (observedProgress) progressEvents += 1;
        if (skillResult.action.failure?.code === "NAVIGATION_STUCK") stuckActions += 1;
        if (awaitingRecovery) {
          recoveryAttempts += 1;
          if (skillResult.action.status === "succeeded" && skillResult.action.confirmed) successfulRecoveries += 1;
          awaitingRecovery = false;
        }
        if (skillResult.action.status === "succeeded" && skillResult.action.confirmed) {
          successfulActions += 1;
          consecutiveFailures = 0;
          lastFailureCode = null;
        } else {
          failedActions += 1;
          consecutiveFailures += 1;
          lastFailureCode = skillResult.action.failure?.code ?? skillResult.action.status;
          awaitingRecovery = true;
          if (selected.targetKey) excludedTargets.add(selected.targetKey);
        }

        if (sameWorldState(before, after)) consecutiveNoProgress += 1;
        else consecutiveNoProgress = 0;

        if (skillResult.action.status === "disconnected") {
          status = "disconnected";
          failure = {
            code: skillResult.action.failure?.code ?? "ADAPTER_DISCONNECTED",
            message: skillResult.action.failure?.message ?? "Minecraft session disconnected during the task.",
          };
          break;
        }
        if (skillResult.action.status === "aborted") {
          status = "aborted";
          failure = {
            code: skillResult.action.failure?.code ?? "ACTION_ABORTED",
            message: skillResult.action.failure?.message ?? "Task action was aborted.",
          };
          break;
        }
        if (consecutiveFailures >= task.maxConsecutiveFailures) {
          status = "failed";
          failure = {
            code: "CONSECUTIVE_ACTION_FAILURES",
            message: `Task stopped after ${consecutiveFailures} consecutive failed actions; targets were excluded and replanning was attempted.`,
          };
          break;
        }
        if (consecutiveNoProgress >= task.maxConsecutiveFailures + 1) {
          status = "failed";
          failure = {
            code: "NO_PROGRESS",
            message: "Repeated successful actions did not produce an observable state change.",
          };
          break;
        }
      }
    } catch (error) {
      this.logger.error({ err: error, taskId: task.id }, "Autonomous task loop failed");
      if (error instanceof TaskDeadlineExceeded) {
        status = "timed_out";
        failure = { code: "TASK_DEADLINE", message: error.message };
        try {
          await this.runtime.adapter.disconnect("task deadline expired during setup");
        } catch (disconnectError) {
          this.logger.error(
            { err: disconnectError, taskId: task.id },
            "Could not close Minecraft adapter after task setup deadline",
          );
        }
      } else {
        status = this.runtime.adapter.status === "connected" ? "failed" : "disconnected";
        failure = {
          code: "TASK_RUNTIME_ERROR",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const finalObservation = this.runtime.currentWorldState;
    const finalTargetCount = finalObservation
      ? countItem(finalObservation.state, target.item)
      : initialTargetCount;
    maximumTargetCount = Math.max(maximumTargetCount, finalTargetCount);
    if (status === "failed" && finalTargetCount >= target.count) {
      // A final inventory delta is stronger evidence than a late planner/trace error.
      status = "succeeded";
      failure = null;
    }
    const targetItemsGained = Math.max(0, maximumTargetCount - initialTargetCount);
    const metrics: TaskMetrics = {
      taskSucceeded: status === "succeeded",
      targetItem: target.item,
      targetCount: target.count,
      targetItemsGained,
      progressRatio: Math.min(1, Math.max(0, maximumTargetCount / Math.max(1, target.count))),
      decisions,
      actions: actions.length,
      replans: Math.max(0, decisions - 1),
      successfulActions,
      failedActions,
      progressEvents,
      recoveryAttempts,
      successfulRecoveries,
      stuckActions,
      itemsGained: Object.fromEntries(itemsGained),
      resourcesConsumed: Object.fromEntries(resourcesConsumed),
      foodGained,
      resourceCollected: task.kind === "gather_resource" ? targetItemsGained : 0,
      damageTaken: accumulatedDamage,
      elapsedMs: Date.now() - startedClock,
    };
    const result: MinecraftTaskResult = {
      taskId: task.id,
      status,
      failure,
      metrics,
      actions,
      finalObservation,
    };

    await this.runtime.trace.record({
      eventType: "task.completed",
      gameId: this.runtime.adapter.gameId,
      sessionId: this.runtime.session?.id ?? finalObservation?.sessionId ?? null,
      data: { ...result },
    });
    return result;
  }
}
