import type { Logger } from "pino";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import type { WorldState } from "../../core/types.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { verifySkillPostcondition } from "./skill-contracts.js";
import type { MinecraftObservation } from "./observation.js";
import type { BuildHouseTask } from "./task.js";
import type { MinecraftTaskResult, TaskActionSummary, TaskMetrics, TaskStatus } from "./task-runner.js";
import type { RuntimeMetrics } from "./runtime-metrics.js";

const HOUSE_WIDTH = 5;
const HOUSE_DEPTH = 5;
const HOUSE_HEIGHT = 4;
const HOUSE_MATERIAL_MAX_DISTANCE = 24;
const PLACEMENT_REACH = 4.5;
const REQUIRED_HEALTH = 8;

interface RunOptions {
  readonly shouldStop?: () => string | null;
  readonly onAction?: (action: TaskActionSummary) => void;
  readonly metrics?: RuntimeMetrics;
  readonly clock?: () => number;
}

interface HouseCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly role: "floor" | "wall" | "roof";
}

interface InspectedCell {
  readonly name: string;
  readonly boundingBox: string;
}

function cellKey(cell: { readonly x: number; readonly y: number; readonly z: number }): string {
  return `${cell.x},${cell.y},${cell.z}`;
}

function inventoryCount(state: MinecraftObservation, itemName: string): number {
  return state.inventory.filter((item) => item.name === itemName).reduce((sum, item) => sum + item.count, 0);
}

function blockDistance(state: MinecraftObservation, cell: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(
    cell.x + 0.5 - state.player.position.x,
    cell.y + 0.5 - state.player.position.y,
    cell.z + 0.5 - state.player.position.z,
  );
}

function resourceDistance(state: MinecraftObservation, position: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(position.x - state.player.position.x, position.y - state.player.position.y, position.z - state.player.position.z);
}

function safeFoundation(name: string): boolean {
  return !(
    name === "sand" || name === "red_sand" || name === "gravel" ||
    name === "suspicious_sand" || name === "suspicious_gravel" ||
    name === "water" || name === "lava" || name === "magma_block" ||
    name.endsWith("_concrete_powder")
  );
}

function houseLayout(task: BuildHouseTask): {
  readonly floor: HouseCell[];
  readonly walls: HouseCell[];
  readonly roof: HouseCell[];
  readonly clearance: Array<{ x: number; y: number; z: number }>;
  readonly foundation: Array<{ x: number; y: number; z: number }>;
} {
  const { x: xMin, y: baseY, z: zMin } = task.origin;
  const xMax = xMin + HOUSE_WIDTH - 1;
  const zMax = zMin + HOUSE_DEPTH - 1;
  const floor: HouseCell[] = [];
  const walls: HouseCell[] = [];
  const roof: HouseCell[] = [];
  const clearance: Array<{ x: number; y: number; z: number }> = [];
  const foundation: Array<{ x: number; y: number; z: number }> = [];
  const doorwayX = xMin + Math.floor(HOUSE_WIDTH / 2);

  for (let z = zMin; z <= zMax; z += 1) {
    for (let x = xMin; x <= xMax; x += 1) {
      floor.push({ x, y: baseY, z, role: "floor" });
      foundation.push({ x, y: baseY - 1, z });
      for (let y = baseY; y < baseY + HOUSE_HEIGHT; y += 1) clearance.push({ x, y, z });
      const perimeter = x === xMin || x === xMax || z === zMin || z === zMax;
      if (perimeter) {
        for (let y = baseY + 1; y <= baseY + 2; y += 1) {
          // Leave a two-block-high, one-block-wide entrance on the near side.
          if (z === zMin && x === doorwayX) continue;
          walls.push({ x, y, z, role: "wall" });
        }
      }
      roof.push({ x, y: baseY + 3, z, role: "roof" });
    }
  }
  return { floor, walls, roof, clearance, foundation };
}

function metrics(input: {
  readonly succeeded: boolean;
  readonly targetCount: number;
  readonly completed: number;
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
  readonly materialName: string;
}): TaskMetrics {
  return {
    taskSucceeded: input.succeeded,
    targetItem: "minecraft:house_blocks",
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
    resourcesConsumed: { [input.materialName]: input.completed },
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

/** Builds one preflighted 5×5 starter house using already-carried planks; there is no land clearing. */
export class MinecraftHouseRunner {
  constructor(
    private readonly runtime: GameMindRuntime<MinecraftObservation>,
    private readonly skills: SkillRuntime<MinecraftObservation>,
    private readonly logger: Logger,
    private readonly options: RunOptions = {},
  ) {}

  async run(task: BuildHouseTask): Promise<MinecraftTaskResult> {
    const clock = this.options.clock ?? (() => Date.now());
    const startedAt = clock();
    const deadline = startedAt + task.maxDurationMs;
    const layout = houseLayout(task);
    const structure = [...layout.floor, ...layout.walls, ...layout.roof];
    const actions: TaskActionSummary[] = [];
    let status: TaskStatus = "failed";
    let failure: MinecraftTaskResult["failure"] = null;
    let completed = 0;
    let calls = 0;
    let decisions = 0;
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
      const result: MinecraftTaskResult = {
        taskId: task.id,
        status,
        failure,
        metrics: metrics({
          succeeded: status === "succeeded",
          targetCount: structure.length,
          completed,
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
          materialName: task.materialName,
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
      target: { readonly x: number; readonly y: number; readonly z: number },
    ): Promise<void> => {
      this.options.metrics?.recordActionDuration(execution.action.durationMs);
      const succeeded = execution.action.status === "succeeded" && execution.action.confirmed && verified === true;
      const summary: TaskActionSummary = {
        actionId: execution.action.actionId,
        goalId: "project:build-house",
        skillId,
        status: execution.action.status,
        confirmed: execution.action.confirmed,
        durationMs: execution.action.durationMs,
        failureCode: execution.action.failure?.code ?? (execution.action.confirmed && verified === false ? "UNVERIFIED_POSTCONDITION" : null),
        targetKey: cellKey(target),
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
        data: { taskId: task.id, action: execution.action, verification: { verified, evidence }, houseTarget: target },
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

    const inspect = async (
      cell: { readonly x: number; readonly y: number; readonly z: number },
    ): Promise<{ readonly ok: true; readonly cell: InspectedCell } | { readonly ok: false; readonly code: string; readonly message: string }> => {
      const stop = this.options.shouldStop?.();
      if (stop) return { ok: false, code: "OPERATOR_STOP", message: stop };
      if (clock() >= deadline) return { ok: false, code: "TASK_DEADLINE", message: "The house task ran out of time during its site inspection." };
      if (calls >= task.maxActions) return { ok: false, code: "MAX_ACTIONS", message: `The house task reached its action limit (${task.maxActions}) during site inspection.` };
      try {
        const input = { x: cell.x, y: cell.y, z: cell.z };
        const execution = await this.skills.run("minecraft.inspect-block", input, {
          source: "operator-chat:build-house-preflight",
          timeoutMs: Math.min(5_000, Math.max(1_000, deadline - clock())),
        });
        calls += 1;
        const name = execution.action.details?.name;
        const boundingBox = execution.action.details?.boundingBox;
        const verified = execution.action.status === "succeeded" && execution.action.confirmed && typeof name === "string";
        const evidence = typeof name === "string"
          ? `Observed '${name}' (${String(boundingBox ?? "unknown shape")}) at ${cellKey(cell)}.`
          : execution.action.failure?.message ?? "The cell has no confirmed block read.";
        await record("minecraft.inspect-block", execution, verified, evidence, cell);
        if (!verified || typeof name !== "string" || typeof boundingBox !== "string") {
          return { ok: false, code: execution.action.failure?.code ?? "BLOCK_UNKNOWN", message: evidence };
        }
        return { ok: true, cell: { name, boundingBox } };
      } catch (error) {
        return { ok: false, code: "INSPECT_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
      }
    };

    const executeNavigation = async (
      cell: { readonly x: number; readonly y: number; readonly z: number },
      source: string,
    ): Promise<{ readonly ok: boolean; readonly world: WorldState<MinecraftObservation> | null; readonly code: string | null; readonly message: string }> => {
      const stop = this.options.shouldStop?.();
      if (stop) return { ok: false, world: this.runtime.currentWorldState, code: "OPERATOR_STOP", message: stop };
      if (clock() >= deadline) return { ok: false, world: this.runtime.currentWorldState, code: "TASK_DEADLINE", message: "The house task ran out of time while moving to a safe build position." };
      if (calls >= task.maxActions) return { ok: false, world: this.runtime.currentWorldState, code: "MAX_ACTIONS", message: `The house task reached its action limit (${task.maxActions}) while moving.` };
      const input = { ...cell, range: 1 };
      try {
        const execution = await this.skills.run("minecraft.navigate", input, {
          source,
          timeoutMs: Math.min(20_000, Math.max(1_000, deadline - clock())),
        });
        calls += 1;
        navigations += 1;
        const verification = execution.action.confirmed
          ? verifySkillPostcondition("minecraft.navigate", input, execution.observationBefore?.state ?? null, execution.observationAfter?.state ?? null)
          : { verified: false, evidence: execution.action.failure?.message ?? "Navigation did not confirm arrival." };
        await record("minecraft.navigate", execution, verification.verified, verification.evidence, cell);
        const world = execution.observationAfter ?? this.runtime.currentWorldState;
        return {
          ok: execution.action.status === "succeeded" && execution.action.confirmed && verification.verified === true && world !== null,
          world,
          code: execution.action.failure?.code ?? (verification.verified === true ? null : "NAVIGATION_NOT_VERIFIED"),
          message: execution.action.failure?.message ?? verification.evidence,
        };
      } catch (error) {
        return { ok: false, world: this.runtime.currentWorldState, code: "NAVIGATION_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
      }
    };

    try {
      await this.runtime.trace.record({
        eventType: "task.started",
        gameId: this.runtime.adapter.gameId,
        sessionId: this.runtime.session?.id ?? null,
        data: {
          task,
          plan: { footprint: "5x5", floors: layout.floor.length, walls: layout.walls.length, roof: layout.roof.length, materials: { [task.materialName]: structure.length }, entrance: "two blocks high, no door" },
          startedAt: new Date(startedAt).toISOString(),
        },
      });
      if (this.runtime.adapter.status !== "connected" || !this.runtime.session) await this.runtime.connect();
      this.runtime.safety?.startRun(`${task.id}-${startedAt}`);
      const firstWorld = await this.runtime.observeIfStale(0);
      if (!firstWorld || firstWorld.sessionId !== this.runtime.session?.id) {
        status = "disconnected";
        failure = { code: "WORLD_STATE_UNAVAILABLE", message: "A fresh same-session world observation is required before house construction." };
        return await finish();
      }
      let world: WorldState<MinecraftObservation> = firstWorld;
      initialHealth = world.state.player.health;
      minHealth = initialHealth;
      const player = world.state.player;
      if (player.alive !== true || (player.health !== null && player.health <= 0)) {
        status = player.alive === false || (player.health !== null && player.health <= 0) ? "aborted" : "blocked";
        failure = {
          code: player.alive === false || (player.health !== null && player.health <= 0) ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
          message: "A verified living player is required before construction can begin.",
        };
        return await finish();
      }
      if (player.dimension !== "overworld") {
        status = "blocked";
        failure = { code: "HOUSE_REQUIRES_OVERWORLD", message: "The starter house is only planned in a confirmed overworld location." };
        return await finish();
      }
      if (player.gameMode !== "survival" && player.gameMode !== "hardcore") {
        status = "blocked";
        failure = { code: "HOUSE_REQUIRES_SURVIVAL", message: `House construction requires verified survival mode; observed ${player.gameMode ?? "unknown"}.` };
        return await finish();
      }
      if (!player.onGround || player.inWater === true || player.headInWater === true) {
        status = "blocked";
        failure = { code: "UNSAFE_BUILD_POSITION", message: "The build request arrived while the player was airborne or in water; no construction was attempted." };
        return await finish();
      }
      if (player.health === null || player.health < REQUIRED_HEALTH) {
        status = "blocked";
        failure = { code: "HOUSE_HEALTH_TOO_LOW", message: `Health must be observed at ${REQUIRED_HEALTH}/20 or higher before construction.` };
        return await finish();
      }
      if (player.food === null || player.food < 6) {
        status = "blocked";
        failure = { code: "HOUSE_HUNGER_TOO_LOW", message: "Hunger is below six; eat before starting the long construction task." };
        return await finish();
      }
      if (world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
        status = "blocked";
        failure = { code: "HOUSE_BUILD_THREAT", message: "A visible hostile is too close to the proposed house site; construction stopped before changing blocks." };
        return await finish();
      }
      const xMin = task.origin.x;
      const xMax = xMin + HOUSE_WIDTH - 1;
      const yMin = task.origin.y;
      const zMin = task.origin.z;
      const zMax = zMin + HOUSE_DEPTH - 1;
      const outsideFootprint = (position: { readonly x: number; readonly z: number }): boolean =>
        Math.floor(position.x) < xMin || Math.floor(position.x) > xMax ||
        Math.floor(position.z) < zMin || Math.floor(position.z) > zMax;
      const otherEntityAt = (state: MinecraftObservation, cell: { readonly x: number; readonly y: number; readonly z: number }): boolean =>
        state.entities.some((entity) => {
          if (entity.type === "player" && entity.name === state.player.username) return false;
          return Math.floor(entity.position.x) === cell.x && Math.floor(entity.position.y) === cell.y && Math.floor(entity.position.z) === cell.z;
        });
      const farthestCorner = Math.max(...[
        [xMin, yMin, zMin], [xMin, yMin, zMax], [xMax, yMin, zMin], [xMax, yMin, zMax],
        [xMin, yMin + HOUSE_HEIGHT - 1, zMin], [xMin, yMin + HOUSE_HEIGHT - 1, zMax],
        [xMax, yMin + HOUSE_HEIGHT - 1, zMin], [xMax, yMin + HOUSE_HEIGHT - 1, zMax],
      ].map(([x, y, z]) => Math.hypot(x! + 0.5 - player.position.x, y! + 0.5 - player.position.y, z! + 0.5 - player.position.z)));
      if (farthestCorner > 48) {
        status = "blocked";
        failure = { code: "HOUSE_SITE_TOO_FAR", message: "The planned 5×5 site is outside the safe navigation range; repeat the request near the desired location." };
        return await finish();
      }
      const occupiedCell = layout.clearance.find((cell) => otherEntityAt(world.state, cell));
      if (occupiedCell) {
        status = "blocked";
        failure = { code: "HOUSE_SITE_HAS_ENTITY", message: `An entity occupies the planned house at ${cellKey(occupiedCell)}; no blocks were changed.` };
        return await finish();
      }

      // Complete the read-only site survey before the first irreversible placement.
      for (const cell of layout.foundation) {
        if (this.options.shouldStop?.()) {
          status = "aborted";
          failure = { code: "OPERATOR_STOP", message: this.options.shouldStop() ?? "Operator stopped the house site survey." };
          return await finish();
        }
        const inspected = await inspect(cell);
        if (!inspected.ok) {
          status = inspected.code === "TASK_DEADLINE" ? "timed_out" : inspected.code === "MAX_ACTIONS" ? "max_actions" : inspected.code === "OPERATOR_STOP" ? "aborted" : "blocked";
          failure = { code: inspected.code, message: `Foundation block ${cellKey(cell)} could not be safely verified: ${inspected.message}` };
          return await finish();
        }
        if (inspected.cell.boundingBox !== "block" || !safeFoundation(inspected.cell.name)) {
          status = "blocked";
          failure = { code: "HOUSE_FOUNDATION_UNSAFE", message: `Foundation at ${cellKey(cell)} is not stable solid ground (${inspected.cell.name}, ${inspected.cell.boundingBox}). No blocks were changed.` };
          return await finish();
        }
      }
      for (const cell of layout.clearance) {
        const inspected = await inspect(cell);
        if (!inspected.ok) {
          status = inspected.code === "TASK_DEADLINE" ? "timed_out" : inspected.code === "MAX_ACTIONS" ? "max_actions" : inspected.code === "OPERATOR_STOP" ? "aborted" : "blocked";
          failure = { code: inspected.code, message: `House clearance cell ${cellKey(cell)} could not be safely verified: ${inspected.message}` };
          return await finish();
        }
        if (!(inspected.cell.name === "air" || inspected.cell.name.endsWith("_air"))) {
          status = "blocked";
          failure = { code: "HOUSE_SITE_OCCUPIED", message: `House volume is occupied by ${inspected.cell.name} at ${cellKey(cell)}. I do not clear trees, terrain, liquids, or existing builds automatically.` };
          return await finish();
        }
      }

      // Gather and craft only the finite material budget this approved blueprint needs. The whole
      // construction site has already passed its read-only survey, so a failed material preflight
      // cannot leave a partly built shell behind.
      const materialWorld = await this.runtime.observeIfStale(0);
      if (!materialWorld || materialWorld.sessionId !== this.runtime.session?.id) {
        status = "disconnected";
        failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The session changed before house materials could be prepared." };
        return await finish();
      }
      world = materialWorld;
      const logName = task.materialName.replace(/_planks$/, "_log");
      let planks = inventoryCount(world.state, task.materialName);
      let logs = inventoryCount(world.state, logName);
      const requiredLogs = Math.max(0, Math.ceil((structure.length - planks) / 4) - logs);
      if (requiredLogs > 0 && !task.allowMaterialGathering) {
        status = "blocked";
        failure = {
          code: "HOUSE_MATERIAL_GATHERING_NOT_APPROVED",
          message: `The carried inventory is short by up to ${requiredLogs} ${logName}. No nearby logs will be collected without a separate operator approval.`,
        };
        return await finish();
      }
      if (requiredLogs > 0) {
        const candidates = new Map<string, { x: number; y: number; z: number }>();
        for (const sighting of world.state.resourceSightings) {
          const distance = resourceDistance(world.state, sighting.position);
          if (sighting.name === logName && sighting.visible === true && distance <= HOUSE_MATERIAL_MAX_DISTANCE) candidates.set(cellKey(sighting.position), sighting.position);
        }
        for (const block of world.state.nearbyBlocks) {
          if (block.name === logName && block.visible === true && resourceDistance(world.state, block.position) <= HOUSE_MATERIAL_MAX_DISTANCE) candidates.set(cellKey(block.position), block.position);
        }
        if (candidates.size < requiredLogs) {
          status = "blocked";
          failure = { code: "HOUSE_MATERIALS_MISSING", message: `Need ${structure.length} ${task.materialName} or enough ${logName} plus nearby observed logs to craft them; the approved site is clear, but this area has only ${logs} usable logs and ${candidates.size} eligible log blocks.` };
          return await finish();
        }
        const selectedLogs = [...candidates.values()]
          .sort((left, right) => resourceDistance(world.state, left) - resourceDistance(world.state, right))
          .slice(0, requiredLogs);
        // Re-read every selected target before the first collection so stale scan results cannot
        // turn one separate permission into a partial run against trees that have changed.
        for (const position of selectedLogs) {
          let inspected = await inspect(position);
          if (!inspected.ok && ["BLOCK_UNKNOWN", "BLOCK_OUT_OF_RANGE"].includes(inspected.code)) {
            const approachWorld = await this.runtime.observeIfStale(0);
            if (!approachWorld || approachWorld.sessionId !== this.runtime.session?.id) {
              status = "disconnected";
              failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The live world state disappeared before rechecking an approved log." };
              return await finish();
            }
            world = approachWorld;
            if (world.state.player.alive !== true || world.state.player.health === null || world.state.player.health < REQUIRED_HEALTH || world.state.player.food === null || world.state.player.food < 6 || world.state.player.inWater === true || world.state.player.headInWater === true || world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
              status = "blocked";
              failure = { code: "HOUSE_GATHERING_UNSAFE", message: "The player is no longer confirmed safe to approach an approved log." };
              return await finish();
            }
            const movement = await executeNavigation(position, "operator-chat:build-house-log-recheck");
            if (!movement.ok || !movement.world || movement.world.sessionId !== this.runtime.session?.id) {
              status = movement.code === "TASK_DEADLINE" ? "timed_out" : movement.code === "MAX_ACTIONS" ? "max_actions" : movement.code === "OPERATOR_STOP" ? "aborted" : "blocked";
              failure = { code: movement.code ?? "HOUSE_LOG_RECHECK_UNREACHABLE", message: `Could not safely approach approved log ${cellKey(position)}: ${movement.message}` };
              return await finish();
            }
            world = movement.world;
            inspected = await inspect(position);
          }
          if (!inspected.ok || inspected.cell.name !== logName || inspected.cell.boundingBox !== "block") {
            status = inspected.ok ? "blocked" : inspected.code === "TASK_DEADLINE" ? "timed_out" : inspected.code === "MAX_ACTIONS" ? "max_actions" : inspected.code === "OPERATOR_STOP" ? "aborted" : "blocked";
            failure = {
              code: inspected.ok ? "HOUSE_LOG_TARGET_CHANGED" : inspected.code,
              message: inspected.ok
                ? `The approved ${logName} at ${cellKey(position)} is no longer a confirmed solid log; no material has been collected.`
                : `Could not safely recheck approved log ${cellKey(position)}: ${inspected.message}`,
            };
            return await finish();
          }
        }
        for (const position of selectedLogs) {
          if (this.options.shouldStop?.()) {
            status = "aborted";
            failure = { code: "OPERATOR_STOP", message: this.options.shouldStop() ?? "Operator stopped house material gathering." };
            return await finish();
          }
          if (calls >= task.maxActions) {
            status = "max_actions";
            failure = { code: "MAX_ACTIONS", message: "House material gathering reached the action limit before construction." };
            return await finish();
          }
          const currentWorld = await this.runtime.observeIfStale(0);
          if (!currentWorld || currentWorld.sessionId !== this.runtime.session?.id) {
            status = "disconnected";
            failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The live player/world state disappeared while collecting approved house materials." };
            return await finish();
          }
          world = currentWorld;
          if (world.state.player.alive !== true) {
            status = world.state.player.alive === false ? "aborted" : "blocked";
            failure = {
              code: world.state.player.alive === false ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
              message: "The player's living state is no longer confirmed; material gathering stopped.",
            };
            return await finish();
          }
          if (world.state.player.health === null || world.state.player.health < REQUIRED_HEALTH || world.state.player.food === null || world.state.player.food < 6 || (world.state.player.gameMode !== "survival" && world.state.player.gameMode !== "hardcore") || world.state.player.dimension !== "overworld" || world.state.player.inWater === true || world.state.player.headInWater === true) {
            status = "blocked";
            failure = { code: "HOUSE_GATHERING_UNSAFE", message: "Player vitals, survival mode, dimension, or water state became unsafe or unknown; house material gathering stopped." };
            return await finish();
          }
          if (world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
            status = "blocked";
            failure = { code: "HOUSE_BUILD_THREAT", message: "A hostile approached while collecting house materials; construction was not started." };
            return await finish();
          }
          if (resourceDistance(world.state, position) > HOUSE_MATERIAL_MAX_DISTANCE) {
            const movement = await executeNavigation(position, "operator-chat:build-house-log-collection");
            if (!movement.ok || !movement.world || movement.world.sessionId !== this.runtime.session?.id) {
              status = movement.code === "TASK_DEADLINE" ? "timed_out" : movement.code === "MAX_ACTIONS" ? "max_actions" : movement.code === "OPERATOR_STOP" ? "aborted" : "blocked";
              failure = { code: movement.code ?? "HOUSE_LOG_OUT_OF_RANGE", message: `Could not safely approach approved log ${cellKey(position)}: ${movement.message}` };
              return await finish();
            }
            world = movement.world;
            if (resourceDistance(world.state, position) > HOUSE_MATERIAL_MAX_DISTANCE) {
              status = "blocked";
              failure = { code: "HOUSE_LOG_OUT_OF_RANGE", message: `The approved ${logName} at ${cellKey(position)} remains outside ${HOUSE_MATERIAL_MAX_DISTANCE}-block collection reach; gathering stopped.` };
              return await finish();
            }
            if (world.state.player.alive !== true || world.state.player.health === null || world.state.player.health < REQUIRED_HEALTH || world.state.player.food === null || world.state.player.food < 6 || (world.state.player.gameMode !== "survival" && world.state.player.gameMode !== "hardcore") || world.state.player.dimension !== "overworld" || world.state.player.inWater === true || world.state.player.headInWater === true || world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
              status = "blocked";
              failure = { code: "HOUSE_GATHERING_UNSAFE", message: "Player safety state changed while approaching an approved log; gathering stopped." };
              return await finish();
            }
          }
          const input = { ...position, blockName: logName, dangerRadius: task.dangerRadius };
          try {
            const execution = await this.skills.run("minecraft.collect-log", input, {
              source: "operator-chat:build-house-material-collection",
              timeoutMs: Math.min(30_000, Math.max(1_000, deadline - clock())),
            });
            calls += 1;
            const verification = execution.action.confirmed
              ? verifySkillPostcondition("minecraft.collect-log", input, execution.observationBefore?.state ?? world.state, execution.observationAfter?.state ?? this.runtime.currentWorldState?.state ?? null)
              : { verified: false, evidence: execution.action.failure?.message ?? "The log collection was not confirmed." };
            await record("minecraft.collect-log", execution, verification.verified, verification.evidence, position);
            if (execution.action.status !== "succeeded" || !execution.action.confirmed || verification.verified !== true) {
              status = execution.action.failure?.code?.startsWith("SAFETY_") ? "blocked" : execution.action.status === "timed_out" ? "timed_out" : "failed";
              failure = { code: execution.action.failure?.code ?? "HOUSE_LOG_COLLECTION_FAILED", message: execution.action.failure?.message ?? verification.evidence };
              return await finish();
            }
          } catch (error) {
            status = "failed";
            failure = { code: "HOUSE_LOG_COLLECTION_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
            return await finish();
          }
          world = await this.runtime.observeIfStale(0) ?? world;
          logs = inventoryCount(world.state, logName);
        }
      }
      world = await this.runtime.observeIfStale(0) ?? world;
      planks = inventoryCount(world.state, task.materialName);
      logs = inventoryCount(world.state, logName);
      if (planks < structure.length && logs < Math.ceil((structure.length - planks) / 4)) {
        status = "blocked";
        failure = { code: "HOUSE_LOGS_INSUFFICIENT", message: `Only ${logs} ${logName} are available; ${Math.ceil((structure.length - planks) / 4)} are needed to craft the remaining planks.` };
        return await finish();
      }
      if (planks < structure.length) {
        if (calls >= task.maxActions) {
          status = "max_actions";
          failure = { code: "MAX_ACTIONS", message: "House crafting reached the action limit before construction." };
          return await finish();
        }
        const input = { item: task.materialName, count: structure.length };
        try {
          const execution = await this.skills.run("minecraft.craft-item", input, {
            source: "operator-chat:build-house-material-crafting",
            timeoutMs: Math.min(30_000, Math.max(1_000, deadline - clock())),
          });
          calls += 1;
          const verification = execution.action.confirmed
            ? verifySkillPostcondition("minecraft.craft-item", input, execution.observationBefore?.state ?? world.state, execution.observationAfter?.state ?? this.runtime.currentWorldState?.state ?? null)
            : { verified: false, evidence: execution.action.failure?.message ?? "Plank crafting was not confirmed." };
          await record("minecraft.craft-item", execution, verification.verified, verification.evidence, task.origin);
          if (execution.action.status !== "succeeded" || !execution.action.confirmed || verification.verified !== true) {
            status = execution.action.failure?.code?.startsWith("SAFETY_") ? "blocked" : execution.action.status === "timed_out" ? "timed_out" : "failed";
            failure = { code: execution.action.failure?.code ?? "HOUSE_CRAFTING_FAILED", message: execution.action.failure?.message ?? verification.evidence };
            return await finish();
          }
        } catch (error) {
          status = "failed";
          failure = { code: "HOUSE_CRAFTING_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
          return await finish();
        }
        world = await this.runtime.observeIfStale(0) ?? world;
        planks = inventoryCount(world.state, task.materialName);
      }
      if (planks < structure.length) {
        status = "blocked";
        failure = { code: "HOUSE_MATERIALS_MISSING", message: `The house needs ${structure.length} ${task.materialName}; only ${planks} are available after safe material preparation.` };
        return await finish();
      }

      const moveToPerimeter = async (target: HouseCell, force = false): Promise<boolean> => {
        world = await this.runtime.observeIfStale(0) ?? world;
        if (!force && outsideFootprint(world.state.player.position) && blockDistance(world.state, target) <= PLACEMENT_REACH) return true;
        const clampX = Math.max(xMin, Math.min(xMax, target.x));
        const clampZ = Math.max(zMin, Math.min(zMax, target.z));
        const candidates = [
          { x: xMin - 1, y: yMin, z: clampZ },
          { x: xMax + 1, y: yMin, z: clampZ },
          { x: clampX, y: yMin, z: zMin - 1 },
          { x: clampX, y: yMin, z: zMax + 1 },
        ].filter((candidate) => Math.hypot(
          target.x - candidate.x,
          target.y + 0.5 - candidate.y,
          target.z - candidate.z,
        ) <= PLACEMENT_REACH)
          .sort((a, b) => blockDistance(world.state, a) - blockDistance(world.state, b));
        for (const candidate of candidates) {
          const movement = await executeNavigation(candidate, "operator-chat:build-house-safe-perimeter");
          world = movement.world ?? world;
          if (movement.ok && outsideFootprint(world.state.player.position) && blockDistance(world.state, target) <= PLACEMENT_REACH) return true;
        }
        return false;
      };

      const buildLayer = async (cells: readonly HouseCell[], allowInterior: boolean): Promise<boolean> => {
        for (const cell of cells) {
          if (this.options.shouldStop?.()) {
            status = "aborted";
            failure = { code: "OPERATOR_STOP", message: this.options.shouldStop() ?? "Operator stopped house construction." };
            return false;
          }
          if (clock() >= deadline) {
            status = "timed_out";
            failure = { code: "TASK_DEADLINE", message: "House construction exceeded its overall time budget." };
            return false;
          }
          if (calls >= task.maxActions) {
            status = "max_actions";
            failure = { code: "MAX_ACTIONS", message: `House construction reached its action limit (${task.maxActions}) after placing ${completed}/${structure.length} blocks.` };
            return false;
          }
          const nextWorld = await this.runtime.observeIfStale(0);
          if (!nextWorld || nextWorld.sessionId !== this.runtime.session?.id) {
            status = "disconnected";
            failure = { code: "WORLD_STATE_UNAVAILABLE", message: "The live player/world state disappeared during construction." };
            return false;
          }
          world = nextWorld;
          if (world.state.player.alive !== true) {
            status = world.state.player.alive === false ? "aborted" : "blocked";
            failure = {
              code: world.state.player.alive === false ? "PLAYER_DEAD" : "PLAYER_LIFE_UNCONFIRMED",
              message: "The player's living state is no longer confirmed; construction stopped.",
            };
            return false;
          }
          if (world.state.player.dimension !== "overworld" || (world.state.player.gameMode !== "survival" && world.state.player.gameMode !== "hardcore")) {
            status = "blocked";
            failure = { code: "HOUSE_SESSION_UNSAFE", message: "The confirmed overworld survival session changed; construction stopped." };
            return false;
          }
          if (world.state.player.health === null || world.state.player.health < REQUIRED_HEALTH) {
            status = "blocked";
            failure = { code: "HOUSE_HEALTH_FLOOR", message: "Health is unknown or below the construction floor; no further blocks will be placed." };
            return false;
          }
          if (world.state.player.food === null || world.state.player.food < 6) {
            status = "blocked";
            failure = { code: "HOUSE_HUNGER_TOO_LOW", message: "Hunger fell below six; construction stopped until food is restored." };
            return false;
          }
          if (world.state.player.inWater === true || world.state.player.headInWater === true) {
            status = "blocked";
            failure = { code: "UNSAFE_BUILD_POSITION", message: "The player entered water; house construction stopped." };
            return false;
          }
          if (world.state.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && entity.distance <= task.dangerRadius)) {
            status = "blocked";
            failure = { code: "HOUSE_BUILD_THREAT", message: "A hostile entered the build radius; house construction stopped immediately." };
            return false;
          }
          if (otherEntityAt(world.state, cell)) {
            status = "blocked";
            failure = { code: "HOUSE_CELL_OCCUPIED_BY_ENTITY", message: `An entity entered ${cellKey(cell)}; construction stopped before placing there.` };
            return false;
          }
          if (!allowInterior && !outsideFootprint(world.state.player.position)) {
            status = "blocked";
            failure = { code: "PLAYER_OVER_BUILD_SITE", message: "The player entered the house footprint before the roof stage; further placement stopped." };
            return false;
          }
          if (allowInterior && outsideFootprint(world.state.player.position)) {
            status = "blocked";
            failure = { code: "PLAYER_LEFT_HOUSE_INTERIOR", message: "The player left the protected interior during roof placement; construction stopped." };
            return false;
          }
          decisions += 1;
          if (blockDistance(world.state, cell) > PLACEMENT_REACH && !allowInterior) {
            const moved = await moveToPerimeter(cell, true);
            if (!moved) {
              status = "blocked";
              failure = { code: "HOUSE_CANNOT_REACH_CELL", message: `Could not reach ${cell.role} cell ${cellKey(cell)} from a safe position outside the footprint.` };
              return false;
            }
            world = await this.runtime.observeIfStale(0) ?? world;
          }
          const current = await inspect(cell);
          if (!current.ok) {
            status = current.code === "TASK_DEADLINE" ? "timed_out" : current.code === "MAX_ACTIONS" ? "max_actions" : current.code === "OPERATOR_STOP" ? "aborted" : "blocked";
            failure = { code: current.code, message: `Could not recheck ${cell.role} destination ${cellKey(cell)}: ${current.message}` };
            return false;
          }
          if (!(current.cell.name === "air" || current.cell.name.endsWith("_air"))) {
            status = "blocked";
            failure = { code: "HOUSE_TARGET_CHANGED", message: `${cellKey(cell)} became ${current.cell.name}; the changed site is not overwritten.` };
            return false;
          }
          const input = { x: cell.x, y: cell.y, z: cell.z, blockName: task.materialName, dangerRadius: task.dangerRadius };
          try {
            const execution = await this.skills.run("minecraft.place-block", input, {
              source: `operator-chat:build-house-${cell.role}`,
              timeoutMs: Math.min(30_000, Math.max(1_000, deadline - clock())),
            });
            calls += 1;
            const verification = execution.action.confirmed
              ? verifySkillPostcondition("minecraft.place-block", input, execution.observationBefore?.state ?? world.state, execution.observationAfter?.state ?? this.runtime.currentWorldState?.state ?? null)
              : { verified: false, evidence: execution.action.failure?.message ?? "The adapter did not confirm the placement." };
            await record("minecraft.place-block", execution, verification.verified, verification.evidence, cell);
            if (execution.action.status !== "succeeded" || !execution.action.confirmed || verification.verified !== true) {
              status = execution.action.failure?.code?.startsWith("SAFETY_") ? "blocked" : execution.action.status === "timed_out" ? "timed_out" : "failed";
              failure = {
                code: execution.action.failure?.code ?? (verification.verified === false ? "UNVERIFIED_POSTCONDITION" : "HOUSE_PLACEMENT_FAILED"),
                message: execution.action.failure?.message ?? verification.evidence,
              };
              return false;
            }
            completed += 1;
          } catch (error) {
            status = "failed";
            failure = { code: "HOUSE_PLACEMENT_EXCEPTION", message: error instanceof Error ? error.message : String(error) };
            return false;
          }
        }
        return true;
      };

      if (!outsideFootprint(world.state.player.position)) {
        const moved = await moveToPerimeter({ ...layout.floor[0]!, role: "floor" });
        if (!moved) {
          status = "blocked";
          failure = { code: "HOUSE_NO_SAFE_EXIT", message: "Could not reach a verified position outside the house footprint; no blocks were changed." };
          return await finish();
        }
      }
      if (!(await buildLayer(layout.floor, false))) return await finish();
      if (!(await buildLayer(layout.walls, false))) return await finish();

      // Enter through the deliberately open two-block doorway before the roof is built. This keeps
      // every ceiling cell within placement reach without building temporary scaffolding.
      const interior = { x: xMin + 2, y: yMin + 1, z: zMin + 1 };
      let entered = false;
      for (const candidate of [interior, { x: xMin + 2, y: yMin + 1, z: zMin + 2 }]) {
        const movement = await executeNavigation(candidate, "operator-chat:build-house-enter-interior");
        world = movement.world ?? world;
        const position = world.state.player.position;
        if (movement.ok && Math.floor(position.x) > xMin && Math.floor(position.x) < xMax && Math.floor(position.z) > zMin && Math.floor(position.z) < zMax) {
          entered = true;
          break;
        }
      }
      if (!entered) {
        status = "blocked";
        failure = { code: "HOUSE_INTERIOR_UNREACHABLE", message: "The entrance could not be traversed safely; walls remain as built and the roof was not started." };
        return await finish();
      }
      if (!(await buildLayer(layout.roof, true))) return await finish();
      if (completed === structure.length) {
        status = "succeeded";
        failure = null;
      } else {
        status = "failed";
        failure = { code: "HOUSE_INCOMPLETE", message: `Only ${completed}/${structure.length} planned house blocks were verified.` };
      }
      return await finish();
    } catch (error) {
      this.logger.error({ err: error, taskId: task.id }, "Starter house runner failed");
      status = this.runtime.adapter.status === "connected" ? "failed" : "disconnected";
      failure = { code: "HOUSE_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error) };
      return await finish();
    }
  }
}
