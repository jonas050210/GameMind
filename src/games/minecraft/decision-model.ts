import type {
  DecisionCandidate,
  DecisionContext,
  DecisionModel,
  DecisionRecord,
} from "../../core/decision-model.js";
import {
  minecraftLogNames,
  minecraftPlankNames,
} from "./capabilities.js";
import {
  distanceBetween,
  isRipeBerryBush,
  isResourceBlockName,
} from "./block-classes.js";
import { chooseExplorationWaypoint } from "./exploration.js";
import type { MinecraftObservation } from "./observation.js";
import type { CraftItemTask, GatherResourceTask, MinecraftTask } from "./task.js";
import type { CraftableMinecraftItem } from "./recipes.js";
import {
  countItemAndEquipment,
  isMinecraftFoodName,
  isMinecraftLogName,
  minecraftFoodNutrition,
  minecraftWoodRecipePlans,
  plankNameForLog,
} from "./recipes.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { blockKey, WorldMemory, type ItemSighting } from "./world-memory.js";
export { isHostileMinecraftEntity } from "./threats.js";

const FOOD_PRIORITY_THRESHOLD = 10;
const LOW_FOOD_EXPLORATION_THRESHOLD = 6;
const CRITICAL_FOOD_THRESHOLD = 4;
const REGEN_FOOD_THRESHOLD = 18;
const REST_HEALTH_THRESHOLD = 12;
const REST_TARGET_HEALTH = 16;
const REST_CHUNK_MS = 10_000;
const CRITICAL_HEALTH_THRESHOLD = 6;
const MAX_CRAFTING_TABLE_DISTANCE = 4.5;
const HYSTERESIS_BONUS = 25;
/** Axis-aligned recovery waypoints sit this many blocks away: far enough to change the shortest route. */
const SIDESTEP_DISTANCE = 6;
const MAX_PLAN_STEPS = 12;
/** Remembered targets up to this far beyond the collection limit are approached before collecting. */
const APPROACH_EXTRA_RANGE = 32;

/** Priority bands: lower bands always win. Progress never outranks a survival or safety need. */
export const BAND_SAFETY = 0;
export const BAND_SURVIVAL = 1;
export const BAND_PROGRESS = 2;

export interface MinecraftDecisionContext extends DecisionContext {
  /** Accumulated belief state. When absent, the decision uses only the current observation. */
  readonly memory?: WorldMemory;
  /** Where the task started; bounds exploration. Defaults to the current position. */
  readonly origin?: { readonly x: number; readonly z: number };
  /** Skills registered for this adapter. Candidates for absent skills are never offered. */
  readonly availableSkills?: ReadonlySet<string>;
  readonly explorationLegsUsed?: number;
  readonly restMsUsed?: number;
  readonly previousGoalKey?: string | null;
  /** Set by the runner after a stall or oscillation to request a sidestep recovery. */
  readonly stuck?: {
    readonly reason: string;
    /** Where the stall happened. */
    readonly at: { readonly x: number; readonly z: number };
    /** The goal that could not be reached, when known; sidesteps are chosen to approach it from another side. */
    readonly toward?: { readonly x: number; readonly z: number } | null;
  } | null;
}

export interface MinecraftDecisionRecord extends DecisionRecord {
  /** Projected remaining steps toward the goal. Descriptive; each step is re-decided from fresh state. */
  readonly plan: readonly string[];
  readonly band: number | null;
  readonly knowledge: ReturnType<WorldMemory["summary"]>;
}

interface KnownBlock {
  readonly key: string;
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly ripe: boolean | null;
  readonly distance: number;
}

interface Threats {
  readonly visibleHostiles: MinecraftObservation["entities"];
  readonly nearby: MinecraftObservation["entities"];
}

function inventoryCount(state: MinecraftObservation, itemName: string): number {
  return state.inventory
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

function itemCount(state: MinecraftObservation, itemName: string): number {
  return countItemAndEquipment(state.inventory, state.equipment, itemName);
}

function totalPlanks(state: MinecraftObservation): number {
  return minecraftPlankNames.reduce((sum, name) => sum + inventoryCount(state, name), 0);
}

function centerOf(position: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 };
}

function positionKey(position: { x: number; y: number; z: number }): string {
  return blockKey({ x: position.x, y: position.y, z: position.z });
}

function distance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function available(context: MinecraftDecisionContext, skillId: string): boolean {
  return context.availableSkills === undefined || context.availableSkills.has(skillId);
}

function isExcluded(context: MinecraftDecisionContext, key: string | null): boolean {
  return key !== null && context.excludedTargets.has(key);
}

function solidKeys(state: MinecraftObservation): Set<string> {
  const keys = new Set<string>();
  for (const block of state.nearbyBlocks) {
    if (block.boundingBox === "block") keys.add(positionKey(block.position));
  }
  return keys;
}

/** Counts solid, observed blocks on the feet-level line from `from` to `to` (a route-quality hint). */
function blockedRouteCount(
  solids: ReadonlySet<string>,
  from: { x: number; y: number; z: number },
  to: { x: number; z: number },
): number {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(length));
  const feetY = Math.floor(from.y);
  let blocked = 0;
  let previous = "";
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.floor(from.x + ((to.x - from.x) * step) / steps);
    const z = Math.floor(from.z + ((to.z - from.z) * step) / steps);
    const key = `${x},${feetY},${z}`;
    if (key !== previous && solids.has(key)) blocked += 1;
    previous = key;
  }
  return blocked;
}

function assessThreats(state: MinecraftObservation, memory: WorldMemory, dangerRadius: number): Threats {
  const visibleHostiles = state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type));
  const approachingIds = new Set(
    memory
      .hostileSightings()
      .filter((hostile) => hostile.approaching && hostile.distance <= dangerRadius * 2)
      .map((hostile) => hostile.id),
  );
  const nearby = visibleHostiles.filter(
    (entity) => distance(entity.position, state.player.position) <= dangerRadius || (approachingIds.has(entity.id) && entity.distance <= dangerRadius * 1.5),
  );
  return { visibleHostiles, nearby };
}

function knownBlocks(state: MinecraftObservation, memory: WorldMemory, names: ReadonlySet<string>): KnownBlock[] {
  const byKey = new Map<string, KnownBlock>();
  const player = state.player.position;
  const add = (name: string, position: { x: number; y: number; z: number }, ripe: boolean | null): void => {
    if (!names.has(name)) return;
    const key = positionKey(position);
    const existing = byKey.get(key);
    byKey.set(key, {
      key,
      name,
      position: { x: position.x, y: position.y, z: position.z },
      ripe: ripe ?? existing?.ripe ?? null,
      distance: distanceBetween(centerOf(position), player),
    });
  };
  for (const sighting of memory.blockSightings(names)) add(sighting.name, sighting.position, sighting.ripe);
  for (const block of state.nearbyBlocks) {
    if (isResourceBlockName(block.name)) add(block.name, block.position, null);
  }
  for (const sighting of state.resourceSightings) {
    const ripe =
      sighting.properties !== undefined ? isRipeBerryBush(sighting.name, sighting.properties) : null;
    add(sighting.name, sighting.position, ripe);
  }
  return [...byKey.values()].sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key));
}

function knownFoodItems(state: MinecraftObservation, memory: WorldMemory): ItemSighting[] {
  const byKey = new Map<string, ItemSighting>();
  for (const item of memory.foodItemSightings()) byKey.set(item.key, item);
  for (const drop of state.itemDrops) {
    if (!isMinecraftFoodName(drop.name)) continue;
    const blockPosition = {
      x: Math.floor(drop.position.x),
      y: Math.floor(drop.position.y),
      z: Math.floor(drop.position.z),
    };
    const key = `${drop.name}@${blockKey(blockPosition)}`;
    byKey.set(key, {
      key,
      name: drop.name,
      count: drop.count,
      position: drop.position,
      blockPosition,
      lastSeenSequence: Number.POSITIVE_INFINITY,
    });
  }
  return [...byKey.values()];
}

function nearbyDanger(
  point: { x: number; y: number; z: number },
  hostiles: MinecraftObservation["entities"],
  radius: number,
): boolean {
  return hostiles.some((hostile) => distance(hostile.position, point) <= radius);
}

function fleeCandidates(
  state: MinecraftObservation,
  threats: MinecraftObservation["entities"],
  context: MinecraftDecisionContext,
): DecisionCandidate[] {
  const player = state.player.position;
  if (threats.length === 0) return [];

  const averageThreatX = threats.reduce((sum, threat) => sum + threat.position.x, 0) / threats.length;
  const averageThreatZ = threats.reduce((sum, threat) => sum + threat.position.z, 0) / threats.length;
  let awayX = player.x - averageThreatX;
  let awayZ = player.z - averageThreatZ;
  if (Math.hypot(awayX, awayZ) < 0.001) {
    awayX = 1;
    awayZ = 0;
  }
  const baseAngle = Math.atan2(awayZ, awayX);
  const solids = solidKeys(state);
  const candidates: Array<{ x: number; z: number; score: number; blocked: number }> = [];

  for (let index = 0; index < 8; index += 1) {
    const angle = baseAngle + (index * Math.PI) / 4;
    const x = Math.round(player.x + Math.cos(angle) * 9);
    const z = Math.round(player.z + Math.sin(angle) * 9);
    const minThreatDistance = Math.min(
      ...threats.map((threat) => Math.hypot(x + 0.5 - threat.position.x, z + 0.5 - threat.position.z)),
    );
    const travelDistance = Math.hypot(x + 0.5 - player.x, z + 0.5 - player.z);
    const blocked = blockedRouteCount(solids, player, { x: x + 0.5, z: z + 0.5 });
    candidates.push({ x, z, score: minThreatDistance - travelDistance * 0.1 - blocked * 1.5, blocked });
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.x - right.x || left.z - right.z)
    .map((candidate, index) => ({
      goalId: "avoid-nearby-hostile",
      priorityBand: BAND_SAFETY,
      score: 1_000 + candidate.score - index * 0.01,
      skillId: "minecraft.navigate",
      input: { x: candidate.x, y: Math.floor(player.y), z: candidate.z, range: 1 },
      targetKey: `flee:${candidate.x},${Math.floor(player.y)},${candidate.z}`,
      rationale: `Move away from ${threats.length} visible hostile entit${threats.length === 1 ? "y" : "ies"}; conservative navigation avoids digging and building (${candidate.blocked} observed solid blocks on the route).`,
    }))
    .filter((candidate) => !isExcluded(context, candidate.targetKey))
    .filter((candidate) => available(context, candidate.skillId ?? ""))
    .slice(0, 3);
}

/**
 * Sidestep waypoints used to break out of a stall or an oscillation. The blocked cell is unobservable,
 * so it is estimated as the neighbouring cell that most reduces the distance to the goal.
 *
 * Sidesteps are axis-aligned on purpose: a straight move has exactly one shortest route, whereas a
 * diagonal move has several equally short routes and a shortest-path planner may pick the one
 * through the blocked cell. A candidate is rejected when its straight route crosses that cell.
 */
function recoveryCandidates(
  state: MinecraftObservation,
  context: MinecraftDecisionContext,
  dangerRadius: number,
): DecisionCandidate[] {
  const stuck = context.stuck;
  if (!stuck) return [];
  const player = state.player.position;
  const solids = solidKeys(state);
  const hostiles = state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type));
  const playerCellX = Math.floor(player.x);
  const playerCellZ = Math.floor(player.z);
  const goal = stuck.toward ?? null;
  const stallCell = goal
    ? [
        { x: playerCellX + 1, z: playerCellZ },
        { x: playerCellX - 1, z: playerCellZ },
        { x: playerCellX, z: playerCellZ + 1 },
        { x: playerCellX, z: playerCellZ - 1 },
      ]
        .map((cell) => ({ ...cell, toGoal: Math.hypot(goal.x - (cell.x + 0.5), goal.z - (cell.z + 0.5)) }))
        .sort((left, right) => left.toGoal - right.toGoal || left.x - right.x || left.z - right.z)[0]
    : undefined;
  const candidates: Array<DecisionCandidate & { readonly progress: number }> = [];
  for (const [dx, dz] of [[0, -1], [0, 1], [1, 0], [-1, 0]] as const) {
    const x = playerCellX + dx * SIDESTEP_DISTANCE;
    const z = playerCellZ + dz * SIDESTEP_DISTANCE;
    const key = `recover:${x},${z}`;
    if (isExcluded(context, key)) continue;
    if (nearbyDanger({ x: x + 0.5, y: player.y, z: z + 0.5 }, hostiles, dangerRadius)) continue;
    // The straight route must not cross the estimated blocked cell.
    const routeCrossesStall = stallCell !== undefined && Array.from({ length: SIDESTEP_DISTANCE }, (_, step) => step + 1).some(
      (step) => playerCellX + dx * step === stallCell.x && playerCellZ + dz * step === stallCell.z,
    );
    if (routeCrossesStall) continue;
    const blocked = blockedRouteCount(solids, player, { x: x + 0.5, z: z + 0.5 });
    const progress = goal ? Math.hypot(goal.x - (x + 0.5), goal.z - (z + 0.5)) : 0;
    candidates.push({
      goalId: "recover:sidestep",
      priorityBand: BAND_SAFETY,
      score: 950 - blocked * 4 - progress * 0.5,
      skillId: "minecraft.navigate",
      input: { x, y: Math.floor(player.y), z, range: 1 },
      targetKey: key,
      rationale: `Recover from ${stuck.reason} with an alternative straight route that avoids the stalled segment (${blocked} observed solid blocks on the route).`,
      progress,
    });
  }
  return candidates
    .sort((left, right) => right.score - left.score || (left.targetKey ?? "").localeCompare(right.targetKey ?? ""))
    .slice(0, 2)
    .map(({ progress: _progress, ...candidate }) => candidate);
}

function needsFood(state: MinecraftObservation, task: MinecraftTask): boolean {
  const hunger = state.player.food;
  if (hunger === null || hunger >= 20) return false;
  if (task.kind === "secure_food") return hunger < task.targetHunger;
  const health = state.player.health;
  return (
    hunger <= FOOD_PRIORITY_THRESHOLD ||
    (health !== null && health <= REST_HEALTH_THRESHOLD && hunger < REGEN_FOOD_THRESHOLD)
  );
}

function eatCandidate(state: MinecraftObservation, context: MinecraftDecisionContext): DecisionCandidate | null {
  const hunger = state.player.food;
  if (hunger === null || hunger >= 20 || !available(context, "minecraft.eat-food")) return null;
  const options = state.inventory
    .filter((item) => isMinecraftFoodName(item.name) && item.count > 0)
    .map((item) => ({ item, nutrition: minecraftFoodNutrition[item.name as keyof typeof minecraftFoodNutrition] }))
    .filter(({ item }) => !isExcluded(context, `eat:${item.name}`))
    .sort((left, right) => {
      const leftWaste = Math.max(0, left.nutrition - (20 - hunger));
      const rightWaste = Math.max(0, right.nutrition - (20 - hunger));
      return leftWaste - rightWaste || right.nutrition - left.nutrition || left.item.name.localeCompare(right.item.name);
    });
  const selected = options[0];
  if (!selected) return null;
  return {
    goalId: "restore-hunger",
    priorityBand: BAND_SURVIVAL,
    score: 900 + selected.nutrition,
    skillId: "minecraft.eat-food",
    input: { item: selected.item.name },
    targetKey: `eat:${selected.item.name}`,
    rationale: `Hunger is ${hunger}/20; consume available ${selected.item.name} before non-survival progress.`,
  };
}

/** Food sources that are observed and reachable without combat: dropped food and ripe berries. */
function foodSourceCandidates(
  state: MinecraftObservation,
  memory: WorldMemory,
  task: MinecraftTask,
  threats: Threats,
  context: MinecraftDecisionContext,
): DecisionCandidate[] {
  const player = state.player.position;
  const candidates: DecisionCandidate[] = [];
  const dangerRadius = task.dangerRadius;
  const maxDistance = task.maxTargetDistance;

  if (available(context, "minecraft.pickup-item")) {
    for (const item of knownFoodItems(state, memory)) {
      const itemCenter = { x: item.position.x, y: item.position.y, z: item.position.z };
      const targetDistance = distance(itemCenter, player);
      if (targetDistance > maxDistance) {
        const approach = approachCandidate(
          { name: item.name, key: `item:${item.key}`, position: item.blockPosition, distance: targetDistance },
          task,
          threats,
          context,
          BAND_SURVIVAL,
          "approach:item",
          `dropped ${item.name}`,
        );
        if (approach) candidates.push(approach);
        continue;
      }
      if (nearbyDanger(itemCenter, threats.visibleHostiles, dangerRadius)) continue;
      const targetKey = `item:${item.key}`;
      if (isExcluded(context, targetKey)) continue;
      candidates.push({
        goalId: `pickup:${item.name}`,
        priorityBand: BAND_SURVIVAL,
        score: 800 - targetDistance,
        skillId: "minecraft.pickup-item",
        input: {
          x: item.blockPosition.x,
          y: item.blockPosition.y,
          z: item.blockPosition.z,
          itemName: item.name,
          dangerRadius,
        },
        targetKey,
        rationale: `Walk onto the observed dropped ${item.name} (${targetDistance.toFixed(1)} blocks away) to pick it up.`,
      });
    }
  }

  if (available(context, "minecraft.harvest-berries")) {
    for (const bush of knownBlocks(state, memory, new Set(["sweet_berry_bush"]))) {
      if (bush.ripe !== true) continue;
      if (bush.distance > maxDistance) {
        const approach = approachCandidate(
          { name: "sweet_berry_bush", key: `berry:${bush.key}`, position: bush.position, distance: bush.distance },
          task,
          threats,
          context,
          BAND_SURVIVAL,
          "approach:berry",
          "ripe sweet berry bush",
        );
        if (approach) candidates.push(approach);
        continue;
      }
      if (nearbyDanger(centerOf(bush.position), threats.visibleHostiles, dangerRadius)) continue;
      const targetKey = `berry:${bush.key}`;
      if (isExcluded(context, targetKey)) continue;
      candidates.push({
        goalId: "harvest:sweet_berry_bush",
        priorityBand: BAND_SURVIVAL,
        score: 700 - bush.distance,
        skillId: "minecraft.harvest-berries",
        input: { x: bush.position.x, y: bush.position.y, z: bush.position.z, dangerRadius },
        targetKey,
        rationale: `Harvest the ripe sweet berry bush ${bush.distance.toFixed(1)} blocks away (age-checked before acting).`,
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score || (left.targetKey ?? "").localeCompare(right.targetKey ?? ""));
}

function explorationCandidate(
  state: MinecraftObservation,
  memory: WorldMemory,
  task: MinecraftTask,
  threats: Threats,
  context: MinecraftDecisionContext,
  purpose: "food" | "resource",
): DecisionCandidate | null {
  if (!available(context, "minecraft.navigate")) return null;
  const legsUsed = context.explorationLegsUsed ?? 0;
  if (legsUsed >= task.maxExplorationLegs) return null;
  const player = state.player.position;
  // A visible hostile this close makes wandering into unknown terrain the wrong move; farther
  // hostiles are handled by the waypoint scoring, which avoids remembered hostile positions.
  if (threats.visibleHostiles.some((hostile) => distance(hostile.position, player) <= task.dangerRadius * 2)) return null;
  const origin = context.origin ?? { x: player.x, z: player.z };
  const waypoint = chooseExplorationWaypoint(memory, {
    from: { x: player.x, z: player.z },
    origin,
    maxRadius: task.explorationRadius,
    minLeg: 12,
    maxLeg: 40,
    hostileAvoidRadius: task.dangerRadius + 4,
    excludedKeys: context.excludedTargets,
  });
  if (!waypoint) return null;
  const legsLeft = task.maxExplorationLegs - legsUsed;
  return {
    goalId: purpose === "food" ? "explore:food" : "explore:resource",
    priorityBand: purpose === "food" ? BAND_SURVIVAL : BAND_PROGRESS,
    score: (purpose === "food" ? 600 : 300) - waypoint.distance / 10,
    skillId: "minecraft.navigate",
    input: { x: waypoint.x, y: Math.floor(player.y), z: waypoint.z, range: 3 },
    targetKey: waypoint.key,
    rationale: `Explore toward unexplored coverage ${waypoint.distance.toFixed(0)} blocks away (${legsLeft} exploration leg${legsLeft === 1 ? "" : "s"} left) to find ${purpose === "food" ? "food" : "the required resource"}.`,
  };
}

function restCandidate(
  state: MinecraftObservation,
  task: MinecraftTask,
  threats: Threats,
  context: MinecraftDecisionContext,
): DecisionCandidate | null {
  const health = state.player.health;
  const food = state.player.food;
  if (health === null || health > REST_HEALTH_THRESHOLD) return null;
  if (food === null || food < REGEN_FOOD_THRESHOLD) return null;
  if (!available(context, "minecraft.rest") || threats.visibleHostiles.length > 0) return null;
  const restUsed = context.restMsUsed ?? 0;
  const budget = task.maxRestMs - restUsed;
  if (budget < 1_000) return null;
  return {
    goalId: "rest:recover-health",
    priorityBand: BAND_SURVIVAL,
    score: 500 + (REST_HEALTH_THRESHOLD - health) * 2,
    skillId: "minecraft.rest",
    input: { durationMs: Math.min(REST_CHUNK_MS, budget), targetHealth: REST_TARGET_HEALTH, dangerRadius: task.dangerRadius },
    targetKey: null,
    rationale: `Health is ${health}/20 with food ${food}/20; stand still in a hostile-free state so natural regeneration can work (${Math.round(budget / 1000)} s of rest budget left).`,
  };
}

function gatherCandidates(
  state: MinecraftObservation,
  memory: WorldMemory,
  task: GatherResourceTask,
  threats: Threats,
  context: MinecraftDecisionContext,
): { candidates: DecisionCandidate[]; threatened: number; beyond: number; tried: number; known: number } {
  const blocks = knownBlocks(state, memory, new Set([task.resourceName]));
  let threatened = 0;
  let beyond = 0;
  let tried = 0;
  const candidates: DecisionCandidate[] = [];
  const currentCount = itemCount(state, task.resourceName);
  for (const block of blocks) {
    if (context.excludedTargets.has(block.key)) {
      tried += 1;
      continue;
    }
    if (nearbyDanger(centerOf(block.position), threats.visibleHostiles, task.dangerRadius)) {
      threatened += 1;
      continue;
    }
    if (block.distance > task.maxTargetDistance) {
      beyond += 1;
      const approach = approachCandidate(
        { name: block.name, key: block.key, position: block.position, distance: block.distance },
        task,
        threats,
        context,
        BAND_PROGRESS,
        "approach",
        task.resourceName,
      );
      if (approach) candidates.push(approach);
      continue;
    }
    candidates.push({
      goalId: `collect:${task.resourceName}`,
      priorityBand: BAND_PROGRESS,
      score: 500 - block.distance,
      skillId: "minecraft.collect-log",
      input: { ...block.position, blockName: task.resourceName, dangerRadius: task.dangerRadius },
      targetKey: block.key,
      rationale: `Collect the nearest observed ${task.resourceName} (${block.distance.toFixed(1)} blocks away); inventory has ${currentCount}/${task.targetCount}.`,
    });
  }
  candidates.sort((left, right) => right.score - left.score || (left.targetKey ?? "").localeCompare(right.targetKey ?? ""));
  return { candidates, threatened, beyond, tried, known: blocks.length };
}

function nearbySafeLogs(
  known: readonly KnownBlock[],
  task: CraftItemTask,
  threats: Threats,
  context: MinecraftDecisionContext,
  wantedLogNames: ReadonlySet<string> | null,
): KnownBlock[] {
  return known
    .filter((block) => isMinecraftLogName(block.name))
    .filter((block) => !wantedLogNames || wantedLogNames.has(block.name))
    .filter((block) => !context.excludedTargets.has(block.key))
    .filter((block) => block.distance <= task.maxTargetDistance)
    .filter((block) => !nearbyDanger(centerOf(block.position), threats.visibleHostiles, task.dangerRadius));
}

/**
 * A remembered target beyond the collection limit cannot be collected from here. Walking toward it
 * (within a bounded radius of the task origin) is the progress step; the collection then runs when
 * the target is in range and has been re-observed.
 */
function approachCandidate(
  target: { readonly name: string; readonly key: string; readonly position: { x: number; y: number; z: number }; readonly distance: number },
  task: MinecraftTask,
  threats: Threats,
  context: MinecraftDecisionContext,
  band: number,
  goalPrefix: string,
  rationaleSubject: string,
): DecisionCandidate | null {
  if (target.distance <= task.maxTargetDistance || target.distance > task.maxTargetDistance + APPROACH_EXTRA_RANGE) return null;
  if (nearbyDanger(centerOf(target.position), threats.visibleHostiles, task.dangerRadius)) return null;
  const origin = context.origin;
  if (origin && Math.hypot(target.position.x - origin.x, target.position.z - origin.z) > task.explorationRadius + 16) return null;
  const targetKey = `approach:${target.key}`;
  if (isExcluded(context, targetKey)) return null;
  return {
    goalId: `${goalPrefix}:${target.name}`,
    priorityBand: band,
    score: 350 - target.distance,
    skillId: "minecraft.navigate",
    input: { x: target.position.x, y: target.position.y, z: target.position.z, range: 3 },
    targetKey,
    rationale: `The remembered ${rationaleSubject} is ${target.distance.toFixed(1)} blocks away, beyond the ${task.maxTargetDistance}-block collection limit; approach it before collecting.`,
  };
}

function craftCandidate(item: CraftableMinecraftItem, count: number, table?: { x: number; y: number; z: number }): DecisionCandidate {
  return {
    goalId: `craft:${item}`,
    priorityBand: BAND_PROGRESS,
    score: 500,
    skillId: "minecraft.craft-item",
    input: { item, count, ...(table ? { craftingTable: table } : {}) },
    targetKey: `craft:${item}:${count}`,
    rationale: `Craft the next allowlisted prerequisite (${item}) from observed inventory and recipe requirements.`,
  };
}

function craftingTableCandidate(
  known: readonly KnownBlock[],
  task: CraftItemTask,
  threats: Threats,
  context: MinecraftDecisionContext,
): DecisionCandidate | null {
  const tables = known
    .filter((block) => block.name === "crafting_table")
    .filter((block) => !nearbyDanger(centerOf(block.position), threats.visibleHostiles, task.dangerRadius))
    .filter((block) => block.distance <= task.maxTargetDistance);
  const distant = tables.find((block) => !context.excludedTargets.has(`craft-table:${block.key}`));
  if (!distant) return null;
  const { x, y, z } = distant.position;
  return {
    goalId: "reach-crafting-table",
    priorityBand: BAND_PROGRESS,
    score: 450 - distant.distance,
    skillId: "minecraft.navigate",
    input: { x, y, z, range: 1 },
    targetKey: `craft-table:${distant.key}`,
    rationale: `Navigate to the nearest observed crafting table (${distant.distance.toFixed(1)} blocks away) before crafting a table-required item.`,
  };
}

function placementCandidate(
  state: MinecraftObservation,
  task: CraftItemTask,
  threats: Threats,
  context: MinecraftDecisionContext,
): DecisionCandidate | null {
  const player = state.player.position;
  const blocksByPosition = new Map(state.nearbyBlocks.map((block) => [positionKey(block.position), block]));
  const supportBlocks = state.nearbyBlocks
    .filter((block) => block.boundingBox === "block")
    .map((support) => ({
      support,
      target: { x: support.position.x, y: support.position.y + 1, z: support.position.z },
    }))
    .filter(({ target }) => !blocksByPosition.has(positionKey(target)))
    .map((candidate) => ({
      ...candidate,
      distance: distance(player, candidate.target),
      targetDistanceFromPlayer: Math.hypot(player.x - (candidate.target.x + 0.5), player.z - (candidate.target.z + 0.5)),
    }))
    .filter(({ distance: targetDistance }) => targetDistance <= MAX_CRAFTING_TABLE_DISTANCE)
    .filter(({ targetDistanceFromPlayer }) => targetDistanceFromPlayer >= 0.9)
    .filter(({ target }) => !nearbyDanger({ x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }, threats.visibleHostiles, task.dangerRadius))
    .filter(({ target }) => !context.excludedTargets.has(`place-table:${positionKey(target)}`))
    .sort((left, right) => left.distance - right.distance || positionKey(left.target).localeCompare(positionKey(right.target)));
  const chosen = supportBlocks[0];
  if (!chosen) return null;
  return {
    goalId: "place-crafting-table",
    priorityBand: BAND_PROGRESS,
    score: 430 - chosen.distance,
    skillId: "minecraft.place-crafting-table",
    input: { ...chosen.target, dangerRadius: task.dangerRadius },
    targetKey: `place-table:${positionKey(chosen.target)}`,
    rationale: `Place the carried crafting table above observed solid support ${positionKey(chosen.support.position)} after checking the destination is locally unoccupied and outside visible threat range.`,
  };
}

function plankProductionCandidate(
  state: MinecraftObservation,
  known: readonly KnownBlock[],
  task: CraftItemTask,
  threats: Threats,
  context: MinecraftDecisionContext,
  requiredTotalPlanks: number,
): DecisionCandidate | null {
  const currentPlanks = totalPlanks(state);
  if (currentPlanks >= requiredTotalPlanks) return null;
  const shortage = requiredTotalPlanks - currentPlanks;
  const logKinds: readonly (typeof minecraftLogNames)[number][] =
    task.targetItem === "oak_planks" ? ["oak_log"] : minecraftLogNames;
  const availableLogsInInventory = logKinds
    .filter((name) => inventoryCount(state, name) > 0)
    .sort((left, right) => inventoryCount(state, right) - inventoryCount(state, left));
  const candidateLog = availableLogsInInventory[0];
  const candidateLogCount = candidateLog ? inventoryCount(state, candidateLog) : 0;
  const logsNeededForAllMissingPlanks = Math.ceil(shortage / 4);
  const wantedLogs = task.targetItem === "oak_planks" ? new Set<string>(["oak_log"]) : null;
  const visibleLog = nearbySafeLogs(known, task, threats, context, wantedLogs)[0];
  if (!visibleLog && !candidateLog) {
    // Only remembered logs beyond the collection limit remain: walk toward the nearest of them.
    const remembered = known
      .filter((block) => isMinecraftLogName(block.name))
      .filter((block) => !wantedLogs || wantedLogs.has(block.name))
      .sort((left, right) => left.distance - right.distance);
    for (const block of remembered) {
      const approach = approachCandidate(
        { name: block.name, key: block.key, position: block.position, distance: block.distance },
        task,
        threats,
        context,
        BAND_PROGRESS,
        "approach",
        `${block.name} needed for planks`,
      );
      if (approach) return approach;
    }
  }

  if (candidateLog && candidateLogCount >= logsNeededForAllMissingPlanks) {
    const plank = plankNameForLog(candidateLog);
    return notExcluded(craftCandidate(plank, inventoryCount(state, plank) + shortage), context);
  }
  if (visibleLog) {
    return {
      goalId: `collect:${visibleLog.name}`,
      priorityBand: BAND_PROGRESS,
      score: 400 - visibleLog.distance,
      skillId: "minecraft.collect-log",
      input: {
        x: visibleLog.position.x,
        y: visibleLog.position.y,
        z: visibleLog.position.z,
        blockName: visibleLog.name,
        dangerRadius: task.dangerRadius,
      },
      targetKey: visibleLog.key,
      rationale: `Collect the nearest safe observed ${visibleLog.name} needed to satisfy a wood/plank prerequisite (${currentPlanks}/${requiredTotalPlanks} planks currently available).`,
    };
  }
  if (candidateLog) {
    const plank = plankNameForLog(candidateLog);
    const partialOutput = Math.min(shortage, candidateLogCount * 4);
    if (partialOutput > 0) {
      return notExcluded(craftCandidate(plank, inventoryCount(state, plank) + partialOutput), context);
    }
  }
  return null;
}

function notExcluded(candidate: DecisionCandidate, context: MinecraftDecisionContext): DecisionCandidate | null {
  return candidate.targetKey && context.excludedTargets.has(candidate.targetKey) ? null : candidate;
}

function craftPlan(
  state: MinecraftObservation,
  known: readonly KnownBlock[],
  task: CraftItemTask,
  threats: Threats,
  context: MinecraftDecisionContext,
): { candidate: DecisionCandidate | null; reason: string } {
  const targetCount = itemCount(state, task.targetItem);
  const missingTarget = Math.max(0, task.targetCount - targetCount);
  const plan = minecraftWoodRecipePlans[task.targetItem];
  if (!plan) return { candidate: null, reason: `No offline recipe plan is available for '${task.targetItem}'.` };
  const operations = Math.ceil(missingTarget / plan.outputCount);
  if (operations <= 0) return { candidate: null, reason: "Craft target count is already satisfied." };

  const requiresTable = plan.requiresCraftingTable;
  const closeTable = known
    .filter((block) => block.name === "crafting_table")
    .filter((block) => !nearbyDanger(centerOf(block.position), threats.visibleHostiles, task.dangerRadius))
    .filter((block) => block.distance <= MAX_CRAFTING_TABLE_DISTANCE)[0];
  const tableItemCount = inventoryCount(state, "crafting_table");
  const needTable = requiresTable && !closeTable;

  if (needTable) {
    const reachableTable = craftingTableCandidate(known, task, threats, context);
    if (reachableTable) return { candidate: reachableTable, reason: "A safe observed crafting table is too far away; navigate closer first." };
    if (tableItemCount > 0) {
      const placement = placementCandidate(state, task, threats, context);
      if (placement) return { candidate: placement, reason: "Place the crafting table already in inventory on a safe observed support block." };
      return { candidate: null, reason: "A crafting table is in inventory, but no safe visible supported placement cell is available." };
    }
    if (task.targetItem !== "crafting_table") {
      const planks = totalPlanks(state);
      if (planks >= 4) {
        const candidate = notExcluded(craftCandidate("crafting_table", inventoryCount(state, "crafting_table") + 1), context);
        return { candidate, reason: "Craft a table before attempting a 3-by-3 recipe." };
      }
      const plankCandidate = plankProductionCandidate(state, known, task, threats, context, 4);
      return plankCandidate
        ? { candidate: plankCandidate, reason: "Gather or craft planks for the missing crafting-table prerequisite." }
        : { candidate: null, reason: "A crafting table is required but no table, four planks, or safe nearby logs are available." };
    }
  }

  const tableForCraft = closeTable?.position;
  let requiredPlanks = 0;
  let requiredSticks = 0;
  for (const [ingredient, quantity] of Object.entries(plan.ingredients)) {
    if (ingredient === "any_planks") requiredPlanks += quantity * operations;
    else if (ingredient === "stick") requiredSticks += quantity * operations;
  }

  const currentSticks = inventoryCount(state, "stick");
  const missingSticks = Math.max(0, requiredSticks - currentSticks);
  if (missingSticks > 0) {
    const planksForSticks = Math.ceil(missingSticks / 4) * 2;
    if (totalPlanks(state) < planksForSticks) {
      const planksNeededForTarget = requiredPlanks + planksForSticks;
      const candidate = plankProductionCandidate(state, known, task, threats, context, planksNeededForTarget);
      return candidate
        ? { candidate, reason: `Produce ${planksNeededForTarget} planks before crafting the missing sticks.` }
        : { candidate: null, reason: `Missing ${missingSticks} sticks and insufficient planks/logs are available.` };
    }
    const candidate = notExcluded(craftCandidate("stick", currentSticks + missingSticks), context);
    return { candidate, reason: `Craft ${missingSticks} sticks for the target recipe.` };
  }

  const totalPlanksNeeded = requiredPlanks;
  if (totalPlanks(state) < totalPlanksNeeded) {
    const candidate = plankProductionCandidate(state, known, task, threats, context, totalPlanksNeeded);
    return candidate
      ? { candidate, reason: `Produce the remaining planks before crafting ${task.targetItem}.` }
      : { candidate: null, reason: `Missing ${totalPlanksNeeded - totalPlanks(state)} planks and no safe, observed log prerequisite is available.` };
  }

  const specificLog = task.targetItem.endsWith("_planks") ? task.targetItem.replace(/_planks$/, "_log") : null;
  if (specificLog) {
    const exactPlanks = inventoryCount(state, task.targetItem);
    if (exactPlanks < task.targetCount) {
      const logs = inventoryCount(state, specificLog);
      const missingPlanks = task.targetCount - exactPlanks;
      if (logs >= Math.ceil(missingPlanks / 4)) {
        return {
          candidate: notExcluded(craftCandidate(task.targetItem, task.targetCount), context),
          reason: "Craft requested planks from the matching wood type.",
        };
      }
      const log = nearbySafeLogs(known, task, threats, context, new Set([specificLog]))[0];
      if (log) {
        return {
          candidate: {
            goalId: `collect:${specificLog}`,
            priorityBand: BAND_PROGRESS,
            score: 400 - log.distance,
            skillId: "minecraft.collect-log",
            input: { ...log.position, blockName: specificLog, dangerRadius: task.dangerRadius },
            targetKey: log.key,
            rationale: `Collect the nearest safe ${specificLog} to produce the requested plank variant.`,
          },
          reason: "Collect the required matching log before crafting planks.",
        };
      }
      if (logs > 0) {
        return {
          candidate: notExcluded(craftCandidate(task.targetItem, exactPlanks + logs * 4), context),
          reason: "Craft the plank amount supported by current matching logs; stop/replan if the target still lacks material.",
        };
      }
      return { candidate: null, reason: `No ${specificLog} is available for the requested plank type.` };
    }
  }

  return {
    candidate: notExcluded(
      craftCandidate(task.targetItem, task.targetCount, requiresTable ? tableForCraft : undefined),
      context,
    ),
    reason: `All modeled prerequisites are available for ${task.targetItem}; craft and verify the resulting inventory count.`,
  };
}

/**
 * Expands the wood recipe tree into the ordered steps still missing from inventory. The result is the
 * projected plan recorded with each decision. Only the first actionable step is executed directly;
 * the rest are re-decided from fresh observations.
 *
 * Material is tracked as a pool: a collected log or a crafted intermediate satisfies later steps.
 */
export function projectCraftSteps(state: MinecraftObservation, task: CraftItemTask): string[] {
  const steps: string[] = [];
  const pool = new Map<string, number>();
  for (const item of state.inventory) pool.set(item.name, (pool.get(item.name) ?? 0) + item.count);
  // An observed table within crafting reach satisfies the table requirement without placing one.
  const player = state.player.position;
  const tableInReach = [...state.nearbyBlocks, ...state.resourceSightings].some(
    (block) => block.name === "crafting_table" && distance(centerOf(block.position), player) <= MAX_CRAFTING_TABLE_DISTANCE,
  );
  const plankTotal = (): number => minecraftPlankNames.reduce((sum, name) => sum + (pool.get(name) ?? 0), 0);

  /** Makes `count` of `item` available, appending the steps that are still missing. */
  const ensure = (item: string, count: number, depth: number): void => {
    if (depth > 6 || count <= 0) return;
    const have = pool.get(item) ?? 0;
    if (have >= count) {
      pool.set(item, have - count);
      return;
    }
    const missing = count - have;
    pool.set(item, 0);
    if (isMinecraftLogName(item)) {
      steps.push(`collect ${missing} ${item}`);
      return;
    }
    if (item === "any_planks") {
      const fromPool = Math.min(plankTotal(), missing);
      let remaining = fromPool;
      for (const plank of minecraftPlankNames) {
        const used = Math.min(remaining, pool.get(plank) ?? 0);
        pool.set(plank, (pool.get(plank) ?? 0) - used);
        remaining -= used;
      }
      if (missing - fromPool > 0) ensure("oak_planks", missing - fromPool, depth + 1);
      return;
    }
    const recipe = minecraftWoodRecipePlans[item as CraftableMinecraftItem];
    if (!recipe) return;
    const runs = Math.ceil(missing / recipe.outputCount);
    for (const [ingredient, quantity] of Object.entries(recipe.ingredients)) {
      ensure(ingredient, quantity * runs, depth + 1);
    }
    if (recipe.requiresCraftingTable && !tableInReach) {
      ensure("crafting_table", 1, depth + 1);
      steps.push("place crafting_table");
    }
    steps.push(`craft ${recipe.outputCount * runs} ${item}`);
    pool.set(item, (pool.get(item) ?? 0) + recipe.outputCount * runs - missing);
  };

  ensure(task.targetItem, Math.max(0, task.targetCount - itemCount(state, task.targetItem)), 0);
  return steps.slice(0, MAX_PLAN_STEPS);
}

function selectBest(
  candidates: readonly DecisionCandidate[],
  previousGoalKey: string | null,
): { selected: DecisionCandidate | null; alternatives: DecisionCandidate[] } {
  const ranked = [...candidates].sort((left, right) => {
    const leftScore = left.score + (left.targetKey !== null && left.targetKey === previousGoalKey ? HYSTERESIS_BONUS : 0);
    const rightScore = right.score + (right.targetKey !== null && right.targetKey === previousGoalKey ? HYSTERESIS_BONUS : 0);
    return rightScore - leftScore || (left.targetKey ?? "").localeCompare(right.targetKey ?? "") || left.goalId.localeCompare(right.goalId);
  });
  return { selected: ranked[0] ?? null, alternatives: ranked.slice(1) };
}

function planFor(selected: DecisionCandidate | null, state: MinecraftObservation, task: MinecraftTask): string[] {
  if (!selected) return [];
  if (task.kind === "craft_item") {
    const steps = projectCraftSteps(state, task);
    return steps.length > 0 ? steps : [selected.goalId];
  }
  return [selected.goalId];
}

export class MinecraftTaskDecisionModel implements DecisionModel<MinecraftObservation, MinecraftTask> {
  readonly modelId = "minecraft-priority-utility.v3";

  decide(
    state: MinecraftObservation,
    task: MinecraftTask,
    context: MinecraftDecisionContext = { excludedTargets: new Set<string>(), previousFailureCode: null },
    observationSequence = 0,
  ): MinecraftDecisionRecord {
    const memory = context.memory ?? WorldMemory.fromObservation(state, observationSequence);
    const previousGoalKey = context.previousGoalKey ?? null;
    const decidedAt = new Date().toISOString();
    const record = (
      terminalStatus: DecisionRecord["terminalStatus"],
      selected: DecisionCandidate | null,
      alternatives: readonly DecisionCandidate[],
      summary: string,
    ): MinecraftDecisionRecord => ({
      modelId: this.modelId,
      decidedAt,
      observationSequence,
      selected,
      alternatives,
      terminalStatus,
      summary,
      plan: planFor(selected, state, task),
      band: selected?.priorityBand ?? null,
      knowledge: memory.summary(),
    });

    // 1. Completion is judged from the observed inventory or hunger, never from the planner's intent.
    if (task.kind === "secure_food") {
      const hunger = state.player.food ?? 0;
      if (hunger >= task.targetHunger) {
        return record("completed", null, [], `Task condition met: hunger ${hunger}/20 reached the target of ${task.targetHunger}.`);
      }
    } else {
      const targetItem = task.kind === "gather_resource" ? task.resourceName : task.targetItem;
      const currentTargetCount = itemCount(state, targetItem);
      if (currentTargetCount >= task.targetCount) {
        return record("completed", null, [], `Task condition met: inventory/equipment contains ${currentTargetCount}/${task.targetCount} ${targetItem}.`);
      }
    }

    const threats = assessThreats(state, memory, task.dangerRadius);
    const health = state.player.health;
    const hunger = state.player.food;

    // 2. Stuck recovery and hostile avoidance outrank everything else.
    if (threats.nearby.length > 0) {
      const flee = fleeCandidates(state, threats.nearby, context);
      if (flee.length > 0) {
        const choice = selectBest(flee, previousGoalKey);
        return record(
          null,
          choice.selected,
          choice.alternatives,
          "Safety goal outranks eating and progression; leave the nearby hostile's threat radius first.",
        );
      }
      return record(
        "blocked",
        null,
        [],
        "All untried conservative flee destinations were exhausted while a hostile remains nearby; stop rather than approach a resource.",
      );
    }

    const recovery = recoveryCandidates(state, context, task.dangerRadius).filter((candidate) => available(context, candidate.skillId ?? ""));
    if (recovery.length > 0) {
      const choice = selectBest(recovery, previousGoalKey);
      return record(null, choice.selected, choice.alternatives, `Recover from ${context.stuck?.reason ?? "a stall"} with an alternative route before retrying the goal.`);
    }

    if (state.player.gameMode !== "survival") {
      return record("blocked", null, [], `Minecraft task skills are limited to survival mode; current mode is '${state.player.gameMode}'.`);
    }
    if (task.kind === "gather_resource" && state.player.dimension !== "overworld") {
      return record("blocked", null, [], `Log collection is currently restricted to the overworld; current dimension is '${state.player.dimension}'.`);
    }

    // 3. Survival candidates: eat, food sourcing, and recovering health through rest.
    const survival: DecisionCandidate[] = [];
    const food = needsFood(state, task) ? eatCandidate(state, context) : null;
    if (food) survival.push(food);
    if (needsFood(state, task) && !food) {
      const sources = foodSourceCandidates(state, memory, task, threats, context);
      survival.push(...sources);
      const lowFood = hunger !== null && hunger <= LOW_FOOD_EXPLORATION_THRESHOLD;
      if (sources.length === 0 && (lowFood || task.kind === "secure_food")) {
        const explore = explorationCandidate(state, memory, task, threats, context, "food");
        if (explore) survival.push(explore);
      }
    }
    const rest = restCandidate(state, task, threats, context);
    if (rest) survival.push(rest);

    const survivalChoice = selectBest(survival.filter((candidate) => available(context, candidate.skillId ?? "")), previousGoalKey);
    if (survivalChoice.selected) {
      // The chosen candidate's own rationale names the concrete action; the summary never guesses.
      return record(null, survivalChoice.selected, survivalChoice.alternatives, survivalChoice.selected.rationale);
    }

    // 4. Critical states without a survival option block progress instead of spending the last budget.
    const criticalHealth = health !== null && health <= CRITICAL_HEALTH_THRESHOLD;
    const criticalFood = hunger !== null && hunger <= CRITICAL_FOOD_THRESHOLD;
    if (criticalHealth) {
      const restAvailable = available(context, "minecraft.rest");
      const regenPossible = hunger !== null && hunger >= REGEN_FOOD_THRESHOLD;
      const restBudgetLeft = task.maxRestMs - (context.restMsUsed ?? 0) >= 1_000;
      const message = !restAvailable
        ? `Health is critically low (${health}/20) and no validated healing skill is available; stop rather than risk further damage.`
        : !regenPossible
          ? `Health is critically low (${health}/20); natural regeneration needs food ≥ ${REGEN_FOOD_THRESHOLD} and no food source is available, so stop rather than risk further damage.`
          : !restBudgetLeft
            ? `Health is critically low (${health}/20) and the task's rest budget of ${task.maxRestMs} ms is spent; stop rather than risk further damage.`
            : `Health is critically low (${health}/20); resting is blocked by a visible hostile, so stop rather than risk further damage.`;
      return record("blocked", null, [], message);
    }
    if (criticalFood) {
      return record(
        "blocked",
        null,
        [],
        `Hunger is critically low (${hunger}/20), but no supported food is in inventory and no food source is known or reachable; stopping instead of spending the remaining survival budget on task progress.`,
      );
    }
    if (task.kind === "secure_food") {
      return record(
        "blocked",
        null,
        [],
        `Hunger is ${hunger ?? "unknown"}/${task.targetHunger} and no food is in inventory, no dropped food or ripe berry bush is known, and exploration cannot continue.`,
      );
    }

    // 5. Progress: gathering, crafting, and exploring for resources.
    if (task.kind === "gather_resource") {
      return this.decideGather(state, memory, task, threats, context, record);
    }
    return this.decideCraft(state, memory, task, threats, context, record);
  }

  private decideGather(
    state: MinecraftObservation,
    memory: WorldMemory,
    task: GatherResourceTask,
    threats: Threats,
    context: MinecraftDecisionContext,
    record: (
      terminalStatus: DecisionRecord["terminalStatus"],
      selected: DecisionCandidate | null,
      alternatives: readonly DecisionCandidate[],
      summary: string,
    ) => MinecraftDecisionRecord,
  ): MinecraftDecisionRecord {
    const gather = gatherCandidates(state, memory, task, threats, context).candidates.filter((candidate) =>
      available(context, candidate.skillId ?? ""),
    );
    if (gather.length > 0) {
      const choice = selectBest(gather, context.previousGoalKey ?? null);
      return record(null, choice.selected, choice.alternatives, "Collect an observed safe log; replan after the action and verify the inventory delta.");
    }

    const explore = explorationCandidate(state, memory, task, threats, context, "resource");
    if (explore) {
      return record(null, explore, [], `No safe ${task.resourceName} is known; explore a bounded unexplored area to reveal one.`);
    }

    const counts = gatherCandidates(state, memory, task, threats, context);
    const summary = counts.threatened > 0
      ? `Observed ${task.resourceName} blocks are inside the ${task.dangerRadius}-block danger radius of a visible hostile; collection is deferred rather than approaching the threat.`
      : counts.beyond > 0
        ? `Observed ${task.resourceName} targets are beyond the ${task.maxTargetDistance}-block task limit.`
        : counts.tried > 0 || context.previousFailureCode
          ? `No untried observed ${task.resourceName} target remains${context.previousFailureCode ? ` after ${context.previousFailureCode}` : ""}, and exploration is exhausted or unavailable.`
          : counts.known > 0
            ? `No ${task.resourceName} target is safe and reachable, and exploration is exhausted or unavailable.`
            : `No ${task.resourceName} block is currently known in the observed or remembered world state, and exploration is exhausted or unavailable.`;
    return record("blocked", null, [], summary);
  }

  private decideCraft(
    state: MinecraftObservation,
    memory: WorldMemory,
    task: CraftItemTask,
    threats: Threats,
    context: MinecraftDecisionContext,
    record: (
      terminalStatus: DecisionRecord["terminalStatus"],
      selected: DecisionCandidate | null,
      alternatives: readonly DecisionCandidate[],
      summary: string,
    ) => MinecraftDecisionRecord,
  ): MinecraftDecisionRecord {
    const known = knownBlocks(state, memory, new Set<string>([...minecraftLogNames, "crafting_table", "sweet_berry_bush"]));
    const plan = craftPlan(state, known, task, threats, context);
    if (plan.candidate && available(context, plan.candidate.skillId ?? "")) {
      return record(null, plan.candidate, [], plan.reason);
    }
    const explore = explorationCandidate(state, memory, task, threats, context, "resource");
    if (explore) {
      return record(null, explore, [], `${plan.reason} Exploring a bounded unexplored area for the missing prerequisite.`);
    }
    return record("blocked", null, [], plan.reason);
  }
}
