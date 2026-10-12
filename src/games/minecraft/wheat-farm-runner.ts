import type { Logger } from "pino";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import type { WorldState } from "../../core/types.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { verifySkillPostcondition } from "./skill-contracts.js";
import type { MinecraftObservation } from "./observation.js";
import type { FarmWheatTask } from "./task.js";
import type { MinecraftTaskResult, TaskActionSummary, TaskMetrics, TaskStatus } from "./task-runner.js";
import type { RuntimeMetrics } from "./runtime-metrics.js";

const REQUIRED_HEALTH = 8;
const REQUIRED_FOOD = 6;
const SAFE_FARM_NAVIGATION_LIMIT = 47;
const PLANTING_APPROACH_LIMIT = 20;

interface RunOptions {
  readonly shouldStop?: () => string | null;
  readonly onAction?: (action: TaskActionSummary) => void;
  readonly metrics?: RuntimeMetrics;
  readonly clock?: () => number;
}

interface CropCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface InspectedBlock {
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

function positionKey(position: CropCell): string {
  return `${position.x},${position.y},${position.z}`;
}

function otherEntityAt(state: MinecraftObservation, cell: CropCell): boolean {
  return state.entities.some((entity) => {
    if (entity.type === "player" && entity.name === state.player.username) return false;
    return Math.floor(entity.position.x) === cell.x && Math.floor(entity.position.y) === cell.y && Math.floor(entity.position.z) === cell.z;
  });
}

function distanceToCell(position: { readonly x: number; readonly y: number; readonly z: number }, cell: CropCell): number {
  return Math.hypot(position.x - (cell.x + 0.5), position.y - (cell.y + 0.5), position.z - (cell.z + 0.5));
}

function hostileNearCell(state: MinecraftObservation, cell: CropCell, radius: number): boolean {
  return state.entities.some((entity) =>
    isHostileMinecraftEntity(entity.name, entity.type) && distanceToCell(entity.position, cell) <= radius,
  );
}

type FarmSafetyFailure = {
  readonly status: "blocked" | "aborted";
  readonly failure: { readonly code: string; readonly message: string };
};

function farmSafetyFailure(
  state: MinecraftObservation,
  cell: CropCell,
  dangerRadius: number,
  initialHealth: number | null,
): FarmSafetyFailure | null {
  const player = state.player;
  if (player.alive !== true) {
    return {
      status: player.alive === false ? "aborted" : "blocked",
      failure: {
        code: player.alive === false ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
        message: "The player's living state is not confirmed; wheat farming stopped.",
      },
    };
  }
  if (player.dimension !== "overworld") {
    return { status: "blocked", failure: { code: "FARM_REQUIRES_OVERWORLD", message: "The wheat plot must remain in the confirmed overworld." } };
  }
  if (player.gameMode !== "survival" && player.gameMode !== "hardcore") {
    return { status: "blocked", failure: { code: "FARM_REQUIRES_SURVIVAL", message: "Wheat farming requires verified survival mode." } };
  }
  if (player.health === null || player.health < REQUIRED_HEALTH || player.food === null || player.food < REQUIRED_FOOD) {
    return { status: "blocked", failure: { code: "FARM_VITALS_FLOOR", message: "Health or hunger is unknown or below the farm safety floor." } };
  }
  if (player.inWater === true || player.headInWater === true) {
    return { status: "blocked", failure: { code: "FARM_PLAYER_IN_WATER", message: "The player entered water; wheat farming stopped until safe and dry." } };
  }
  if (initialHealth !== null && player.health <= initialHealth - 6) {
    return { status: "blocked", failure: { code: "FARM_HEALTH_DROP", message: "Health dropped by six points or below the safe floor; wheat farming stopped." } };
  }
  if (state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= dangerRadius) || hostileNearCell(state, cell, dangerRadius)) {
    return { status: "blocked", failure: { code: "FARM_THREAT_NEARBY", message: "A hostile is within the protected player or crop-cell radius." } };
  }
  if (otherEntityAt(state, cell)) {
    return { status: "blocked", failure: { code: "FARM_CELL_HAS_ENTITY", message: `An entity occupies ${positionKey(cell)}.` } };
  }
  return null;
}

function makeCells(task: FarmWheatTask): CropCell[] {
  const cells: CropCell[] = [];
  for (let z = task.origin.z; z < task.origin.z + task.depth; z += 1) {
    const row = Array.from({ length: task.width }, (_, index) => ({ x: task.origin.x + index, y: task.origin.y, z }));
    if ((z - task.origin.z) % 2 === 1) row.reverse();
    cells.push(...row);
  }
  return cells;
}

function emptyMetrics(input: {
  readonly succeeded: boolean;
  readonly targetCount: number;
  readonly completed: number;
  readonly planted: number;
  readonly actions: number;
  readonly decisions: number;
  readonly successfulActions: number;
  readonly failedActions: number;
  readonly verifiedActions: number;
  readonly unverified: number;
  readonly safetyDenials: number;
  readonly navigations: number;
  readonly damageTaken: number;
  readonly minHealth: number | null;
  readonly elapsedMs: number;
}): TaskMetrics {
  return {
    taskSucceeded: input.succeeded,
    targetItem: "minecraft:wheat_crops",
    targetCount: input.targetCount,
    targetItemsGained: input.completed,
    progressRatio: Math.min(1, input.completed / Math.max(1, input.targetCount)),
    decisions: input.decisions,
    actions: input.actions,
    replans: 0,
    successfulActions: input.successfulActions,
    failedActions: input.failedActions,
    progressEvents: input.completed,
    recoveryAttempts: 0,
    successfulRecoveries: 0,
    stuckActions: 0,
    oscillations: 0,
    targetStalls: 0,
    itemsGained: {},
    resourcesConsumed: { wheat_seeds: input.planted },
    foodGained: 0,
    foodSourcesUsed: 0,
    resourceCollected: 0,
    damageTaken: input.damageTaken,
    minHealth: input.minHealth,
    explorationLegs: input.navigations,
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
    minedBlocks: 0,
    shelterSidesClosed: 0,
    combatActions: 0,
    hungerRecoveryActions: 0,
    deathsObserved: 0,
    respawnRecoveries: 0,
    reflexInterrupts: 0,
  };
}

/** Plants only into a fully surveyed, already irrigated field; it never tills, clears or places water. */
export class MinecraftWheatFarmRunner {
  constructor(
    private readonly runtime: GameMindRuntime<MinecraftObservation>,
    private readonly skills: SkillRuntime<MinecraftObservation>,
    private readonly logger: Logger,
    private readonly options: RunOptions = {},
  ) {}

  async run(task: FarmWheatTask): Promise<MinecraftTaskResult> {
    const clock = this.options.clock ?? (() => Date.now());
    const startedAt = clock();
    const deadline = startedAt + task.maxDurationMs;
    const cells = makeCells(task);
    const actions: TaskActionSummary[] = [];
    let status: TaskStatus = "failed";
    let failure: MinecraftTaskResult["failure"] = null;
    let calls = 0;
    let decisions = 0;
    let planted = 0;
    let initialSeeds: number | null = null;
    let completed = 0;
    let successfulActions = 0;
    let failedActions = 0;
    let verifiedActions = 0;
    let unverified = 0;
    let safetyDenials = 0;
    let navigations = 0;
    let damageTaken = 0;
    let minHealth: number | null = null;
    let initialHealth: number | null = null;

    const finish = async (): Promise<MinecraftTaskResult> => {
      const finalObservation = this.runtime.currentWorldState;
      const finalSeeds = finalObservation?.state.inventory
        .filter((item) => item.name === "wheat_seeds")
        .reduce((sum, item) => sum + item.count, 0) ?? null;
      const observedSeedsConsumed = initialSeeds !== null && finalSeeds !== null
        ? Math.max(0, initialSeeds - finalSeeds)
        : planted;
      const result: MinecraftTaskResult = {
        taskId: task.id,
        status,
        failure,
        metrics: emptyMetrics({
          succeeded: status === "succeeded",
          targetCount: cells.length,
          completed,
          planted: observedSeedsConsumed,
          actions: actions.length,
          decisions,
          successfulActions,
          failedActions,
          verifiedActions,
          unverified,
          safetyDenials,
          navigations,
          damageTaken,
          minHealth,
          elapsedMs: Math.max(0, clock() - startedAt),
        }),
        actions,
        finalObservation,
      };
      await this.runtime.trace.record({
        eventType: "task.completed",
        gameId: this.runtime.adapter.gameId,
        sessionId: this.runtime.session?.id ?? null,
        data: { taskId: task.id, status, failure, metrics: result.metrics, completedAt: new Date().toISOString() },
      });
      return result;
    };

    const record = async (
      skillId: string,
      execution: Awaited<ReturnType<SkillRuntime<MinecraftObservation>["run"]>>,
      verified: boolean | null,
      evidence: string,
      target: CropCell,
    ): Promise<void> => {
      this.options.metrics?.recordActionDuration(execution.action.durationMs);
      const succeeded = execution.action.status === "succeeded" && execution.action.confirmed && verified === true;
      const summary: TaskActionSummary = {
        actionId: execution.action.actionId,
        goalId: "project:farm-wheat",
        skillId,
        status: execution.action.status,
        confirmed: execution.action.confirmed,
        durationMs: execution.action.durationMs,
        failureCode: execution.action.failure?.code ?? (execution.action.confirmed && verified === false ? "UNVERIFIED_POSTCONDITION" : null),
        targetKey: positionKey(target),
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
        data: { taskId: task.id, action: execution.action, verification: { verified, evidence }, cropCell: target },
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
        if (before.player.health !== null && after.player.health !== null) damageTaken += Math.max(0, before.player.health - after.player.health);
        if (after.player.health !== null) minHealth = minHealth === null ? after.player.health : Math.min(minHealth, after.player.health);
      }
    };

    const stopBeforeAction = (): string | null => {
      const stop = this.options.shouldStop?.();
      if (stop) return stop;
      if (clock() >= deadline) return "TASK_DEADLINE";
      if (calls >= task.maxActions) return "MAX_ACTIONS";
      return null;
    };

    const inspect = async (
      cell: CropCell,
    ): Promise<{ readonly ok: true; readonly block: InspectedBlock } | { readonly ok: false; readonly code: string; readonly message: string }> => {
      const stop = stopBeforeAction();
      if (stop) {
        const code = stop === "TASK_DEADLINE" || stop === "MAX_ACTIONS" ? stop : "OPERATOR_STOP";
        return { ok: false, code, message: stop === "TASK_DEADLINE" ? "The overall wheat plot deadline expired." : stop === "MAX_ACTIONS" ? "The wheat plot reached its action limit." : stop };
      }
      try {
        const input = { x: cell.x, y: cell.y, z: cell.z };
        const execution = await this.skills.run("minecraft.inspect-block", input, {
          source: "operator-chat:farm-wheat-preflight",
          timeoutMs: Math.min(5_000, Math.max(1_000, deadline - clock())),
        });
        calls += 1;
        const name = execution.action.details?.name;
        const properties = execution.action.details?.properties;
        const verified = execution.action.status === "succeeded" && execution.action.confirmed && typeof name === "string";
        const evidence = typeof name === "string"
          ? `Observed '${name}' at ${positionKey(cell)}.`
          : execution.action.failure?.message ?? "The crop/soil block is not confirmed.";
        await record("minecraft.inspect-block", execution, verified, evidence, cell);
        if (!verified || typeof name !== "string") {
          return { ok: false, code: execution.action.failure?.code ?? "BLOCK_UNKNOWN", message: evidence };
        }
        return {
          ok: true,
          block: {
            name,
            properties: typeof properties === "object" && properties !== null ? properties as Readonly<Record<string, unknown>> : {},
          },
        };
      } catch (error) {
        return { ok: false, code: "INSPECT_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
      }
    };

    const navigateNear = async (cell: CropCell): Promise<boolean> => {
      const stop = stopBeforeAction();
      if (stop) {
        status = stop === "TASK_DEADLINE" ? "timed_out" : stop === "MAX_ACTIONS" ? "max_actions" : "aborted";
        failure = { code: stop === "TASK_DEADLINE" ? "TASK_DEADLINE" : stop === "MAX_ACTIONS" ? "MAX_ACTIONS" : "OPERATOR_STOP", message: stop };
        return false;
      }
      try {
        const beforeWorld = await this.runtime.observeIfStale(0);
        if (!beforeWorld || beforeWorld.sessionId !== this.runtime.session?.id) {
          status = "disconnected";
          failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The session changed before safe farm navigation." };
          return false;
        }
        const beforeFailure = farmSafetyFailure(beforeWorld.state, cell, task.dangerRadius, initialHealth);
        if (beforeFailure) {
          status = beforeFailure.status;
          failure = beforeFailure.failure;
          return false;
        }
        const input = { x: cell.x, y: cell.y, z: cell.z, range: 2 };
        const execution = await this.skills.run("minecraft.navigate", input, {
          source: "operator-chat:farm-wheat-position",
          timeoutMs: Math.min(20_000, Math.max(1_000, deadline - clock())),
        });
        calls += 1;
        navigations += 1;
        const verification = execution.action.confirmed
          ? verifySkillPostcondition("minecraft.navigate", input, execution.observationBefore?.state ?? null, execution.observationAfter?.state ?? null)
          : { verified: false, evidence: execution.action.failure?.message ?? "Navigation did not confirm arrival." };
        await record("minecraft.navigate", execution, verification.verified, verification.evidence, cell);
        const worldAfter = execution.observationAfter ?? this.runtime.currentWorldState;
        if (execution.action.status !== "succeeded" || !execution.action.confirmed || verification.verified !== true || !worldAfter) {
          status = "blocked";
          failure = { code: execution.action.failure?.code ?? "FARM_PLOT_UNREACHABLE", message: verification.evidence };
          return false;
        }
        if (worldAfter.sessionId !== this.runtime.session?.id) {
          status = "disconnected";
          failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The session changed during farm navigation." };
          return false;
        }
        const afterFailure = farmSafetyFailure(worldAfter.state, cell, task.dangerRadius, initialHealth);
        if (afterFailure) {
          status = afterFailure.status;
          failure = afterFailure.failure;
          return false;
        }
        return true;
      } catch (error) {
        status = "blocked";
        failure = { code: "FARM_NAVIGATION_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
        return false;
      }
    };

    try {
      await this.runtime.trace.record({
        eventType: "task.started",
        gameId: this.runtime.adapter.gameId,
        sessionId: this.runtime.session?.id ?? null,
        data: {
          task,
          plan: { plot: `${task.width}x${task.depth}`, cropCells: cells.length, prerequisites: ["already hydrated farmland", "wheat seeds for each empty cell"], forbidden: ["tilling", "land clearing", "water placement"] },
          startedAt: new Date(startedAt).toISOString(),
        },
      });
      if (this.runtime.adapter.status !== "connected" || !this.runtime.session) await this.runtime.connect();
      this.runtime.safety?.startRun(`${task.id}-${startedAt}`);
      const firstWorld = await this.runtime.observeIfStale(0);
      if (!firstWorld || firstWorld.sessionId !== this.runtime.session?.id) {
        status = "disconnected";
        failure = { code: "WORLD_STATE_UNAVAILABLE", message: "A fresh same-session world observation is required before planting wheat." };
        return await finish();
      }
      let world: WorldState<MinecraftObservation> = firstWorld;
      const player = world.state.player;
      initialHealth = player.health;
      minHealth = initialHealth;
      if (player.alive !== true || (player.health !== null && player.health <= 0)) {
        status = player.alive === false || (player.health !== null && player.health <= 0) ? "aborted" : "blocked";
        failure = {
          code: player.alive === false || (player.health !== null && player.health <= 0) ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
          message: "A verified living player is required before wheat planting can begin.",
        };
        return await finish();
      }
      if (player.dimension !== "overworld") {
        status = "blocked";
        failure = { code: "FARM_REQUIRES_OVERWORLD", message: "The wheat plot must be located in the confirmed overworld." };
        return await finish();
      }
      if (player.gameMode !== "survival" && player.gameMode !== "hardcore") {
        status = "blocked";
        failure = { code: "FARM_REQUIRES_SURVIVAL", message: `Wheat farming requires verified survival mode; observed ${player.gameMode ?? "unknown"}.` };
        return await finish();
      }
      if (player.health === null || player.health < REQUIRED_HEALTH || player.food === null || player.food < REQUIRED_FOOD) {
        status = "blocked";
        failure = { code: "FARM_VITALS_TOO_LOW", message: `Observe at least ${REQUIRED_HEALTH}/20 health and ${REQUIRED_FOOD}/20 hunger before planting.` };
        return await finish();
      }
      if (world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
        status = "blocked";
        failure = { code: "FARM_THREAT_NEARBY", message: "A visible hostile is too close to the wheat plot; no seeds were used." };
        return await finish();
      }
      const farthestCorner = Math.max(...[
        [task.origin.x, task.origin.z],
        [task.origin.x + task.width - 1, task.origin.z],
        [task.origin.x, task.origin.z + task.depth - 1],
        [task.origin.x + task.width - 1, task.origin.z + task.depth - 1],
      ].map(([x, z]) => Math.hypot(x! + 0.5 - player.position.x, task.origin.y + 0.5 - player.position.y, z! + 0.5 - player.position.z)));
      if (farthestCorner > task.maxTargetDistance || farthestCorner > SAFE_FARM_NAVIGATION_LIMIT) {
        status = "blocked";
        failure = { code: "FARM_PLOT_TOO_FAR", message: "The plot exceeds the bounded navigation range; repeat the request closer to the farm site." };
        return await finish();
      }

      const emptyCells: CropCell[] = [];
      for (const cropCell of cells) {
        if (this.options.shouldStop?.()) {
          status = "aborted";
          failure = { code: "OPERATOR_STOP", message: this.options.shouldStop() ?? "Operator stopped the wheat site survey." };
          return await finish();
        }
        let soil = await inspect({ ...cropCell, y: cropCell.y - 1 });
        if (!soil.ok && ["BLOCK_UNKNOWN", "BLOCK_OUT_OF_RANGE"].includes(soil.code)) {
          if (!(await navigateNear(cropCell))) return await finish();
          soil = await inspect({ ...cropCell, y: cropCell.y - 1 });
        }
        if (!soil.ok) {
          status = soil.code === "TASK_DEADLINE" ? "timed_out" : soil.code === "MAX_ACTIONS" ? "max_actions" : soil.code === "OPERATOR_STOP" ? "aborted" : "blocked";
          failure = { code: soil.code, message: `Could not verify soil for ${positionKey(cropCell)}: ${soil.message}` };
          return await finish();
        }
        const moisture = Number(soil.block.properties.moisture);
        if (soil.block.name !== "farmland" || !Number.isFinite(moisture) || moisture < 1) {
          status = "blocked";
          failure = { code: "FARM_SOIL_NOT_HYDRATED", message: `Cell ${positionKey(cropCell)} needs already hydrated farmland; observed ${soil.block.name} with moisture ${Number.isFinite(moisture) ? moisture : "unknown"}. No crops were planted.` };
          return await finish();
        }
        let crop = await inspect(cropCell);
        if (!crop.ok && ["BLOCK_UNKNOWN", "BLOCK_OUT_OF_RANGE"].includes(crop.code)) {
          if (!(await navigateNear(cropCell))) return await finish();
          crop = await inspect(cropCell);
        }
        if (!crop.ok) {
          status = crop.code === "TASK_DEADLINE" ? "timed_out" : crop.code === "MAX_ACTIONS" ? "max_actions" : crop.code === "OPERATOR_STOP" ? "aborted" : "blocked";
          failure = { code: crop.code, message: `Could not verify crop cell ${positionKey(cropCell)}: ${crop.message}` };
          return await finish();
        }
        if (crop.block.name === "wheat") {
          completed += 1;
        } else if (crop.block.name === "air" || crop.block.name.endsWith("_air")) {
          if (otherEntityAt(this.runtime.currentWorldState?.state ?? world.state, cropCell)) {
            status = "blocked";
            failure = { code: "FARM_CELL_HAS_ENTITY", message: `An entity occupies ${positionKey(cropCell)}; no seed was planted there.` };
            return await finish();
          }
          emptyCells.push(cropCell);
        } else {
          status = "blocked";
          failure = { code: "FARM_CROP_CELL_OCCUPIED", message: `Crop cell ${positionKey(cropCell)} is occupied by ${crop.block.name}; existing plants are never cleared.` };
          return await finish();
        }
      }

      const surveyedWorld = await this.runtime.observeIfStale(0);
      if (!surveyedWorld || surveyedWorld.sessionId !== this.runtime.session?.id) {
        status = "disconnected";
        failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The session changed before the seed preflight; no crops were planted." };
        return await finish();
      }
      world = surveyedWorld;
      const seeds = world.state.inventory.filter((item) => item.name === "wheat_seeds").reduce((sum, item) => sum + item.count, 0);
      initialSeeds = seeds;
      if (seeds < emptyCells.length) {
        status = "blocked";
        failure = { code: "FARM_SEEDS_MISSING", message: `The plot has ${emptyCells.length} empty cells but only ${seeds} wheat seeds; no seeds were used before this check.` };
        return await finish();
      }
      if (emptyCells.length === 0) {
        status = "succeeded";
        failure = null;
        return await finish();
      }

      const cellIndex = new Map(cells.map((cell, index) => [positionKey(cell), index] as const));
      let routeCursor = cells.length - 1;
      for (const cropCell of [...emptyCells].reverse()) {
        const targetIndex = cellIndex.get(positionKey(cropCell));
        if (targetIndex === undefined) {
          status = "failed";
          failure = { code: "FARM_ROUTE_INVALID", message: "A surveyed planting cell is missing from the bounded farm route." };
          return await finish();
        }
        while (routeCursor > targetIndex) {
          routeCursor -= 1;
          const waypoint = cells[routeCursor];
          if (!waypoint) continue;
          const routeWorld = this.runtime.currentWorldState ?? world;
          if (distanceToCell(routeWorld.state.player.position, waypoint) > PLANTING_APPROACH_LIMIT && !(await navigateNear(waypoint))) {
            return await finish();
          }
        }
        const stop = stopBeforeAction();
        if (stop) {
          status = stop === "TASK_DEADLINE" ? "timed_out" : stop === "MAX_ACTIONS" ? "max_actions" : "aborted";
          failure = { code: stop === "TASK_DEADLINE" ? "TASK_DEADLINE" : stop === "MAX_ACTIONS" ? "MAX_ACTIONS" : "OPERATOR_STOP", message: stop };
          break;
        }
        const currentWorld = await this.runtime.observeIfStale(0);
        if (!currentWorld || currentWorld.sessionId !== this.runtime.session?.id) {
          status = "disconnected";
          failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The live world observation disappeared during planting." };
          break;
        }
        world = currentWorld;
        const currentSafetyFailure = farmSafetyFailure(world.state, cropCell, task.dangerRadius, initialHealth);
        if (currentSafetyFailure) {
          status = currentSafetyFailure.status;
          failure = currentSafetyFailure.failure;
          break;
        }
        if (distanceToCell(world.state.player.position, cropCell) > PLANTING_APPROACH_LIMIT) {
          if (!(await navigateNear(cropCell))) break;
          const approachedWorld = await this.runtime.observeIfStale(0);
          if (!approachedWorld || approachedWorld.sessionId !== this.runtime.session?.id) {
            status = "disconnected";
            failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The live world observation disappeared after approaching a crop cell." };
            break;
          }
          world = approachedWorld;
          const approachFailure = farmSafetyFailure(world.state, cropCell, task.dangerRadius, initialHealth);
          if (approachFailure) {
            status = approachFailure.status;
            failure = approachFailure.failure;
            break;
          }
        }
        decisions += 1;
        try {
          const input = { x: cropCell.x, y: cropCell.y, z: cropCell.z, dangerRadius: task.dangerRadius };
          const execution = await this.skills.run("minecraft.plant-wheat", input, {
            source: "operator-chat:confirmed-farm-wheat",
            timeoutMs: Math.min(60_000, Math.max(1_000, deadline - clock())),
          });
          calls += 1;
          const verification = execution.action.confirmed
            ? verifySkillPostcondition("minecraft.plant-wheat", input, execution.observationBefore?.state ?? world.state, execution.observationAfter?.state ?? this.runtime.currentWorldState?.state ?? null)
            : { verified: false, evidence: execution.action.failure?.message ?? "The adapter did not confirm wheat planting." };
          await record("minecraft.plant-wheat", execution, verification.verified, verification.evidence, cropCell);
          world = execution.observationAfter ?? this.runtime.currentWorldState ?? world;
          if (execution.action.status !== "succeeded" || !execution.action.confirmed || verification.verified !== true) {
            status = execution.action.failure?.code?.startsWith("SAFETY_") ? "blocked" : execution.action.status === "timed_out" ? "timed_out" : "failed";
            failure = {
              code: execution.action.failure?.code ?? (verification.verified === false ? "UNVERIFIED_POSTCONDITION" : "WHEAT_PLANTING_FAILED"),
              message: execution.action.failure?.message ?? verification.evidence,
            };
            break;
          }
          planted += 1;
          completed += 1;
        } catch (error) {
          status = "failed";
          failure = { code: "WHEAT_PLANTING_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
          break;
        }
      }
      if (failure === null && completed === cells.length) status = "succeeded";
      else if (failure === null) {
        status = "failed";
        failure = { code: "FARM_INCOMPLETE", message: `Only ${completed}/${cells.length} crop cells are confirmed wheat.` };
      }
      return await finish();
    } catch (error) {
      this.logger.error({ err: error, taskId: task.id }, "Wheat farm runner failed");
      status = this.runtime.adapter.status === "connected" ? "failed" : "disconnected";
      failure = { code: "FARM_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error) };
      return await finish();
    }
  }
}
