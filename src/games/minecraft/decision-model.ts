import type {
  DecisionCandidate,
  DecisionContext,
  DecisionModel,
  DecisionRecord,
  DecisionRejection,
} from "../../core/decision-model.js";
import { goalClassOf, distanceBandOf, vitalityBandOf } from "../../core/learning/episode.js";
import type { PolicyAdvisor } from "../../core/learning/policy-advisor.js";
import { BASELINE_ADVISOR } from "../../core/learning/policy-advisor.js";
import {
  minecraftLogNames,
  minecraftPlankNames,
} from "./capabilities.js";
import {
  distanceBetween,
  isRipeBerryBush,
  isResourceBlockName,
  observedHazards,
} from "./block-classes.js";
import {
  bestPickaxeTier,
  canMineWithTier,
  isMineableBlockName,
  minecraftMiningRequirements,
  minecraftPlaceableBlockNames,
  miningDropFor,
} from "./mining.js";
import { bestWeapon, combatIsAllowed } from "./combat.js";
import { shelterCardinalSolidCount } from "./skill-contracts.js";
import { SHELTER_CARDINAL_DIRECTIONS } from "./shelter.js";
import { chooseExplorationWaypoint } from "./exploration.js";
import type { MinecraftObservation } from "./observation.js";
import { craftItemTaskSchema } from "./task.js";
import type {
  BuildShelterTask,
  CraftItemTask,
  GatherResourceTask,
  MinecraftTask,
  MineResourceTask,
} from "./task.js";
import type { CraftableMinecraftItem } from "./recipes.js";
import {
  countItemAndEquipment,
  isMinecraftFoodName,
  isMinecraftLogName,
  minecraftFoodNutrition,
  minecraftRecipePlans,
  minedIngredientSources,
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
/** A hazard block this close to the player triggers the safety goal of moving away. */
const HAZARD_FLEE_DISTANCE = 2.5;
/** Night, low health, or a hostile within this many blocks makes "close the shelter" a survival goal. */
const SHELTER_TRIGGER_HOSTILE_DISTANCE = 12;
/** A weapon must beat this damage before attacking is considered better than retreating. */
const MIN_WEAPON_DAMAGE = 4;
const MAX_COMBAT_ATTEMPTS_PER_RUN = 3;
/** Slots a full player inventory occupies; used to decide when to free space. */
const INVENTORY_FULL_STACKS = 30;
/** Ticks before full darkness at which shelter is prepared. */
const NIGHT_APPROACH_TICKS = 12_000;

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
  /** Learner hook: weights and known failures. Baseline behaviour is unchanged when absent. */
  readonly advisor?: PolicyAdvisor;
  /** World identity for learned target memory (scenario id + seed, or server + world). */
  readonly worldKey?: string | null;
  /** Operator switch. Combat is never planned without it, independent of the safety policy. */
  readonly combatEnabled?: boolean;
  /** Attacks already attempted this run; combat is bounded per run, not per target. */
  readonly combatAttempts?: number;
  /** True when the last observation showed no room for another item stack. */
  readonly inventoryFull?: boolean;
  /** Rejection sink filled while candidates are filtered, so traces explain what was dropped. */
  readonly ledger?: RejectionLedger;
  /** Set by the runner after a stall or oscillation to request a sidestep recovery. */
  readonly stuck?: {
    readonly reason: string;
    /** Where the stall happened. */
    readonly at: { readonly x: number; readonly z: number };
    /** The goal that could not be reached, when known; sidesteps are chosen to approach it from another side. */
    readonly toward?: { readonly x: number; readonly z: number } | null;
  } | null;
}

/** Collects the reasons candidates were dropped, so a decision trace explains the rejections. */
export class RejectionLedger {
  private readonly entries: DecisionRejection[] = [];

  reject(
    candidate: DecisionCandidate,
    reason: DecisionRejection["reason"],
    detail: string,
  ): void {
    if (this.entries.some((entry) => entry.targetKey === candidate.targetKey && entry.reason === reason)) return;
    this.entries.push({
      goalId: candidate.goalId,
      targetKey: candidate.targetKey,
      priorityBand: candidate.priorityBand,
      score: candidate.score,
      reason,
      detail,
    });
  }

  /** Records a rejection for a target that never became a full candidate (skipped during scanning). */
  note(
    target: { readonly goalId: string; readonly targetKey: string | null; readonly priorityBand: number; readonly score?: number },
    reason: DecisionRejection["reason"],
    detail: string,
  ): void {
    this.reject(
      {
        goalId: target.goalId,
        targetKey: target.targetKey,
        priorityBand: target.priorityBand,
        score: target.score ?? 0,
        skillId: null,
        input: null,
        rationale: detail,
      },
      reason,
      detail,
    );
  }

  get all(): readonly DecisionRejection[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }
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


/** Observed lava/water/fire/cactus within flee distance. Unknown cells never trigger a hazard goal. */
function hazardCandidate(
  state: MinecraftObservation,
  context: MinecraftDecisionContext,
): DecisionCandidate | null {
  if (!available(context, "minecraft.navigate")) return null;
  const hazards = observedHazards(state.nearbyBlocks, state.player.position).filter(
    (hazard) => hazard.distance <= HAZARD_FLEE_DISTANCE,
  );
  if (hazards.length === 0) return null;
  const player = state.player.position;
  const hazard = hazards[0]!;
  let awayX = player.x - hazard.position.x;
  let awayZ = player.z - hazard.position.z;
  if (Math.hypot(awayX, awayZ) < 0.001) {
    awayX = 1;
    awayZ = 0;
  }
  const solids = solidKeys(state);
  const baseAngle = Math.atan2(awayZ, awayX);
  let best: { x: number; z: number; score: number } | null = null;
  for (let index = 0; index < 8; index += 1) {
    const angle = baseAngle + (index * Math.PI) / 4;
    const x = Math.round(player.x + Math.cos(angle) * 6);
    const z = Math.round(player.z + Math.sin(angle) * 6);
    const minHazardDistance = Math.min(
      ...hazards.map((entry) => Math.hypot(x + 0.5 - (entry.position.x + 0.5), z + 0.5 - (entry.position.z + 0.5))),
    );
    const blocked = blockedRouteCount(solids, player, { x: x + 0.5, z: z + 0.5 });
    const score = minHazardDistance - blocked * 2;
    if (!best || score > best.score) best = { x, z, score };
  }
  if (!best) return null;
  const targetKey = `hazard:${best.x},${Math.floor(player.y)},${best.z}`;
  if (isExcluded(context, targetKey)) {
    context.ledger?.note(
      { goalId: "avoid-hazard", targetKey, priorityBand: BAND_SAFETY },
      "excluded_after_failure",
      "that escape cell was already tried and failed",
    );
    return null;
  }
  return {
    goalId: "avoid-hazard",
    priorityBand: BAND_SAFETY,
    score: 990 + best.score,
    skillId: "minecraft.navigate",
    input: { x: best.x, y: Math.floor(player.y), z: best.z, range: 1 },
    targetKey,
    rationale: `A ${hazard.name} block is ${hazard.distance.toFixed(1)} blocks away; move to a cell that keeps distance from it before doing anything else.`,
  };
}

/**
 * Defensive strike. Exists only when the operator enabled combat **and** the shared safety function
 * approves the specific target, and it never outranks fleeing when several hostiles are close.
 */
function defendCandidate(
  state: MinecraftObservation,
  task: MinecraftTask,
  threats: Threats,
  context: MinecraftDecisionContext,
): DecisionCandidate | null {
  if (!context.combatEnabled) {
    if (threats.nearby.length > 0) {
      context.ledger?.note(
        { goalId: "defend", targetKey: `hostile:${threats.nearby[0]?.id ?? "unknown"}`, priorityBand: BAND_SAFETY },
        "no_skill",
        "combat is not enabled for this run, so the agent flees instead of attacking",
      );
    }
    return null;
  }
  if (!available(context, "minecraft.attack-hostile")) return null;
  const hostile = threats.nearby[0];
  if (!hostile) return null;
  if ((context.combatAttempts ?? 0) >= MAX_COMBAT_ATTEMPTS_PER_RUN) {
    context.ledger?.note(
      { goalId: "defend", targetKey: `hostile:${hostile.id}`, priorityBand: BAND_SAFETY },
      "no_budget",
      `the run already attempted ${MAX_COMBAT_ATTEMPTS_PER_RUN} fight(s)`,
    );
    return null;
  }
  const weapon = bestWeapon([
    ...(state.equipment.hand ? [{ name: state.equipment.hand.name }] : []),
    ...state.inventory.map((item) => ({ name: item.name })),
  ]);
  const verdict = combatIsAllowed({
    enabled: true,
    health: state.player.health,
    minHealth: 10,
    retreatHealth: 6,
    hostileCountNearby: threats.nearby.length,
    maxEngageableHostiles: 1,
    weapon: weapon ? { name: weapon.name, damage: weapon.damage } : null,
    requiredDamage: MIN_WEAPON_DAMAGE,
    targetDistance: hostile.distance,
    maxTargetDistance: 4,
    hitsAlreadyAttempted: 0,
    maxHits: 4,
    hostileName: hostile.name,
    hostileType: hostile.type,
    hunger: state.player.food,
  });
  const targetKey = `hostile:${hostile.id}`;
  if (!verdict.allowed) {
    context.ledger?.note(
      { goalId: "defend", targetKey, priorityBand: BAND_SAFETY },
      verdict.code === "COMBAT_NO_WEAPON" ? "no_skill" : "threatened",
      verdict.reason,
    );
    return null;
  }
  if (isExcluded(context, targetKey)) {
    context.ledger?.note(
      { goalId: "defend", targetKey, priorityBand: BAND_SAFETY },
      "excluded_after_failure",
      "this entity was already engaged and the engagement failed",
    );
    return null;
  }
  return {
    goalId: "defend",
    priorityBand: BAND_SAFETY,
    score: 1_000 + task.dangerRadius - hostile.distance,
    skillId: "minecraft.attack-hostile",
    input: {
      entityId: hostile.id,
      maxHits: 4,
      dangerRadius: task.dangerRadius,
      minHealth: 10,
      retreatHealth: 6,
      requiredDamage: MIN_WEAPON_DAMAGE,
    },
    targetKey,
    rationale: `Combat is enabled and safe for this target: ${verdict.reason}`,
  };
}

/** True when the agent stands inside a closed ring of observed solid blocks. */
export function isShelteredFromState(state: MinecraftObservation): boolean {
  return shelterCardinalSolidCount(state) >= SHELTER_CARDINAL_DIRECTIONS.length;
}

function nightPressure(state: MinecraftObservation): "night" | "approaching" | "day" {
  const time = state.time;
  if (!time) return "day";
  if (time.isNight) return "night";
  return time.dayTicks >= NIGHT_APPROACH_TICKS && time.dayTicks < MINECRAFT_NIGHT_START_TICKS_FALLBACK
    ? "approaching"
    : "day";
}

const MINECRAFT_NIGHT_START_TICKS_FALLBACK = 13_000;

/**
 * Shelter as a survival goal: only when it is dark or nearly dark **and** the agent is hurt or being
 * chased, and only when placeable blocks are actually carried. The plan never claims a shelter it
 * cannot build.
 */
function shelterCandidate(
  state: MinecraftObservation,
  task: MinecraftTask,
  threats: Threats,
  context: MinecraftDecisionContext,
  reason: "night" | "hurt" | "task",
): DecisionCandidate | null {
  if (!available(context, "minecraft.build-shelter")) return null;
  if (isShelteredFromState(state)) return null;
  const placeable = placeableBlockInventory(state);
  if (placeable.total < 1) {
    context.ledger?.note(
      { goalId: "build-shelter", targetKey: "shelter:here", priorityBand: BAND_SURVIVAL },
      "no_skill",
      `no placeable blocks are carried (need at least 1 of ${minecraftPlaceableBlockNames.slice(0, 4).join(", ")}, …)`,
    );
    return null;
  }
  const open = SHELTER_CARDINAL_DIRECTIONS.filter(([dx, dz]) => {
    const x = Math.floor(state.player.position.x) + dx;
    const z = Math.floor(state.player.position.z) + dz;
    const y = Math.floor(state.player.position.y);
    return !state.nearbyBlocks.some(
      (block) => block.position.x === x && block.position.y === y && block.position.z === z && block.boundingBox === "block",
    );
  }).length;
  if (open === 0) return null;
  if (threats.visibleHostiles.some((hostile) => hostile.distance <= task.dangerRadius)) return null;
  const pressure = nightPressure(state);
  if (reason === "night" && pressure === "day") return null;
  const targetKey = `shelter:${Math.floor(state.player.position.x)},${Math.floor(state.player.position.y)},${Math.floor(state.player.position.z)}`;
  if (isExcluded(context, targetKey)) {
    context.ledger?.note(
      { goalId: "build-shelter", targetKey, priorityBand: BAND_SURVIVAL },
      "excluded_after_failure",
      "shelter building already failed at this position",
    );
    return null;
  }
  const health = state.player.health ?? 20;
  return {
    goalId: "build-shelter",
    priorityBand: reason === "task" ? BAND_PROGRESS : BAND_SURVIVAL,
    score: (reason === "task" ? 420 : 640) + (20 - health) + open * 5,
    skillId: "minecraft.build-shelter",
    input: { mode: "cardinal", maxBlocks: Math.min(4, placeable.total), dangerRadius: task.dangerRadius },
    targetKey,
    rationale:
      reason === "hurt"
        ? `Health is ${health.toFixed(1)}/20 with ${open} open side(s) and ${placeable.total} placeable block(s) carried; close the ring so regeneration is not interrupted.`
        : reason === "night"
          ? `${pressure === "night" ? "It is night" : "Night is approaching"} and ${open} side(s) are open; close them with carried blocks before wandering.`
          : `The task is to close ${open} open side(s) with ${placeable.total} carried block(s).`,
  };
}

function placeableBlockInventory(state: MinecraftObservation): { total: number; best: string | null } {
  let total = 0;
  let best: string | null = null;
  let bestCount = 0;
  for (const item of state.inventory) {
    if (!(minecraftPlaceableBlockNames as readonly string[]).includes(item.name)) continue;
    total += item.count;
    if (item.count > bestCount) {
      bestCount = item.count;
      best = item.name;
    }
  }
  return { total, best };
}

/** Stone-class blocks the agent has seen (observed now or remembered), with their mining feasibility. */
function mineableTargets(
  state: MinecraftObservation,
  memory: WorldMemory,
  names: ReadonlySet<string>,
): KnownBlock[] {
  const byKey = new Map<string, KnownBlock>();
  const player = state.player.position;
  const add = (name: string, position: { x: number; y: number; z: number }): void => {
    if (!names.has(name) || !isMineableBlockName(name)) return;
    const key = positionKey(position);
    if (byKey.has(key)) return;
    byKey.set(key, {
      key,
      name,
      position: { x: position.x, y: position.y, z: position.z },
      ripe: null,
      distance: distanceBetween(centerOf(position), player),
    });
  };
  for (const block of state.nearbyBlocks) add(block.name, block.position);
  for (const sighting of state.minableSightings ?? []) add(sighting.name, sighting.position);
  for (const sighting of memory.minableSightings(names)) add(sighting.name, sighting.position);
  return [...byKey.values()].sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key));
}

/**
 * Mining candidates for one target block class. The tool tier is resolved from what is actually
 * carried: when the agent owns a better pickaxe than the one in hand, equipping it is the cheaper
 * progress step, and when no carried tool can harvest the block the target is rejected with the
 * reason instead of being attempted and failed.
 */
function mineCandidates(
  state: MinecraftObservation,
  memory: WorldMemory,
  options: {
    readonly blockNames: ReadonlySet<string>;
    readonly dropItem: string;
    readonly dangerRadius: number;
    readonly maxDistance: number;
    readonly task: MinecraftTask;
  },
  context: MinecraftDecisionContext,
): { candidates: DecisionCandidate[]; blockedByTool: number; threatened: number; beyond: number; known: number } {
  const ledger = context.ledger;
  const candidates: DecisionCandidate[] = [];
  const tier = bestPickaxeTier([
    ...(state.equipment.hand ? [{ name: state.equipment.hand.name }] : []),
    ...state.inventory.map((item) => ({ name: item.name })),
  ]);
  const blocks = mineableTargets(state, memory, options.blockNames);
  let blockedByTool = 0;
  let threatened = 0;
  let beyond = 0;
  for (const block of blocks) {
    const goalId = `mine:${block.name}`;
    if (isExcluded(context, block.key)) {
      ledger?.note({ goalId, targetKey: block.key, priorityBand: BAND_PROGRESS }, "excluded_after_failure", "this block was already tried and failed");
      continue;
    }
    if (nearbyDanger(centerOf(block.position), state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type)), options.dangerRadius)) {
      threatened += 1;
      ledger?.note({ goalId, targetKey: block.key, priorityBand: BAND_PROGRESS, score: 0 }, "threatened", "a visible hostile is within the danger radius of the block");
      continue;
    }
    if (block.distance > options.maxDistance) {
      beyond += 1;
      const approach = approachCandidate(
        { name: block.name, key: block.key, position: block.position, distance: block.distance },
        options.task,
        { visibleHostiles: [], nearby: [] },
        context,
        BAND_PROGRESS,
        "approach",
        block.name,
      );
      if (approach) candidates.push(approach);
      continue;
    }
    const verdict = canMineWithTier(block.name, tier.tier);
    if (!verdict.mineable) {
      blockedByTool += 1;
      ledger?.note({ goalId, targetKey: block.key, priorityBand: BAND_PROGRESS }, "no_skill", verdict.reason);
      continue;
    }
    candidates.push({
      goalId,
      priorityBand: BAND_PROGRESS,
      score: 480 - block.distance,
      skillId: "minecraft.mine-block",
      input: { ...block.position, blockName: block.name, dangerRadius: options.dangerRadius },
      targetKey: block.key,
      rationale: `Mine ${block.name} at ${positionKey(block.position)} (${block.distance.toFixed(1)} blocks) for ${options.dropItem}; ${verdict.reason}`,
    });
  }
  return { candidates, blockedByTool, threatened, beyond, known: blocks.length };
}

/** Equipping a better carried pickaxe is cheaper and safer than a failed dig. */
function equipToolCandidate(
  state: MinecraftObservation,
  options: { readonly needTier: number },
  context: MinecraftDecisionContext,
): DecisionCandidate | null {
  if (!available(context, "minecraft.equip-item")) return null;
  const held = state.equipment.hand?.name ?? null;
  const heldTier = bestPickaxeTier(held ? [{ name: held }] : []).tier;
  if (heldTier >= options.needTier) return null;
  const carried = state.inventory
    .map((item) => ({ item, tier: bestPickaxeTier([item]).tier }))
    .filter(({ item, tier }) => tier >= options.needTier && tier > heldTier && isPickaxeName(item.name))
    .sort((left, right) => right.tier - left.tier || left.item.name.localeCompare(right.item.name))[0];
  if (!carried) return null;
  const targetKey = `equip:${carried.item.name}`;
  if (isExcluded(context, targetKey)) return null;
  return {
    goalId: "equip:pickaxe",
    priorityBand: BAND_PROGRESS,
    score: 495,
    skillId: "minecraft.equip-item",
    input: { item: carried.item.name, destination: "hand" },
    targetKey,
    rationale: `Hold ${carried.item.name} (tier ${carried.tier}) so the next dig can actually harvest the block; the hand currently holds ${held ?? "nothing useful"}.`,
  };
}

function isPickaxeName(name: string): boolean {
  return name.endsWith("_pickaxe");
}

/**
 * When the inventory cannot accept another stack, dropping allowlisted terrain is the only progress
 * step that does not risk losing something valuable. The skill itself refuses anything but terrain.
 */
function inventoryCandidate(
  state: MinecraftObservation,
  context: MinecraftDecisionContext,
): DecisionCandidate | null {
  if (!available(context, "minecraft.drop-item")) return null;
  const stacks = new Map<string, number>();
  for (const item of state.inventory) stacks.set(item.name, (stacks.get(item.name) ?? 0) + item.count);
  const distinct = stacks.size;
  const full = context.inventoryFull === true || distinct >= INVENTORY_FULL_STACKS;
  if (!full) return null;
  const junk = [...stacks.entries()]
    .filter(([name]) => (minecraftDroppableJunkList as readonly string[]).includes(name))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  if (!junk) {
    context.ledger?.note(
      { goalId: "free-inventory", targetKey: "inventory:junk", priorityBand: BAND_PROGRESS },
      "not_applicable",
      `the inventory holds ${distinct} stacks but no droppable terrain to give up`,
    );
    return null;
  }
  return {
    goalId: "free-inventory",
    priorityBand: BAND_PROGRESS,
    score: 470,
    skillId: "minecraft.drop-item",
    input: { itemName: junk[0], count: Math.min(16, junk[1]) },
    targetKey: `drop:${junk[0]}`,
    rationale: `The inventory is full (${distinct} stacks); drop ${Math.min(16, junk[1])} ${junk[0]} so a needed item can be collected.`,
  };
}

const minecraftDroppableJunkList = [
  "dirt",
  "sand",
  "gravel",
  "granite",
  "andesite",
  "diorite",
  "cobbled_deepslate",
] as const;

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

/**
 * Mine candidates scan both the live observation and remembered sightings. `knownMinedBlocks` adapts the
 * block list from {@link craftPlan} into the memory view the miner expects, so a stone block seen a
 * moment ago is still a valid target even if the current cube no longer lists it.
 */
function knownMinedBlocks(state: MinecraftObservation, context: MinecraftDecisionContext): WorldMemory {
  return context.memory ?? WorldMemory.fromObservation(state, 0);
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
  const plan = minecraftRecipePlans[task.targetItem];
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
  const requiredMined = new Map<string, number>();
  for (const [ingredient, quantity] of Object.entries(plan.ingredients)) {
    if (ingredient === "any_planks") requiredPlanks += quantity * operations;
    else if (ingredient === "stick") requiredSticks += quantity * operations;
    else if (minedIngredientSources[ingredient]) {
      requiredMined.set(ingredient, (requiredMined.get(ingredient) ?? 0) + quantity * operations);
    }
  }

  // A mined ingredient (cobblestone for stone tools) is a prerequisite the wood planner cannot craft.
  for (const [ingredient, quantity] of requiredMined) {
    if (inventoryCount(state, ingredient) >= quantity) continue;
    const missing = quantity - inventoryCount(state, ingredient);
    const blockNames = new Set<string>(minedIngredientSources[ingredient] ?? []);
    const tier = bestPickaxeTier([
      ...(state.equipment.hand ? [{ name: state.equipment.hand.name }] : []),
      ...state.inventory.map((item) => ({ name: item.name })),
    ]).tier;
    const mined = mineCandidates(
      state,
      knownMinedBlocks(state, context),
      {
        blockNames,
        dropItem: ingredient,
        dangerRadius: task.dangerRadius,
        maxDistance: task.maxTargetDistance,
        task,
      },
      context,
    );
    if (mined.candidates.length > 0) {
      return {
        candidate: mined.candidates[0] ?? null,
        reason: `Mine ${missing} ${ingredient} for ${task.targetItem}; ${mined.candidates[0]?.rationale ?? "a validated block is in range"}.`,
      };
    }
    const equip = tier < 1 ? equipToolCandidate(state, { needTier: 1 }, context) : null;
    if (equip) return { candidate: equip, reason: `Hold a pickaxe before mining ${missing} ${ingredient} for ${task.targetItem}.` };
    if (mined.known > 0 && mined.blockedByTool > 0) {
      return {
        candidate: null,
        reason: `The ${ingredient} that is visible cannot be harvested with the best carried pickaxe (tier ${tier}); craft or find a better tool first.`,
      };
    }
    return {
      candidate: null,
      reason: `No mineable ${[...blockNames].join(" or ")} block is observed or remembered, so ${missing} ${ingredient} cannot be produced for ${task.targetItem}.`,
    };
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
    const sourceBlocks = minedIngredientSources[item];
    if (sourceBlocks && sourceBlocks.length > 0) {
      steps.push(`mine ${missing} ${item} (from ${sourceBlocks.join(" or ")})`);
      return;
    }
    const recipe = minecraftRecipePlans[item as CraftableMinecraftItem];
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

interface RankedCandidate {
  readonly candidate: DecisionCandidate;
  readonly effective: number;
  readonly notes: readonly string[];
}

/**
 * Ranking with the two preference mechanisms the model allows: hysteresis toward the previous goal,
 * and the learner's advice. Learning is only applied from the survival band upward — a safety goal is
 * never down-weighted by a statistic — and a learned "known unreachable" verdict can veto a progress
 * target but never a survival or safety one.
 */
function rankCandidates(
  candidates: readonly DecisionCandidate[],
  context: MinecraftDecisionContext,
  state: MinecraftObservation,
  options: { readonly learnable: boolean; readonly previousGoalKey: string | null },
): { selected: DecisionCandidate | null; alternatives: DecisionCandidate[] } {
  const scored: RankedCandidate[] = [];
  for (const candidate of candidates) {
    let effective = candidate.score;
    const notes: string[] = [];
    if (options.learnable && context.advisor) {
      const assessment = context.advisor.assess({
        skillId: candidate.skillId ?? "none",
        goalClass: goalClassOf(candidate.goalId),
        distanceBand: distanceBandOf(distanceToCandidate(state, candidate)),
        vitality: vitalityBandOf(state.player.health, state.player.food),
        threat: threatBandFor(state),
        timeOfDay: state.time ? (state.time.isNight ? "night" : "day") : "unknown",
        targetKey: candidate.targetKey,
      });
      if (assessment.blocked && candidate.priorityBand >= BAND_PROGRESS) {
        context.ledger?.reject(candidate, "policy_penalty", `learned failure memory vetoes this target: ${assessment.blocked.reason}`);
        continue;
      }
      effective = Math.round((effective * assessment.multiplier - assessment.penalty * 100) * 100) / 100;
      notes.push(...assessment.notes);
    }
    if (candidate.targetKey !== null && candidate.targetKey === options.previousGoalKey) {
      effective += HYSTERESIS_BONUS;
    }
    scored.push({ candidate: { ...candidate, score: effective }, effective, notes });
  }
  const ranked = scored.sort(
    (left, right) =>
      right.effective - left.effective ||
      (left.candidate.targetKey ?? "").localeCompare(right.candidate.targetKey ?? "") ||
      left.candidate.goalId.localeCompare(right.candidate.goalId),
  );
  for (const entry of ranked.slice(1)) {
    // Anything that lost the comparison inside the same band is an explained alternative, not a rejection.
    void entry;
  }
  return { selected: ranked[0]?.candidate ?? null, alternatives: ranked.slice(1).map((entry) => entry.candidate) };
}

function threatBandFor(state: MinecraftObservation): "none" | "visible" | "approaching" {
  const hostiles = state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type));
  if (hostiles.length === 0) return "none";
  return hostiles.some((entity) => entity.distance <= 4) ? "approaching" : "visible";
}

function distanceToCandidate(state: MinecraftObservation, candidate: DecisionCandidate): number | null {
  const input = candidate.input;
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.z !== "number") return null;
  const y = typeof record.y === "number" ? record.y : state.player.position.y;
  return distanceBetween(
    { x: record.x + 0.5, y, z: record.z + 0.5 },
    state.player.position,
  );
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

function shelterPlanSummary(state: MinecraftObservation): string {
  const placeable = placeableBlockInventory(state);
  const open = SHELTER_CARDINAL_DIRECTIONS.filter(([dx, dz]) => {
    const x = Math.floor(state.player.position.x) + dx;
    const z = Math.floor(state.player.position.z) + dz;
    const y = Math.floor(state.player.position.y);
    return !state.nearbyBlocks.some(
      (block) => block.position.x === x && block.position.y === y && block.position.z === z && block.boundingBox === "block",
    );
  }).length;
  return placeable.total === 0
    ? `no placeable blocks are in the inventory and ${open} side(s) are open`
    : `${open} side(s) are open but none can be validated as an empty cell with an observed solid support block`;
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
      rejected: [...(context.ledger?.all ?? [])],
    });

    // 1. Completion is judged from the observed world, never from the planner's intent.
    if (task.kind === "secure_food") {
      const hunger = state.player.food ?? 0;
      if (hunger >= task.targetHunger) {
        return record("completed", null, [], `Task condition met: hunger ${hunger}/20 reached the target of ${task.targetHunger}.`);
      }
    } else if (task.kind === "build_shelter") {
      const solid = shelterCardinalSolidCount(state);
      if (solid >= SHELTER_CARDINAL_DIRECTIONS.length) {
        return record("completed", null, [], `Task condition met: all four cardinal sides around the player are observed solid.`);
      }
    } else {
      const targetItem =
        task.kind === "gather_resource"
          ? task.resourceName
          : task.kind === "craft_item"
            ? task.targetItem
            : (miningDropFor(task.resourceName) ?? task.resourceName);
      const currentTargetCount = itemCount(state, targetItem);
      if (currentTargetCount >= task.targetCount) {
        return record("completed", null, [], `Task condition met: inventory/equipment contains ${currentTargetCount}/${task.targetCount} ${targetItem}.`);
      }
    }

    const threats = assessThreats(state, memory, task.dangerRadius);
    const health = state.player.health;
    const hunger = state.player.food;

    // 2. Hazards, hostiles and stalled routes outrank everything else, and learning never touches them.
    const hazard = hazardCandidate(state, context);
    if (hazard) {
      return record(null, hazard, [], hazard.rationale);
    }

    if (threats.nearby.length > 0) {
      const defend = defendCandidate(state, task, threats, context);
      if (defend) {
        return record(null, defend, [], defend.rationale);
      }
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

    // Shelter: hurt and exposed, or darkness with open sides. It is a survival goal, not a build project.
    const healthValue = state.player.health ?? 20;
    const shelterReason: "hurt" | "night" | null =
      healthValue <= REST_HEALTH_THRESHOLD && threats.visibleHostiles.length === 0
        ? "hurt"
        : nightPressure(state) !== "day" && threats.visibleHostiles.length > 0
          ? "night"
          : null;
    if (shelterReason && task.kind !== "build_shelter") {
      const shelter = shelterCandidate(state, task, threats, context, shelterReason);
      if (shelter) survival.push(shelter);
    }

    const survivalChoice = rankCandidates(
      survival.filter((candidate) => available(context, candidate.skillId ?? "")),
      context,
      state,
      { learnable: true, previousGoalKey },
    );
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

    // 5. Progress: gathering, mining, crafting, shelter work, and exploring for resources.
    const freeInventory = inventoryCandidate(state, context);
    if (freeInventory) {
      return record(null, freeInventory, [], freeInventory.rationale);
    }
    if (task.kind === "gather_resource") {
      return this.decideGather(state, memory, task, threats, context, record);
    }
    if (task.kind === "mine_resource") {
      return this.decideMine(state, memory, task, threats, context, record);
    }
    if (task.kind === "build_shelter") {
      const shelter = shelterCandidate(state, task, threats, context, "task");
      if (shelter) return record(null, shelter, [], shelter.rationale);
      const plan = shelterPlanSummary(state);
      return record(
        "blocked",
        null,
        [],
        `Cannot close the shelter here: ${plan}. Gather placeable blocks or move to ground with solid support.`,
      );
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

  /**
   * Mining progress. Ordered as a prerequisite chain rather than a single goal: hold a tool that can
   * harvest the block, then dig the nearest validated block, then explore when none is known. A tool
   * the agent does not own is crafted through the same planner that serves crafting tasks, so a
   * "mine cobblestone" goal transparently expands into wood → planks → sticks → pickaxe → dig.
   */
  private decideMine(
    state: MinecraftObservation,
    memory: WorldMemory,
    task: MineResourceTask,
    threats: Threats,
    context: MinecraftDecisionContext,
    record: (
      terminalStatus: DecisionRecord["terminalStatus"],
      selected: DecisionCandidate | null,
      alternatives: readonly DecisionCandidate[],
      summary: string,
    ) => MinecraftDecisionRecord,
  ): MinecraftDecisionRecord {
    const drop = miningDropFor(task.resourceName) ?? task.resourceName;
    const requirement = minecraftMiningRequirements[task.resourceName];
    const blockNames = new Set<string>([task.resourceName, ...(minedIngredientSources[drop] ?? [])]);
    const tier = bestPickaxeTier([
      ...(state.equipment.hand ? [{ name: state.equipment.hand.name }] : []),
      ...state.inventory.map((item) => ({ name: item.name })),
    ]).tier;

    if (requirement.requiresPickaxe && tier < requirement.minPickaxeTier) {
      const equip = equipToolCandidate(state, { needTier: requirement.minPickaxeTier }, context);
      if (equip) return record(null, equip, [], equip.rationale);
      // No usable pickaxe is carried: fall back to the crafting planner for the missing tool.
      const toolItem = requirement.minPickaxeTier >= 2 ? "stone_pickaxe" : "wooden_pickaxe";
      const craftTask = craftItemTaskSchema.parse({
        id: `${task.id}:tool`,
        kind: "craft_item",
        targetItem: toolItem,
        targetCount: 1,
        maxActions: task.maxActions,
        maxDurationMs: task.maxDurationMs,
        dangerRadius: task.dangerRadius,
        maxTargetDistance: task.maxTargetDistance,
        maxConsecutiveFailures: task.maxConsecutiveFailures,
        maxExplorationLegs: task.maxExplorationLegs,
        explorationRadius: task.explorationRadius,
        maxRestMs: task.maxRestMs,
      });
      const known = knownBlocks(state, memory, new Set<string>([...minecraftLogNames, "crafting_table", "sweet_berry_bush"]));
      const plan = craftPlan(state, known, craftTask, threats, context);
      if (plan.candidate && available(context, plan.candidate.skillId ?? "")) {
        return record(
          null,
          plan.candidate,
          [],
          `${task.resourceName} needs a tier-${requirement.minPickaxeTier} pickaxe for ${drop} to drop; ${plan.reason}`,
        );
      }
      return record(
        "blocked",
        null,
        [],
        `Cannot mine ${task.resourceName}: it needs a tier-${requirement.minPickaxeTier} pickaxe, none is carried, and ${plan.reason}`,
      );
    }

    const mined = mineCandidates(
      state,
      memory,
      {
        blockNames,
        dropItem: drop,
        dangerRadius: task.dangerRadius,
        maxDistance: task.maxTargetDistance,
        task,
      },
      context,
    ).candidates.filter((candidate) => available(context, candidate.skillId ?? ""));
    if (mined.length > 0) {
      const choice = rankCandidates(mined, context, state, {
        learnable: true,
        previousGoalKey: context.previousGoalKey ?? null,
      });
      return record(
        null,
        choice.selected,
        choice.alternatives,
        `Mine the nearest validated ${task.resourceName} for ${drop}; the inventory delta is checked before the goal counts.`,
      );
    }

    const explore = explorationCandidate(state, memory, task, threats, context, "resource");
    if (explore) {
      return record(null, explore, [], `No reachable ${task.resourceName} is known; explore a bounded unexplored area for one.`);
    }

    const reason =
      mined.length === 0 && mineableTargets(state, memory, blockNames).length === 0
        ? `no ${[...blockNames].join(" or ")} block is observed or remembered, and exploration is exhausted`
        : `${mineCandidates(state, memory, { blockNames, dropItem: drop, dangerRadius: task.dangerRadius, maxDistance: task.maxTargetDistance, task }, context).threatened} target(s) were refused because a hostile is nearby`;
    return record("blocked", null, [], `Cannot mine ${task.resourceName} right now: ${reason}.`);
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
