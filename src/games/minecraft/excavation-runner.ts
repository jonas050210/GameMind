import type { Logger } from "pino";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import type { ActionResult, WorldState } from "../../core/types.js";
import { verifySkillPostcondition } from "./skill-contracts.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { minecraftLogNames } from "./capabilities.js";
import { minecraftMineableBlockNames } from "./mining.js";
import type { MinecraftObservation } from "./observation.js";
import type { ExcavateVolumeTask } from "./task.js";
import type { MinecraftTaskResult, TaskActionSummary, TaskMetrics, TaskStatus } from "./task-runner.js";
import type { RuntimeMetrics } from "./runtime-metrics.js";

const MAX_APPROACH_ATTEMPTS = 4;
const REQUIRED_HEALTH = 8;
const REQUIRED_FOOD = 6;

interface RunOptions {
  readonly shouldStop?: () => string | null;
  readonly onAction?: (action: TaskActionSummary) => void;
  readonly metrics?: RuntimeMetrics;
  readonly clock?: () => number;
}

interface ExecutionRecord {
  readonly execution: Awaited<ReturnType<SkillRuntime<MinecraftObservation>["run"]>>;
  readonly verified: boolean | null;
  readonly evidence: string;
}

interface ExcavationBounds {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly zMin: number;
  readonly zMax: number;
}

function blockKey(position: { readonly x: number; readonly y: number; readonly z: number }): string {
  return `${position.x},${position.y},${position.z}`;
}

function playerOverlapsFootprint(
  position: { readonly x: number; readonly z: number },
  bounds: ExcavationBounds,
): boolean {
  // Leave a half-block body-width margin; checking only floor(position) lets the player straddle an edge.
  const halfWidth = 0.4;
  const outsideX = position.x + halfWidth < bounds.xMin || position.x - halfWidth > bounds.xMax + 1;
  const outsideZ = position.z + halfWidth < bounds.zMin || position.z - halfWidth > bounds.zMax + 1;
  return !outsideX && !outsideZ;
}

function maximumDistanceToCuboidCorner(
  state: MinecraftObservation,
  bounds: ExcavationBounds,
): number {
  const position = state.player.position;
  let maximum = 0;
  for (const x of [bounds.xMin, bounds.xMax]) {
    for (const y of [bounds.yMin, bounds.yMax]) {
      for (const z of [bounds.zMin, bounds.zMax]) {
        maximum = Math.max(maximum, Math.hypot(x + 0.5 - position.x, y + 0.5 - position.y, z + 0.5 - position.z));
      }
    }
  }
  return maximum;
}

function playerIsAlive(state: MinecraftObservation): boolean {
  return state.player.alive === true;
}

interface ExcavationSafetyFailure {
  readonly status: "blocked" | "aborted";
  readonly failure: { readonly code: string; readonly message: string };
}

/** Revalidate every world-dependent precondition at the destructive action boundary. */
function excavationSafetyFailure(
  state: MinecraftObservation,
  bounds: ExcavationBounds,
  dangerRadius: number,
  initialHealth: number | null,
): ExcavationSafetyFailure | null {
  const player = state.player;
  if (player.alive !== true) {
    return {
      status: player.alive === false ? "aborted" : "blocked",
      failure: {
        code: player.alive === false ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
        message: "The player's living state is not confirmed; excavation stopped before mining.",
      },
    };
  }
  if (player.dimension !== "overworld" || (player.gameMode !== "survival" && player.gameMode !== "hardcore")) {
    return {
      status: "blocked",
      failure: { code: "EXCAVATION_SESSION_UNSAFE", message: "The confirmed overworld survival session changed; excavation stopped before mining." },
    };
  }
  if (playerOverlapsFootprint(player.position, bounds)) {
    return {
      status: "blocked",
      failure: { code: "PLAYER_OVER_EXCAVATION", message: "The player entered the excavation footprint; no destructive action was started." },
    };
  }
  if (player.health === null || player.health < REQUIRED_HEALTH || player.food === null || player.food < REQUIRED_FOOD) {
    return {
      status: "blocked",
      failure: { code: "EXCAVATION_VITALS_FLOOR", message: "Health or hunger is unknown or below the excavation safety floor; no destructive action was started." },
    };
  }
  if (initialHealth !== null && player.health <= initialHealth - 6) {
    return {
      status: "blocked",
      failure: { code: "EXCAVATION_HEALTH_FLOOR", message: "Health dropped by six points or below the safe floor; no destructive action was started." },
    };
  }
  if (player.onGround !== true || player.inWater === true || player.headInWater === true) {
    return {
      status: "blocked",
      failure: { code: "EXCAVATION_UNSAFE_POSITION", message: "The player is airborne or in water; no destructive action was started." },
    };
  }
  if (state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= dangerRadius)) {
    return {
      status: "blocked",
      failure: { code: "EXCAVATION_THREAT_NEARBY", message: "A visible hostile is within the excavation safety radius; no destructive action was started." },
    };
  }
  return null;
}

function isAir(name: string): boolean {
  return name === "air" || name.endsWith("_air");
}

function emptyMetrics(input: {
  readonly succeeded: boolean;
  readonly targetCount: number;
  readonly completedCells: number;
  readonly minedBlocks: number;
  readonly actions: number;
  readonly decisions: number;
  readonly successfulActions: number;
  readonly failedActions: number;
  readonly verifiedActions: number;
  readonly unverified: number;
  readonly safetyDenials: number;
  readonly explored: number;
  readonly damageTaken: number;
  readonly minHealth: number | null;
  readonly elapsedMs: number;
  readonly gained: Readonly<Record<string, number>>;
}): TaskMetrics {
  const progressRatio = input.targetCount === 0 ? 1 : Math.min(1, input.completedCells / input.targetCount);
  return {
    taskSucceeded: input.succeeded,
    targetItem: "minecraft:excavated_blocks",
    targetCount: input.targetCount,
    targetItemsGained: input.minedBlocks,
    progressRatio,
    decisions: input.decisions,
    actions: input.actions,
    replans: 0,
    successfulActions: input.successfulActions,
    failedActions: input.failedActions,
    progressEvents: input.minedBlocks,
    recoveryAttempts: 0,
    successfulRecoveries: 0,
    stuckActions: 0,
    oscillations: 0,
    targetStalls: 0,
    itemsGained: input.gained,
    resourcesConsumed: {},
    foodGained: 0,
    foodSourcesUsed: 0,
    resourceCollected: 0,
    damageTaken: input.damageTaken,
    minHealth: input.minHealth,
    explorationLegs: input.explored,
    explorationCellsRevealed: 0,
    restMs: 0,
    verifiedActions: input.verifiedActions,
    unverifiedConfirmations: input.unverified,
    unsafeActions: 0,
    planRevisions: 0,
    maxPlanLength: input.targetCount,
    knownResourceBlocksPeak: 0,
    elapsedMs: input.elapsedMs,
    safetyDenials: input.safetyDenials,
    rejectedAlternatives: 0,
    wastedActions: 0,
    explorations: 0,
    minedBlocks: input.minedBlocks,
    shelterSidesClosed: 0,
    combatActions: 0,
    hungerRecoveryActions: 0,
    deathsObserved: 0,
    respawnRecoveries: 0,
    reflexInterrupts: 0,
  };
}

/** Deterministic, fail-closed executor for explicitly approved cuboid excavation tasks. */
export class MinecraftExcavationRunner {
  constructor(
    private readonly runtime: GameMindRuntime<MinecraftObservation>,
    private readonly skills: SkillRuntime<MinecraftObservation>,
    private readonly logger: Logger,
    private readonly options: RunOptions = {},
  ) {}

  async run(task: ExcavateVolumeTask): Promise<MinecraftTaskResult> {
    const clock = this.options.clock ?? (() => Date.now());
    const startedAtMs = clock();
    const deadline = startedAtMs + task.maxDurationMs;
    const totalCells = task.width * task.height * task.depth;
    const actions: TaskActionSummary[] = [];
    const gained = new Map<string, number>();
    let completedCells = 0;
    let minedBlocks = 0;
    let successfulActions = 0;
    let failedActions = 0;
    let verifiedActions = 0;
    let unverified = 0;
    let safetyDenials = 0;
    let explorationLegs = 0;
    let accumulatedDamage = 0;
    let minHealth: number | null = null;
    let initialHealth: number | null = null;
    let decisions = 0;
    let status: TaskStatus = "failed";
    let failure: MinecraftTaskResult["failure"] = null;
    let calls = 0;

    const finish = async (): Promise<MinecraftTaskResult> => {
      const finalObservation = this.runtime.currentWorldState;
      const metrics = emptyMetrics({
        succeeded: status === "succeeded",
        targetCount: totalCells,
        completedCells,
        minedBlocks,
        actions: actions.length,
        decisions,
        successfulActions,
        failedActions,
        verifiedActions,
        unverified,
        safetyDenials,
        explored: explorationLegs,
        damageTaken: accumulatedDamage,
        minHealth,
        elapsedMs: Math.max(0, clock() - startedAtMs),
        gained: Object.fromEntries(gained),
      });
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
        sessionId: this.runtime.session?.id ?? null,
        data: { taskId: task.id, status, failure, metrics, completedAt: new Date().toISOString() },
      });
      return result;
    };

    const record = async (
      skillId: string,
      input: Readonly<Record<string, unknown>>,
      execution: ExecutionRecord["execution"],
      verified: boolean | null,
      evidence: string,
      position: { readonly x: number; readonly y: number; readonly z: number },
    ): Promise<void> => {
      this.options.metrics?.recordActionDuration(execution.action.durationMs);
      const succeeded = execution.action.status === "succeeded" && execution.action.confirmed && verified === true;
      const summary: TaskActionSummary = {
        actionId: execution.action.actionId,
        goalId: "project:excavate-volume",
        skillId,
        status: execution.action.status,
        confirmed: execution.action.confirmed,
        durationMs: execution.action.durationMs,
        failureCode: execution.action.failure?.code ?? (execution.action.confirmed && verified === false ? "UNVERIFIED_POSTCONDITION" : null),
        targetKey: blockKey(position),
        verification: !execution.action.confirmed
          ? "not_applicable"
          : verified === true
            ? "verified"
            : verified === null
              ? "unavailable"
              : "unverified",
        verificationEvidence: evidence,
        band: 2,
      };
      actions.push(summary);
      this.options.onAction?.(summary);
      await this.runtime.trace.record({
        eventType: "task.action",
        gameId: this.runtime.adapter.gameId,
        sessionId: execution.action.sessionId,
        correlationId: execution.action.actionId,
        data: { taskId: task.id, action: execution.action, verification: { verified, evidence }, projectCell: position },
      });
      if (succeeded) {
        successfulActions += 1;
        verifiedActions += 1;
      } else {
        failedActions += 1;
        if (execution.action.confirmed && verified !== true) unverified += 1;
        if (execution.action.failure?.code.startsWith("SAFETY_")) safetyDenials += 1;
      }
      const before = execution.observationBefore?.state;
      const after = execution.observationAfter?.state;
      if (before && after) {
        if (before.player.health !== null && after.player.health !== null) {
          accumulatedDamage += Math.max(0, before.player.health - after.player.health);
        }
        for (const item of after.inventory) {
          const previous = before.inventory.filter((candidate) => candidate.name === item.name).reduce((sum, candidate) => sum + candidate.count, 0);
          const nextTotal = after.inventory.filter((candidate) => candidate.name === item.name).reduce((sum, candidate) => sum + candidate.count, 0);
          if (nextTotal > previous) gained.set(item.name, (gained.get(item.name) ?? 0) + nextTotal - previous);
        }
        if (after.player.health !== null) minHealth = minHealth === null ? after.player.health : Math.min(minHealth, after.player.health);
      }
    };

    await this.runtime.trace.record({
      eventType: "task.started",
      gameId: this.runtime.adapter.gameId,
      sessionId: this.runtime.session?.id ?? null,
      data: {
        task,
        plan: { volume: totalCells, order: "top-down, one column at a time", unknownCells: "stop; never assume empty" },
        startedAt: new Date(startedAtMs).toISOString(),
      },
    });

    try {
      if (this.runtime.adapter.status !== "connected" || !this.runtime.session) await this.runtime.connect();
      this.runtime.safety?.startRun(`${task.id}-${startedAtMs}`);
      let world = await this.runtime.observeIfStale(0);
      if (!world || world.sessionId !== this.runtime.session?.id) {
        status = "disconnected";
        failure = { code: "WORLD_STATE_UNAVAILABLE", message: "Cannot begin excavation without a fresh same-session live observation." };
        return await finish();
      }
      const player = world.state.player;
      if (!playerIsAlive(world.state)) {
        status = player.alive === false ? "aborted" : "blocked";
        failure = {
          code: player.alive === false ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
          message: "A verified living player is required before excavation can begin.",
        };
        return await finish();
      }
      if (player.dimension !== "overworld") {
        status = "blocked";
        failure = { code: "EXCAVATION_REQUIRES_OVERWORLD", message: "Volume excavation is only permitted in a confirmed overworld location." };
        return await finish();
      }
      if (player.gameMode !== "survival" && player.gameMode !== "hardcore") {
        status = "blocked";
        failure = { code: "EXCAVATION_REQUIRES_SURVIVAL", message: `Excavation requires verified survival mode; observed ${player.gameMode ?? "unknown"}.` };
        return await finish();
      }
      if (player.health === null || player.health < REQUIRED_HEALTH || player.food === null || player.food < REQUIRED_FOOD) {
        status = "blocked";
        failure = { code: "EXCAVATION_VITALS_TOO_LOW", message: `Observe at least ${REQUIRED_HEALTH}/20 health and ${REQUIRED_FOOD}/20 hunger before excavation.` };
        return await finish();
      }
      if (!player.onGround || player.inWater === true || player.headInWater === true) {
        status = "blocked";
        failure = { code: "EXCAVATION_UNSAFE_POSITION", message: "The player must be grounded and out of water before the destructive task can begin." };
        return await finish();
      }
      if (world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
        status = "blocked";
        failure = { code: "EXCAVATION_THREAT_NEARBY", message: "A visible hostile is too close to the excavation site; no blocks were removed." };
        return await finish();
      }
      initialHealth = player.health;
      minHealth = player.health;
      const operatorPosition = player.position;
      const xMin = task.origin.x;
      const yMin = task.origin.y;
      const zMin = task.origin.z;
      const xMax = xMin + task.width - 1;
      const yMax = yMin + task.height - 1;
      const zMax = zMin + task.depth - 1;
      const bounds: ExcavationBounds = { xMin, xMax, yMin, yMax, zMin, zMax };
      // Keep the controlled player outside the complete horizontal footprint, not merely outside the
      // excavated Y range: removing the surface layer directly below the player could make it fall.
      const overFootprint = (point: { readonly x: number; readonly y: number; readonly z: number }): boolean =>
        playerOverlapsFootprint(point, bounds);

      if (overFootprint(operatorPosition)) {
        const candidates = [
          { x: xMin - 2, y: Math.floor(operatorPosition.y), z: Math.floor(operatorPosition.z) },
          { x: xMax + 2, y: Math.floor(operatorPosition.y), z: Math.floor(operatorPosition.z) },
          { x: Math.floor(operatorPosition.x), y: Math.floor(operatorPosition.y), z: zMin - 2 },
          { x: Math.floor(operatorPosition.x), y: Math.floor(operatorPosition.y), z: zMax + 2 },
        ].sort((a, b) => Math.hypot(a.x - operatorPosition.x, a.z - operatorPosition.z) - Math.hypot(b.x - operatorPosition.x, b.z - operatorPosition.z));
        let exited = false;
        for (const candidate of candidates.slice(0, MAX_APPROACH_ATTEMPTS)) {
          if (this.options.shouldStop?.()) break;
          if (calls >= task.maxActions) break;
          const movement = await this.skills.run("minecraft.navigate", { ...candidate, range: 1 }, {
            source: "operator-chat:excavate-volume-exit-area",
            timeoutMs: Math.min(20_000, Math.max(1_000, deadline - clock())),
          });
          calls += 1;
          const verification = movement.action.confirmed
            ? verifySkillPostcondition("minecraft.navigate", { ...candidate, range: 1 }, movement.observationBefore?.state ?? null, movement.observationAfter?.state ?? null)
            : { verified: false, evidence: movement.action.failure?.message ?? "The exit path was not confirmed." };
          await record("minecraft.navigate", { ...candidate, range: 1 }, movement, verification.verified, verification.evidence, candidate);
          world = movement.observationAfter ?? this.runtime.currentWorldState;
          if (movement.action.status === "succeeded" && movement.action.confirmed && verification.verified === true && world && !overFootprint(world.state.player.position)) {
            exited = true;
            explorationLegs += 1;
            break;
          }
        }
        if (!exited) {
          status = this.options.shouldStop?.() ? "aborted" : calls >= task.maxActions ? "max_actions" : "blocked";
          failure = {
            code: status === "aborted" ? "OPERATOR_STOP" : "EXCAVATION_NO_SAFE_EXIT",
            message: "The player could not reach a confirmed safe position outside the requested volume; no blocks were removed.",
          };
          return await finish();
        }
      }

      if (!world) {
        status = "disconnected";
        failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The safe exit did not leave a current observation." };
        return await finish();
      }
      if (maximumDistanceToCuboidCorner(world.state, bounds) > 48) {
        status = "blocked";
        failure = { code: "EXCAVATION_TOO_FAR", message: "At least one corner of the requested volume is outside the 48-block safe navigation range." };
        return await finish();
      }

      // Work top-down, column by column. Unsupported, unknown, unstable, or dangerous cells abort the plan.
      const cells: Array<{ x: number; y: number; z: number }> = [];
      for (let z = zMin; z <= zMax; z += 1) {
        for (let x = xMin; x <= xMax; x += 1) {
          for (let y = yMax; y >= yMin; y -= 1) cells.push({ x, y, z });
        }
      }

      for (const cell of cells) {
        if (clock() >= deadline) {
          status = "timed_out";
          failure = { code: "TASK_DEADLINE", message: "Excavation exceeded its overall time budget." };
          break;
        }
        const stop = this.options.shouldStop?.();
        if (stop) {
          status = "aborted";
          failure = { code: "OPERATOR_STOP", message: stop };
          break;
        }
        if (calls >= task.maxActions) {
          status = "max_actions";
          failure = { code: "MAX_ACTIONS", message: `Excavation reached its action limit (${task.maxActions}) after clearing ${completedCells}/${totalCells} cells.` };
          break;
        }
        world = await this.runtime.observeIfStale(0);
        if (!world || world.sessionId !== this.runtime.session?.id) {
          status = "disconnected";
          failure = { code: "WORLD_STATE_UNAVAILABLE", message: "A fresh same-session observation was unavailable; excavation stopped." };
          break;
        }
        if (!playerIsAlive(world.state)) {
          status = world.state.player.alive === false ? "aborted" : "blocked";
          failure = {
            code: world.state.player.alive === false ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
            message: "The player's living state is no longer confirmed; excavation stopped.",
          };
          break;
        }
        if (world.state.player.dimension !== "overworld" || (world.state.player.gameMode !== "survival" && world.state.player.gameMode !== "hardcore")) {
          status = "blocked";
          failure = { code: "EXCAVATION_SESSION_UNSAFE", message: "The confirmed overworld survival session changed; excavation stopped." };
          break;
        }
        if (overFootprint(world.state.player.position)) {
          status = "blocked";
          failure = { code: "PLAYER_OVER_EXCAVATION", message: "The player entered the excavation footprint; further digging stopped to prevent a fall." };
          break;
        }
        if (world.state.player.health === null || world.state.player.health < REQUIRED_HEALTH || world.state.player.food === null || world.state.player.food < REQUIRED_FOOD) {
          status = "blocked";
          failure = { code: "EXCAVATION_VITALS_FLOOR", message: "Health or hunger is unknown or below the excavation safety floor; further digging stopped." };
          break;
        }
        minHealth = minHealth === null ? world.state.player.health : Math.min(minHealth, world.state.player.health);
        if (initialHealth !== null && world.state.player.health <= initialHealth - 6) {
          status = "blocked";
          failure = { code: "EXCAVATION_HEALTH_FLOOR", message: "Health dropped by six points or below the safe floor; the destructive task stopped." };
          break;
        }
        if (world.state.player.inWater === true || world.state.player.headInWater === true) {
          status = "blocked";
          failure = { code: "EXCAVATION_UNSAFE_POSITION", message: "The player entered water; excavation stopped." };
          break;
        }
        if (world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
          status = "blocked";
          failure = { code: "EXCAVATION_THREAT_NEARBY", message: "A visible hostile entered the excavation radius; digging stopped." };
          break;
        }

        decisions += 1;
        let safelyApproached = false;
        let inspection = await this.inspectCell(cell, world, deadline, clock, calls, record);
        calls = inspection.calls;
        if (!inspection.ok && ["BLOCK_OUT_OF_RANGE", "BLOCK_UNKNOWN"].includes(inspection.failureCode ?? "")) {
          const moved = await this.approachCell(
            cell,
            world,
            bounds,
            task.dangerRadius,
            initialHealth,
            task.maxActions,
            deadline,
            clock,
            calls,
            record,
          );
          calls = moved.calls;
          if (!moved.ok) {
            status = moved.failureCode === "OPERATOR_STOP" || moved.failureCode === "PLAYER_DEAD"
              ? "aborted"
              : moved.failureCode === "TASK_DEADLINE"
                ? "timed_out"
                : moved.failureCode === "MAX_ACTIONS"
                  ? "max_actions"
                  : moved.failureCode === "WORLD_STATE_UNAVAILABLE"
                    ? "disconnected"
                    : "blocked";
            failure = { code: moved.failureCode ?? "EXCAVATION_PATH_BLOCKED", message: moved.message ?? `Could not safely approach block ${blockKey(cell)}.` };
            break;
          }
          world = moved.world;
          safelyApproached = true;
          if (overFootprint(world.state.player.position)) {
            status = "blocked";
            failure = { code: "PLAYER_OVER_EXCAVATION", message: "A navigation goal placed the player over the excavation footprint; digging stopped before removing another block." };
            break;
          }
          if (calls >= task.maxActions) {
            status = "max_actions";
            failure = { code: "MAX_ACTIONS", message: "Excavation reached its action limit before the approached cell could be rechecked." };
            break;
          }
          inspection = await this.inspectCell(cell, world, deadline, clock, calls, record);
          calls = inspection.calls;
        }
        if (!inspection.ok) {
          status = inspection.failureCode === "OPERATOR_STOP" ? "aborted" : inspection.failureCode === "TASK_DEADLINE" ? "timed_out" : "blocked";
          failure = { code: inspection.failureCode ?? "BLOCK_UNKNOWN", message: inspection.message ?? `Could not confirm block ${blockKey(cell)}.` };
          break;
        }
        const name = inspection.blockName!;
        if (isAir(name)) {
          completedCells += 1;
          continue;
        }
        if (name === "sand" || name === "gravel" || name === "suspicious_sand" || name === "suspicious_gravel") {
          status = "blocked";
          failure = { code: "EXCAVATION_UNSTABLE_BLOCK", message: `Stopped at ${name} at ${blockKey(cell)} because falling blocks can change the planned volume and endanger the player.` };
          break;
        }
        const mineable = (minecraftMineableBlockNames as readonly string[]).includes(name);
        const log = (minecraftLogNames as readonly string[]).includes(name);
        if (!mineable && !log) {
          status = "blocked";
          failure = { code: "EXCAVATION_UNSUPPORTED_BLOCK", message: `Stopped at unsupported block '${name}' at ${blockKey(cell)}; unknown block types are never dug by guess.` };
          break;
        }

        // The collect/mine adapter may path toward a target more than four blocks away. That path must
        // not take the player through the excavation footprint, so make at most one safe-perimeter
        // approach here and refuse the dig if it still cannot be reached from outside.
        const distanceToCell = (position: MinecraftObservation["player"]["position"]): number =>
          Math.hypot(cell.x - position.x, cell.y - position.y, cell.z - position.z);
        if (distanceToCell(world.state.player.position) > 4 && !safelyApproached) {
          const moved = await this.approachCell(
            cell,
            world,
            bounds,
            task.dangerRadius,
            initialHealth,
            task.maxActions,
            deadline,
            clock,
            calls,
            record,
          );
          calls = moved.calls;
          if (!moved.ok) {
            status = moved.failureCode === "OPERATOR_STOP" || moved.failureCode === "PLAYER_DEAD"
              ? "aborted"
              : moved.failureCode === "TASK_DEADLINE"
                ? "timed_out"
                : moved.failureCode === "MAX_ACTIONS"
                  ? "max_actions"
                  : moved.failureCode === "WORLD_STATE_UNAVAILABLE"
                    ? "disconnected"
                    : "blocked";
            failure = { code: moved.failureCode ?? "EXCAVATION_PATH_BLOCKED", message: moved.message ?? `Could not safely approach block ${blockKey(cell)}.` };
            break;
          }
          world = moved.world;
          safelyApproached = true;
          if (overFootprint(world.state.player.position)) {
            status = "blocked";
            failure = { code: "PLAYER_OVER_EXCAVATION", message: "A navigation goal placed the player over the excavation footprint; digging stopped before removing another block." };
            break;
          }
          if (calls >= task.maxActions) {
            status = "max_actions";
            failure = { code: "MAX_ACTIONS", message: "Excavation reached its action limit before the approached cell could be rechecked." };
            break;
          }
          const refreshedInspection = await this.inspectCell(cell, world, deadline, clock, calls, record);
          calls = refreshedInspection.calls;
          if (!refreshedInspection.ok) {
            status = refreshedInspection.failureCode === "OPERATOR_STOP" ? "aborted" : refreshedInspection.failureCode === "TASK_DEADLINE" ? "timed_out" : "blocked";
            failure = { code: refreshedInspection.failureCode ?? "BLOCK_UNKNOWN", message: refreshedInspection.message ?? `Could not confirm block ${blockKey(cell)} after the safe approach.` };
            break;
          }
          if (isAir(refreshedInspection.blockName!)) {
            completedCells += 1;
            continue;
          }
          if (refreshedInspection.blockName !== name) {
            status = "blocked";
            failure = { code: "RESOURCE_TARGET_CHANGED", message: `The block at ${blockKey(cell)} changed during the safe approach; no dig was started.` };
            break;
          }
        }
        if (distanceToCell(world.state.player.position) > 4) {
          status = "blocked";
          failure = { code: "EXCAVATION_NO_SAFE_APPROACH", message: `Block ${blockKey(cell)} is out of reach from every confirmed position outside the excavation footprint; no dig was started.` };
          break;
        }
        if (calls >= task.maxActions) {
          status = "max_actions";
          failure = { code: "MAX_ACTIONS", message: `Excavation reached its action limit (${task.maxActions}) before mining ${blockKey(cell)}.` };
          break;
        }
        const skillId = log ? "minecraft.collect-log" : "minecraft.mine-block";
        const input = { ...cell, blockName: name, dangerRadius: task.dangerRadius };
        const stopBeforeMining = this.options.shouldStop?.();
        if (stopBeforeMining) {
          status = "aborted";
          failure = { code: "OPERATOR_STOP", message: stopBeforeMining };
          break;
        }
        if (clock() >= deadline) {
          status = "timed_out";
          failure = { code: "TASK_DEADLINE", message: "Excavation deadline expired before mining the inspected cell." };
          break;
        }

        // Inspection can take time and the player can move, take damage, or change sessions meanwhile. Refresh
        // and validate the exact live session and the complete safety envelope at the irreversible boundary.
        let destructiveWorld: WorldState<MinecraftObservation> | null = null;
        try {
          destructiveWorld = await this.runtime.observeIfStale(0);
        } catch (error) {
          this.logger.warn({ err: error, taskId: task.id }, "Fresh pre-mining excavation observation failed");
        }
        const activeSessionId = this.runtime.session?.id;
        if (!destructiveWorld || !activeSessionId || destructiveWorld.sessionId !== activeSessionId) {
          status = "disconnected";
          failure = { code: "WORLD_STATE_UNAVAILABLE", message: "A fresh same-session observation was unavailable at the destructive mining boundary; no block was changed." };
          break;
        }
        const stopAfterObservation = this.options.shouldStop?.();
        if (stopAfterObservation) {
          status = "aborted";
          failure = { code: "OPERATOR_STOP", message: stopAfterObservation };
          break;
        }
        if (clock() >= deadline) {
          status = "timed_out";
          failure = { code: "TASK_DEADLINE", message: "Excavation deadline expired before mining the inspected cell." };
          break;
        }
        if (calls >= task.maxActions) {
          status = "max_actions";
          failure = { code: "MAX_ACTIONS", message: `Excavation reached its action limit (${task.maxActions}) before mining ${blockKey(cell)}.` };
          break;
        }
        const safetyFailure = excavationSafetyFailure(destructiveWorld.state, bounds, task.dangerRadius, initialHealth);
        if (safetyFailure) {
          status = safetyFailure.status;
          failure = safetyFailure.failure;
          break;
        }
        world = destructiveWorld;
        minHealth = minHealth === null ? destructiveWorld.state.player.health : Math.min(minHealth, destructiveWorld.state.player.health!);
        const beforeWorld = destructiveWorld;
        const execution = await this.skills.run(skillId, input, {
          source: "operator-chat:confirmed-excavate-volume",
          timeoutMs: Math.min(log ? 30_000 : 10_000, Math.max(1_000, deadline - clock())),
        });
        calls += 1;
        const afterWorld = execution.observationAfter ?? this.runtime.currentWorldState;
        const verification = execution.action.confirmed
          ? verifySkillPostcondition(skillId, input, execution.observationBefore?.state ?? beforeWorld?.state ?? null, afterWorld?.state ?? null)
          : { verified: false, evidence: execution.action.failure?.message ?? "The adapter did not confirm the dig." };
        await record(skillId, input, execution, verification.verified, verification.evidence, cell);
        if (execution.action.status !== "succeeded" || !execution.action.confirmed || verification.verified !== true) {
          status = execution.action.failure?.code?.startsWith("SAFETY_") ? "blocked" : execution.action.status === "timed_out" ? "timed_out" : "failed";
          failure = {
            code: execution.action.failure?.code ?? (verification.verified === false ? "UNVERIFIED_POSTCONDITION" : "DIG_NOT_CONFIRMED"),
            message: execution.action.failure?.message ?? verification.evidence,
          };
          break;
        }
        minedBlocks += 1;
        completedCells += 1;
      }

      if (failure === null && completedCells === totalCells) status = "succeeded";
      else if (failure === null) {
        status = "failed";
        failure = { code: "EXCAVATION_INCOMPLETE", message: `Excavation ended after ${completedCells}/${totalCells} cells without a completion proof.` };
      }
      return await finish();
    } catch (error) {
      this.logger.error({ err: error, taskId: task.id }, "Volume excavation runner failed");
      status = this.runtime.adapter.status === "connected" ? "failed" : "disconnected";
      failure = {
        code: "EXCAVATION_RUNTIME_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
      return await finish();
    }
  }

  private async inspectCell(
    cell: { readonly x: number; readonly y: number; readonly z: number },
    world: WorldState<MinecraftObservation>,
    deadline: number,
    clock: () => number,
    callsBefore: number,
    record: (
      skillId: string,
      input: Readonly<Record<string, unknown>>,
      execution: ExecutionRecord["execution"],
      verified: boolean | null,
      evidence: string,
      position: { readonly x: number; readonly y: number; readonly z: number },
    ) => Promise<void>,
  ): Promise<{ readonly ok: boolean; readonly blockName?: string; readonly failureCode?: string; readonly message?: string; readonly calls: number }> {
    if (this.options.shouldStop?.()) return { ok: false, failureCode: "OPERATOR_STOP", message: "Operator stopped excavation.", calls: callsBefore };
    if (clock() >= deadline) return { ok: false, failureCode: "TASK_DEADLINE", message: "Excavation deadline expired while inspecting a cell.", calls: callsBefore };
    try {
      const input = { x: cell.x, y: cell.y, z: cell.z };
      const execution = await this.skills.run("minecraft.inspect-block", input, {
        source: "operator-chat:excavate-volume-inspect",
        timeoutMs: Math.min(5_000, Math.max(1_000, deadline - clock())),
      });
      const verified = execution.action.confirmed && execution.action.status === "succeeded";
      const evidence = typeof execution.action.details?.name === "string"
        ? `Observed '${execution.action.details.name}' at the requested volume cell.`
        : execution.action.failure?.message ?? "The block read was not confirmed.";
      await record("minecraft.inspect-block", input, execution, verified, evidence, cell);
      const calls = callsBefore + 1;
      if (!verified) return { ok: false, failureCode: execution.action.failure?.code ?? "BLOCK_UNKNOWN", message: evidence, calls };
      const name = execution.action.details?.name;
      if (typeof name !== "string") return { ok: false, failureCode: "BLOCK_UNKNOWN", message: "Inspection had no validated block name.", calls };
      return { ok: true, blockName: name, calls };
    } catch (error) {
      return { ok: false, failureCode: "INSPECT_EXCEPTION", message: error instanceof Error ? error.message : String(error), calls: callsBefore };
    }
  }

  private async approachCell(
    cell: { readonly x: number; readonly y: number; readonly z: number },
    world: WorldState<MinecraftObservation>,
    bounds: ExcavationBounds,
    dangerRadius: number,
    initialHealth: number | null,
    maxActions: number,
    deadline: number,
    clock: () => number,
    callsBefore: number,
    record: (
      skillId: string,
      input: Readonly<Record<string, unknown>>,
      execution: ExecutionRecord["execution"],
      verified: boolean | null,
      evidence: string,
      position: { readonly x: number; readonly y: number; readonly z: number },
    ) => Promise<void>,
  ): Promise<{ readonly ok: boolean; readonly world: WorldState<MinecraftObservation>; readonly failureCode?: string; readonly message?: string; readonly calls: number }> {
    if (this.options.shouldStop?.()) return { ok: false, world, failureCode: "OPERATOR_STOP", message: "Operator stopped excavation.", calls: callsBefore };
    if (clock() >= deadline) return { ok: false, world, failureCode: "TASK_DEADLINE", message: "Excavation deadline expired while approaching a cell.", calls: callsBefore };
    if (callsBefore >= maxActions) return { ok: false, world, failureCode: "MAX_ACTIONS", message: "Excavation reached its action limit before a safe approach.", calls: callsBefore };

    const beforeWorld = await this.runtime.observeIfStale(0);
    if (!beforeWorld || beforeWorld.sessionId !== this.runtime.session?.id) {
      return { ok: false, world, failureCode: "WORLD_STATE_UNAVAILABLE", message: "The live world changed before a safe excavation approach.", calls: callsBefore };
    }
    const player = beforeWorld.state.player;
    if (!playerIsAlive(beforeWorld.state)) {
      return { ok: false, world: beforeWorld, failureCode: player.alive === false ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED", message: "Player life is not confirmed before the excavation approach.", calls: callsBefore };
    }
    if (player.dimension !== "overworld" || (player.gameMode !== "survival" && player.gameMode !== "hardcore")) {
      return { ok: false, world: beforeWorld, failureCode: "EXCAVATION_SESSION_UNSAFE", message: "The overworld survival session changed before the excavation approach.", calls: callsBefore };
    }
    if (player.health === null || player.health < REQUIRED_HEALTH || player.food === null || player.food < REQUIRED_FOOD || player.onGround !== true || player.inWater === true || player.headInWater === true) {
      return { ok: false, world: beforeWorld, failureCode: "EXCAVATION_UNSAFE_POSITION", message: "Vitals, grounded state, or water state are unsafe or unknown before the excavation approach.", calls: callsBefore };
    }
    if (initialHealth !== null && player.health <= initialHealth - 6) {
      return { ok: false, world: beforeWorld, failureCode: "EXCAVATION_HEALTH_FLOOR", message: "Health dropped by six points before the excavation approach.", calls: callsBefore };
    }
    if (beforeWorld.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= dangerRadius)) {
      return { ok: false, world: beforeWorld, failureCode: "EXCAVATION_THREAT_NEARBY", message: "A visible hostile is too close to approach the excavation cell.", calls: callsBefore };
    }

    const xzPosition = player.position;
    if (playerOverlapsFootprint(xzPosition, bounds)) {
      return { ok: false, world: beforeWorld, failureCode: "PLAYER_OVER_EXCAVATION", message: "The player is over the excavation footprint; no approach or further digging is allowed.", calls: callsBefore };
    }

    const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));
    const standingY = Math.floor(player.position.y);
    const candidates = [
      ...(bounds.xMin > -30_000_000 ? [{ x: bounds.xMin - 1, y: standingY, z: clamp(cell.z, bounds.zMin, bounds.zMax) }] : []),
      ...(bounds.xMax < 30_000_000 ? [{ x: bounds.xMax + 1, y: standingY, z: clamp(cell.z, bounds.zMin, bounds.zMax) }] : []),
      ...(bounds.zMin > -30_000_000 ? [{ x: clamp(cell.x, bounds.xMin, bounds.xMax), y: standingY, z: bounds.zMin - 1 }] : []),
      ...(bounds.zMax < 30_000_000 ? [{ x: clamp(cell.x, bounds.xMin, bounds.xMax), y: standingY, z: bounds.zMax + 1 }] : []),
    ].sort((left, right) =>
      Math.hypot(left.x + 0.5 - player.position.x, left.z + 0.5 - player.position.z) -
      Math.hypot(right.x + 0.5 - player.position.x, right.z + 0.5 - player.position.z),
    );
    const goal = candidates[0];
    if (!goal) {
      return { ok: false, world: beforeWorld, failureCode: "EXCAVATION_NO_SAFE_APPROACH", message: "No navigable block outside the excavation footprint is available.", calls: callsBefore };
    }

    const approach = { ...goal, range: 1 };
    try {
      const execution = await this.skills.run("minecraft.navigate", approach, {
        source: "operator-chat:excavate-volume-safe-perimeter-approach",
        timeoutMs: Math.min(20_000, Math.max(1_000, deadline - clock())),
      });
      const verified = execution.action.confirmed
        ? verifySkillPostcondition("minecraft.navigate", approach, execution.observationBefore?.state ?? beforeWorld.state, execution.observationAfter?.state ?? beforeWorld.state)
        : { verified: false, evidence: execution.action.failure?.message ?? "Navigation did not confirm the safe perimeter approach." };
      await record("minecraft.navigate", approach, execution, verified.verified, verified.evidence, cell);
      const calls = callsBefore + 1;
      const after = execution.observationAfter ?? this.runtime.currentWorldState;
      if (execution.action.status !== "succeeded" || !execution.action.confirmed || verified.verified !== true || !after) {
        return { ok: false, world: beforeWorld, failureCode: execution.action.failure?.code ?? "EXCAVATION_PATH_BLOCKED", message: verified.evidence, calls };
      }
      if (after.sessionId !== this.runtime.session?.id) {
        return { ok: false, world: after, failureCode: "WORLD_STATE_UNAVAILABLE", message: "The session changed during the safe perimeter approach.", calls };
      }
      const afterPlayer = after.state.player;
      if (playerOverlapsFootprint(afterPlayer.position, bounds)) {
        return { ok: false, world: after, failureCode: "PLAYER_OVER_EXCAVATION", message: "The pathfinder stopped over the excavation footprint; digging was refused.", calls };
      }
      if (afterPlayer.alive !== true || afterPlayer.dimension !== "overworld" || (afterPlayer.gameMode !== "survival" && afterPlayer.gameMode !== "hardcore") || afterPlayer.health === null || afterPlayer.health < REQUIRED_HEALTH || afterPlayer.food === null || afterPlayer.food < REQUIRED_FOOD || afterPlayer.onGround !== true || afterPlayer.inWater === true || afterPlayer.headInWater === true) {
        return { ok: false, world: after, failureCode: "EXCAVATION_UNSAFE_POSITION", message: "The perimeter approach ended with an unsafe or unconfirmed player state; digging was refused.", calls };
      }
      if (initialHealth !== null && afterPlayer.health <= initialHealth - 6) {
        return { ok: false, world: after, failureCode: "EXCAVATION_HEALTH_FLOOR", message: "Health dropped during the safe perimeter approach; digging was refused.", calls };
      }
      if (after.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= dangerRadius)) {
        return { ok: false, world: after, failureCode: "EXCAVATION_THREAT_NEARBY", message: "A hostile entered the danger radius during the perimeter approach; digging was refused.", calls };
      }
      return { ok: true, world: after, calls };
    } catch (error) {
      return { ok: false, world: beforeWorld, failureCode: "EXCAVATION_NAVIGATION_EXCEPTION", message: error instanceof Error ? error.message : String(error), calls: callsBefore };
    }
  }
}
