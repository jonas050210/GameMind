import type { ActionStatus, WorldState } from "../../core/types.js";
import { GameMindRuntime } from "../../core/game-mind-runtime.js";
import { type SkillExecutionResult, SkillRuntime } from "../../core/skill-runtime.js";
import type { Logger } from "pino";
import {
  BAND_SAFETY,
  MinecraftTaskDecisionModel,
  type MinecraftDecisionContext,
  type MinecraftDecisionRecord,
} from "./decision-model.js";
import type { MinecraftObservation } from "./observation.js";
import type { MinecraftTask } from "./task.js";
import { countItemAndEquipment } from "./recipes.js";
import { verifySkillPostcondition } from "./skill-contracts.js";
import { WorldMemory } from "./world-memory.js";
import { isHostileMinecraftEntity } from "./threats.js";

export type TaskStatus =
  | "succeeded"
  | "blocked"
  | "failed"
  | "timed_out"
  | "max_actions"
  | "disconnected"
  | "aborted";

export type ActionVerification = "verified" | "unverified" | "unavailable" | "not_applicable";

export interface TaskActionSummary {
  readonly actionId: string;
  readonly goalId: string;
  readonly skillId: string;
  readonly status: ActionStatus;
  readonly confirmed: boolean;
  readonly durationMs: number;
  readonly failureCode: string | null;
  readonly targetKey: string | null;
  readonly verification: ActionVerification;
  readonly verificationEvidence: string | null;
  readonly band: number | null;
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
  readonly oscillations: number;
  readonly targetStalls: number;
  readonly itemsGained: Readonly<Record<string, number>>;
  readonly resourcesConsumed: Readonly<Record<string, number>>;
  readonly foodGained: number;
  readonly foodSourcesUsed: number;
  readonly resourceCollected: number;
  readonly damageTaken: number;
  readonly minHealth: number | null;
  readonly explorationLegs: number;
  readonly explorationCellsRevealed: number;
  readonly restMs: number;
  readonly verifiedActions: number;
  readonly unverifiedConfirmations: number;
  readonly unsafeActions: number;
  readonly planRevisions: number;
  readonly maxPlanLength: number;
  readonly knownResourceBlocksPeak: number;
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

export interface MinecraftTaskRunnerOptions {
  /** Task clock in milliseconds. Defaults to wall time; simulations pass virtual game time. */
  readonly clock?: () => number;
}

/** A target that is attempted this many times without observable progress is excluded. */
const MAX_ATTEMPTS_WITHOUT_PROGRESS = 3;
const OSCILLATION_WINDOW = 6;
const OSCILLATION_RADIUS = 3;
const MOVEMENT_SKILLS = new Set([
  "minecraft.navigate",
  "minecraft.collect-log",
  "minecraft.pickup-item",
  "minecraft.harvest-berries",
]);
/** Failures that indicate a route segment is blocked or stalled rather than the target being wrong. */
const ROUTE_STALL_CODES = new Set([
  "NAVIGATION_STUCK",
  "PATH_STOPPED",
  "PATH_PLANNING_TIMEOUT",
  "PATH_GOAL_CHANGED",
  "ACTION_TIMEOUT",
]);
const THREAT_SENSITIVE_SKILLS = new Set([
  "minecraft.collect-log",
  "minecraft.pickup-item",
  "minecraft.harvest-berries",
  "minecraft.place-crafting-table",
  "minecraft.rest",
]);

function countItem(state: MinecraftObservation, itemName: string): number {
  return countItemAndEquipment(state.inventory, state.equipment, itemName);
}

function taskTarget(task: MinecraftTask): { item: string; count: number } {
  if (task.kind === "gather_resource") return { item: task.resourceName, count: task.targetCount };
  if (task.kind === "craft_item") return { item: task.targetItem, count: task.targetCount };
  return { item: "minecraft.food", count: 0 };
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

function hostileNear(state: MinecraftObservation, point: { x: number; y: number; z: number }, radius: number): boolean {
  return state.entities.some(
    (entity) =>
      isHostileMinecraftEntity(entity.name, entity.type) &&
      Math.hypot(entity.position.x - point.x, entity.position.y - point.y, entity.position.z - point.z) <= radius,
  );
}

/** A threat-sensitive action must not start while a visible hostile is inside its danger radius. */
function threatAtActionStart(
  state: MinecraftObservation,
  skillId: string,
  input: unknown,
  fallbackRadius: number,
): boolean {
  if (!THREAT_SENSITIVE_SKILLS.has(skillId)) return false;
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const radius = typeof record.dangerRadius === "number" ? record.dangerRadius : fallbackRadius;
  if (skillId === "minecraft.rest") return hostileNear(state, state.player.position, radius);
  if (typeof record.x !== "number" || typeof record.y !== "number" || typeof record.z !== "number") return false;
  return hostileNear(state, { x: record.x + 0.5, y: record.y + 0.5, z: record.z + 0.5 }, radius);
}

function maxPairwiseDistance(points: ReadonlyArray<{ x: number; z: number }>): number {
  let max = 0;
  for (const left of points) {
    for (const right of points) max = Math.max(max, Math.hypot(left.x - right.x, left.z - right.z));
  }
  return max;
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
  band: number | null,
  verification: { verified: boolean | null; evidence: string },
  result: SkillExecutionResult<MinecraftObservation>,
  confirmedButUnverified: boolean,
): TaskActionSummary {
  const verificationState: ActionVerification = result.action.status !== "succeeded" && !result.action.confirmed
    ? "not_applicable"
    : confirmedButUnverified
      ? "unverified"
      : verification.verified === null
        ? "unavailable"
        : verification.verified
          ? "verified"
          : "unverified";
  return {
    actionId: result.action.actionId,
    goalId: decisionGoalId,
    skillId,
    status: result.action.status,
    confirmed: result.action.confirmed,
    durationMs: result.action.durationMs,
    failureCode: result.action.failure?.code ?? null,
    targetKey: decisionTargetKey,
    verification: verificationState,
    verificationEvidence: verification.evidence,
    band,
  };
}

export class MinecraftTaskRunner {
  private readonly clock: () => number;

  constructor(
    private readonly runtime: GameMindRuntime<MinecraftObservation>,
    private readonly skills: SkillRuntime<MinecraftObservation>,
    private readonly decisionModel: MinecraftTaskDecisionModel,
    private readonly logger: Logger,
    options: MinecraftTaskRunnerOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
  }

  private withinDeadline<T>(operation: () => Promise<T>, deadline: number, label: string): Promise<T> {
    const remainingMs = deadline - this.clock();
    if (remainingMs <= 0) return Promise.reject(new TaskDeadlineExceeded(label));

    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TaskDeadlineExceeded(label)), Math.max(1, remainingMs));
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
    const startedClock = this.clock();
    const deadline = startedClock + task.maxDurationMs;
    const actions: TaskActionSummary[] = [];
    const excludedTargets = new Set<string>();
    const attemptsWithoutProgress = new Map<string, number>();
    const movementHistory: Array<{ x: number; z: number }> = [];
    const memory = new WorldMemory();
    const target = taskTarget(task);
    let decisions = 0;
    let successfulActions = 0;
    let failedActions = 0;
    let progressEvents = 0;
    let consecutiveFailures = 0;
    let consecutiveNoProgress = 0;
    let initialTargetCount = 0;
    let maximumTargetCount = 0;
    let accumulatedDamage = 0;
    let minHealth: number | null = null;
    let foodGained = 0;
    let foodSourcesUsed = 0;
    let recoveryAttempts = 0;
    let successfulRecoveries = 0;
    let stuckActions = 0;
    let oscillations = 0;
    let targetStalls = 0;
    let explorationLegs = 0;
    let explorationCellsRevealed = 0;
    let restMs = 0;
    let verifiedActions = 0;
    let unverifiedConfirmations = 0;
    let unsafeActions = 0;
    let planRevisions = 0;
    let maxPlanLength = 0;
    let knownResourceBlocksPeak = 0;
    let lastPlanSignature = "";
    let explorationLegsUsed = 0;
    let restMsUsed = 0;
    let previousGoalKey: string | null = null;
    let stuck: MinecraftDecisionContext["stuck"] = null;
    let awaitingRecovery = false;
    const itemsGained = new Map<string, number>();
    const resourcesConsumed = new Map<string, number>();
    let lastFailureCode: string | null = null;
    let status: TaskStatus = "failed";
    let failure: MinecraftTaskResult["failure"] = null;
    let origin: { x: number; z: number } | null = null;
    let initialFood: number | null = null;

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
      initialTargetCount = task.kind === "secure_food" ? 0 : countItem(firstState, target.item);
      maximumTargetCount = initialTargetCount;
      minHealth = firstState.player.health;
      initialFood = firstState.player.food;
      origin = { x: firstState.player.position.x, z: firstState.player.position.z };

      while (true) {
        if (this.clock() >= deadline) {
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
        memory.observe(world.state, world.sequence);
        knownResourceBlocksPeak = Math.max(knownResourceBlocksPeak, memory.blockSightings().length);

        const context: MinecraftDecisionContext = {
          excludedTargets,
          previousFailureCode: lastFailureCode,
          memory,
          origin: origin ?? { x: world.state.player.position.x, z: world.state.player.position.z },
          availableSkills: new Set(this.skills.list().map((skill) => skill.id)),
          explorationLegsUsed,
          restMsUsed,
          previousGoalKey,
          stuck,
        };
        stuck = null;
        const decision: MinecraftDecisionRecord = this.decisionModel.decide(world.state, task, context, world.sequence);
        decisions += 1;

        const planSignature = JSON.stringify(decision.plan);
        if (planSignature !== lastPlanSignature) {
          if (lastPlanSignature !== "") planRevisions += 1;
          lastPlanSignature = planSignature;
          maxPlanLength = Math.max(maxPlanLength, decision.plan.length);
        }

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
          failure = { code: "NO_FEASIBLE_GOAL", message: decision.summary };
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
        const timeoutBudget = Math.max(1, deadline - this.clock());
        const defaultTimeout = skill.defaultTimeoutMs ?? capability?.defaultTimeoutMs ?? timeoutBudget;
        const timeoutMs = Math.max(1, Math.min(defaultTimeout, timeoutBudget));

        const before = this.runtime.currentWorldState;
        if (before && threatAtActionStart(before.state, skill.id, selected.input, task.dangerRadius)) {
          unsafeActions += 1;
        }
        const exploredBefore = memory.exploredCellCount;

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

        const after = skillResult.observationAfter ?? this.runtime.currentWorldState;
        if (after) memory.observe(after.state, after.sequence);
        const cellsRevealed = Math.max(0, memory.exploredCellCount - exploredBefore);
        const verification = skillResult.action.confirmed && before && after
          ? verifySkillPostcondition(skill.id, selected.input, before.state, after.state)
          : { verified: null, evidence: "Action was not confirmed by the adapter; no postcondition check was needed." };
        const confirmedButUnverified =
          skillResult.action.status === "succeeded" && skillResult.action.confirmed && verification.verified === false;
        if (confirmedButUnverified) unverifiedConfirmations += 1;
        if (skillResult.action.confirmed && verification.verified === true) verifiedActions += 1;

        const summary = actionSummary(
          selected.goalId,
          selected.targetKey,
          skill.id,
          selected.priorityBand,
          verification,
          skillResult,
          confirmedButUnverified,
        );
        actions.push(summary);
        await this.runtime.trace.record({
          eventType: "task.action",
          gameId: this.runtime.adapter.gameId,
          sessionId: skillResult.action.sessionId,
          correlationId: skillResult.action.actionId,
          data: {
            taskId: task.id,
            decision,
            action: skillResult.action,
            verification,
            observationBeforeSequence: before?.sequence ?? null,
            observationAfterSequence: after?.sequence ?? null,
          },
        });

        const beforeCount = before ? countItem(before.state, target.item) : 0;
        const afterCount = after ? countItem(after.state, target.item) : beforeCount;
        let observedProgress = task.kind !== "secure_food" && afterCount > beforeCount;
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
        if (after && after.state.player.health !== null) {
          minHealth = minHealth === null ? after.state.player.health : Math.min(minHealth, after.state.player.health);
        }
        if (observedProgress) progressEvents += 1;

        if (selected.goalId.startsWith("explore:")) {
          explorationLegs += 1;
          explorationLegsUsed += 1;
          explorationCellsRevealed += cellsRevealed;
        }
        if (skill.id === "minecraft.rest") {
          restMs += skillResult.action.durationMs;
          restMsUsed += skillResult.action.durationMs;
        }
        if (
          skillResult.action.status === "succeeded" &&
          skillResult.action.confirmed &&
          !confirmedButUnverified &&
          (skill.id === "minecraft.pickup-item" || skill.id === "minecraft.harvest-berries")
        ) {
          foodSourcesUsed += 1;
        }

        if (awaitingRecovery) {
          recoveryAttempts += 1;
          if (skillResult.action.status === "succeeded" && skillResult.action.confirmed && !confirmedButUnverified) {
            successfulRecoveries += 1;
          }
          awaitingRecovery = false;
        }

        const succeeded = skillResult.action.status === "succeeded" && skillResult.action.confirmed && !confirmedButUnverified;
        const failureCode = succeeded
          ? null
          : confirmedButUnverified
            ? "UNVERIFIED_POSTCONDITION"
            : skillResult.action.failure?.code ?? skillResult.action.status;
        if (succeeded) {
          successfulActions += 1;
          consecutiveFailures = 0;
          lastFailureCode = null;
        } else {
          failedActions += 1;
          consecutiveFailures += 1;
          lastFailureCode = failureCode;
          awaitingRecovery = true;
        }
        this.invalidateMemoryAfterFailure(memory, selected.targetKey, lastFailureCode, succeeded);

        // A route stall is usually a segment problem: keep the goal, request a sidestep, and retry.
        // Other failures exclude the target at once. Either way repeated attempts are bounded.
        const anchor = this.stuckAnchor(after?.state ?? before?.state ?? null);
        const routeStall = !succeeded && failureCode !== null && ROUTE_STALL_CODES.has(failureCode);
        if (routeStall) stuckActions += 1;
        // Safety moves (flee, sidestep) never retry the same destination; they pick another one.
        const retryableRoute = routeStall && selected.priorityBand !== BAND_SAFETY;
        if (selected.targetKey && !succeeded && !retryableRoute) excludedTargets.add(selected.targetKey);
        if (retryableRoute) {
          stuck = { reason: failureCode ?? "route stall", at: anchor, toward: this.targetPoint(selected.input) };
        }
        if (selected.targetKey && !succeeded) {
          const attempts = (attemptsWithoutProgress.get(selected.targetKey) ?? 0) + 1;
          attemptsWithoutProgress.set(selected.targetKey, attempts);
          if (attempts >= MAX_ATTEMPTS_WITHOUT_PROGRESS) {
            excludedTargets.add(selected.targetKey);
            targetStalls += 1;
            stuck = null;
          }
        }
        if (selected.targetKey && succeeded && !observedProgress) {
          const attempts = (attemptsWithoutProgress.get(selected.targetKey) ?? 0) + 1;
          attemptsWithoutProgress.set(selected.targetKey, attempts);
          if (attempts >= MAX_ATTEMPTS_WITHOUT_PROGRESS) {
            excludedTargets.add(selected.targetKey);
            targetStalls += 1;
            stuck = { reason: `repeated attempts at ${selected.targetKey} without observed progress`, at: anchor, toward: this.targetPoint(selected.input) };
            stuckActions += 1;
          }
        }

        if (MOVEMENT_SKILLS.has(skill.id) && after) {
          movementHistory.push({ x: after.state.player.position.x, z: after.state.player.position.z });
          if (movementHistory.length > OSCILLATION_WINDOW) movementHistory.shift();
          const window = movementHistory.slice(-OSCILLATION_WINDOW);
          if (
            window.length === OSCILLATION_WINDOW &&
            !observedProgress &&
            maxPairwiseDistance(window) <= OSCILLATION_RADIUS
          ) {
            oscillations += 1;
            stuckActions += 1;
            const at = {
              x: window.reduce((sum, point) => sum + point.x, 0) / window.length,
              z: window.reduce((sum, point) => sum + point.z, 0) / window.length,
            };
            stuck = { reason: "oscillation between nearby cells", at, toward: null };
            movementHistory.length = 0;
          }
        }

        previousGoalKey = selected.targetKey;

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
        if (sameWorldState(before, after)) consecutiveNoProgress += 1;
        else consecutiveNoProgress = 0;
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
    const finalTargetCount = finalObservation && task.kind !== "secure_food"
      ? countItem(finalObservation.state, target.item)
      : initialTargetCount;
    maximumTargetCount = Math.max(maximumTargetCount, finalTargetCount);
    if (status === "failed" && task.kind !== "secure_food" && finalTargetCount >= target.count) {
      // A final inventory delta is stronger evidence than a late planner/trace error.
      status = "succeeded";
      failure = null;
    }
    const targetItemsGained = task.kind === "secure_food" ? 0 : Math.max(0, maximumTargetCount - initialTargetCount);
    const metrics: TaskMetrics = {
      taskSucceeded: status === "succeeded",
      targetItem: target.item,
      targetCount: target.count,
      targetItemsGained,
      progressRatio: task.kind === "secure_food"
        ? Math.min(1, Math.max(0, (finalObservation?.state.player.food ?? initialFood ?? 0) / Math.max(1, task.targetHunger)))
        : Math.min(1, Math.max(0, maximumTargetCount / Math.max(1, target.count))),
      decisions,
      actions: actions.length,
      replans: Math.max(0, decisions - 1),
      successfulActions,
      failedActions,
      progressEvents,
      recoveryAttempts,
      successfulRecoveries,
      stuckActions,
      oscillations,
      targetStalls,
      itemsGained: Object.fromEntries(itemsGained),
      resourcesConsumed: Object.fromEntries(resourcesConsumed),
      foodGained,
      foodSourcesUsed,
      resourceCollected: task.kind === "gather_resource" ? targetItemsGained : 0,
      damageTaken: accumulatedDamage,
      minHealth,
      explorationLegs,
      explorationCellsRevealed,
      restMs,
      verifiedActions,
      unverifiedConfirmations,
      unsafeActions,
      planRevisions,
      maxPlanLength,
      knownResourceBlocksPeak,
      elapsedMs: this.clock() - startedClock,
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

  /** Where a stuck decision should step away from. */
  private stuckAnchor(state: MinecraftObservation | null): { x: number; z: number } {
    return state ? { x: state.player.position.x, z: state.player.position.z } : { x: 0, z: 0 };
  }

  private targetPoint(input: unknown): { x: number; z: number } | null {
    if (typeof input !== "object" || input === null) return null;
    const record = input as Record<string, unknown>;
    if (typeof record.x !== "number" || typeof record.z !== "number") return null;
    return { x: record.x + 0.5, z: record.z + 0.5 };
  }

  /** A resource that was just proven missing, or a target that changed, must not be remembered. */
  private invalidateMemoryAfterFailure(
    memory: WorldMemory,
    targetKey: string | null,
    failureCode: string | null,
    succeeded: boolean,
  ): void {
    if (succeeded || !targetKey || !failureCode) return;
    if (failureCode === "RESOURCE_TARGET_CHANGED" || failureCode === "CRAFTING_TABLE_CHANGED" || failureCode === "BERRY_NOT_RIPE") {
      const key = targetKey.replace(/^(berry|craft-table):/, "");
      memory.forgetBlock(key);
    }
    if (failureCode === "ITEM_DROP_NOT_FOUND" && targetKey.startsWith("item:")) {
      memory.forgetItem(targetKey.slice("item:".length));
    }
  }
}
