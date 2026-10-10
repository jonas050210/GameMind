import type { MinecraftObservation } from "./observation.js";
import { observedHazards } from "./block-classes.js";
import { heldItems } from "./inventory-accounting.js";
import { isMinecraftFoodName } from "./recipes.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { DROWNING_ACTION_BLOCK_AIR_TICKS, DROWNING_SURFACE_AIR_TICKS } from "../../core/survival-thresholds.js";

/**
 * Reflexes are the fast, pure layer of the agent. They read one fresh observation (and optionally the one
 * before it) and report facts that demand an immediate response. They never plan, never act, and never wait
 * for a strategic decision: the observation loop calls them every tick and interrupts a running action when a
 * new urgent reason appears.
 *
 * Thresholds are deliberately conservative and named, so the safety behaviour can be read and tested.
 */

export const REFLEX_THRESHOLDS = {
  criticalHealth: 6,
  lowHealth: 10,
  starvingHunger: 4,
  lowHunger: 8,
  hostileCloseDistance: 4,
  hostileNearDistance: 8,
  hazardUrgentDistance: 2,
  /** Air ticks (0..300, full = 300). Below this the agent is drowning or about to. */
  /** Land reflex: same threshold the safety broker uses to refuse stationary actions (one source, see survival-thresholds). */
  drowningAirTicks: DROWNING_ACTION_BLOCK_AIR_TICKS,
  /**
   * Air ticks below which a submerged head is urgent: a full breath is 300 and air drains one tick at a time
   * underwater, so 200 leaves about ten seconds to reach the surface.
   */
  submergedUrgentAirTicks: DROWNING_SURFACE_AIR_TICKS,
  /** A fall of this many blocks between two fresh observations, without standing on the ground. */
  fallDropBlocks: 3,
  /** Observations older than this cannot justify an action decision. */
  staleAfterMs: 2_000,
} as const;

/** Situations a reflex can report. They describe the world; they are not failures of an action. */
export const REFLEX_CODES = [
  "DEATH",
  "CRITICAL_HEALTH",
  "LOW_HEALTH",
  "STARVING",
  "HUNGER_LOW_NO_FOOD",
  "HOSTILE_CLOSE",
  "HOSTILE_NEAR",
  "HAZARD_NEAR",
  "IN_WATER",
  "DROWNING",
  "FALLING",
  "MOVEMENT_STALLED",
] as const;

export type ReflexCode = (typeof REFLEX_CODES)[number];

export type ReflexSeverity = "urgent" | "notice";

export interface ReflexReason {
  readonly code: ReflexCode;
  readonly severity: ReflexSeverity;
  readonly detail: string;
  /** Distance in blocks when the reason is spatial. */
  readonly distance: number | null;
}

export interface ReflexAssessment {
  readonly observationSequence: number | null;
  readonly observedAt: string | null;
  readonly reasons: readonly ReflexReason[];
  readonly urgent: boolean;
  readonly urgentCodes: readonly ReflexCode[];
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export interface AssessReflexOptions {
  /** True when the agent is trying to move; a position that does not change is then a stalled route. */
  readonly movementExpected?: boolean;
  readonly observationSequence?: number | null;
  readonly observedAt?: string | null;
}

/**
 * Pure assessment of one observation. `previous` is only used for facts that need two observations: a
 * fall (height lost between observations while airborne) and a stalled route.
 */
export function assessReflex(
  state: MinecraftObservation,
  previous: MinecraftObservation | null = null,
  options: AssessReflexOptions = {},
): ReflexAssessment {
  const reasons: ReflexReason[] = [];
  const add = (reason: ReflexReason): void => {
    reasons.push(reason);
  };

  if (state.player.alive === false) {
    add({ code: "DEATH", severity: "urgent", detail: "The player is dead; no action can be taken until respawn.", distance: null });
  }

  const health = state.player.health;
  if (health !== null) {
    if (health <= REFLEX_THRESHOLDS.criticalHealth) {
      add({
        code: "CRITICAL_HEALTH",
        severity: "urgent",
        detail: `Health is ${health.toFixed(1)}, at or below ${REFLEX_THRESHOLDS.criticalHealth}.`,
        distance: null,
      });
    } else if (health <= REFLEX_THRESHOLDS.lowHealth) {
      add({ code: "LOW_HEALTH", severity: "notice", detail: `Health is ${health.toFixed(1)}.`, distance: null });
    }
  }

  const hunger = state.player.food;
  const hasFood = heldItems(state).some((item) => isMinecraftFoodName(item.name));
  if (hunger !== null) {
    if (hunger <= REFLEX_THRESHOLDS.starvingHunger) {
      add({
        code: "STARVING",
        severity: hasFood ? "notice" : "urgent",
        detail: `Hunger is ${hunger}/20${hasFood ? "; food is held, eat now" : " and no food is held"}.`,
        distance: null,
      });
    } else if (hunger <= REFLEX_THRESHOLDS.lowHunger && !hasFood) {
      add({ code: "HUNGER_LOW_NO_FOOD", severity: "notice", detail: `Hunger is ${hunger}/20 and no food is held.`, distance: null });
    }
  }

  const hostiles = state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type));
  if (hostiles.length > 0) {
    const nearest = hostiles.reduce((best, entity) => (entity.distance < best.distance ? entity : best));
    if (nearest.distance <= REFLEX_THRESHOLDS.hostileCloseDistance) {
      add({
        code: "HOSTILE_CLOSE",
        severity: "urgent",
        detail: `${nearest.name} is ${nearest.distance.toFixed(1)} blocks away.`,
        distance: nearest.distance,
      });
    } else if (nearest.distance <= REFLEX_THRESHOLDS.hostileNearDistance) {
      add({
        code: "HOSTILE_NEAR",
        severity: "notice",
        detail: `${nearest.name} is ${nearest.distance.toFixed(1)} blocks away.`,
        distance: nearest.distance,
      });
    }
  }

  const hazards = observedHazards(state.nearbyBlocks, state.player.position);
  const nearestHazard = hazards[0];
  if (nearestHazard && nearestHazard.distance <= REFLEX_THRESHOLDS.hazardUrgentDistance + 0.5) {
    add({
      code: "HAZARD_NEAR",
      severity: "urgent",
      detail: `${nearestHazard.name} is ${nearestHazard.distance.toFixed(1)} blocks away.`,
      distance: nearestHazard.distance,
    });
  }

  if (state.player.oxygenLevel !== null && state.player.oxygenLevel <= REFLEX_THRESHOLDS.drowningAirTicks) {
    add({
      code: "DROWNING",
      severity: "urgent",
      detail: `Air is ${Math.round(state.player.oxygenLevel)}/300 ticks.`,
      distance: null,
    });
  }

  // Water is a state the agent is in, not a hazard next to it. Surfacing is the response; fleeing is not.
  const headInWater = state.player.headInWater === true;
  const air = state.player.oxygenLevel;
  if (headInWater && (air === null || air <= REFLEX_THRESHOLDS.submergedUrgentAirTicks)) {
    add({
      code: "DROWNING",
      severity: "urgent",
      detail: air === null
        ? "Head is under water and the air supply is not reported; surface now."
        : `Head is under water with ${Math.round(air)}/300 air ticks left; surface now.`,
      distance: null,
    });
  } else if (state.player.inWater === true || headInWater) {
    add({
      code: "IN_WATER",
      severity: "notice",
      detail: headInWater
        ? `Head is under water with ${air === null ? "unknown" : Math.round(air)} air ticks.`
        : "Body is in water.",
      distance: null,
    });
  }

  if (previous && previous.player.alive !== false && state.player.alive !== false) {
    const dropped = previous.player.position.y - state.player.position.y;
    const airborne = state.player.onGround === false;
    if (airborne && dropped >= REFLEX_THRESHOLDS.fallDropBlocks) {
      add({
        code: "FALLING",
        severity: "urgent",
        detail: `Dropped ${dropped.toFixed(1)} blocks since the previous observation without standing on the ground.`,
        distance: null,
      });
    }
    if (options.movementExpected) {
      const moved = dist(previous.player.position, state.player.position);
      if (moved < 0.25) {
        add({
          code: "MOVEMENT_STALLED",
          severity: "notice",
          detail: "Position did not change across the last two observations while a route was in progress.",
          distance: null,
        });
      }
    }
  }

  const urgentCodes = [...new Set(reasons.filter((reason) => reason.severity === "urgent").map((reason) => reason.code))];
  return {
    observationSequence: options.observationSequence ?? null,
    observedAt: options.observedAt ?? null,
    reasons,
    urgent: urgentCodes.length > 0,
    urgentCodes,
  };
}

/** Urgent reason codes that appear now but were not urgent in the previous assessment (edge trigger). */
/** A world snapshot a decision was computed from, and the snapshot as it is now. */
export interface ObservedSnapshot {
  readonly state: MinecraftObservation;
  readonly sequence: number;
  readonly observedAt: string;
}

/**
 * Urgent reflexes present in `latest` that the decision's own basis did not have. A non-empty result means a decision
 * made from `decision` must not be dispatched as it is: the world changed in a way that demands an immediate response.
 * Pure, so the stale-decision guard in the task runner can be tested without a running agent.
 */
export function urgentReflexesSince(decision: ObservedSnapshot, latest: ObservedSnapshot): readonly ReflexCode[] {
  if (latest.sequence === decision.sequence) return [];
  const basis = assessReflex(decision.state, null, {
    observationSequence: decision.sequence,
    observedAt: decision.observedAt,
  });
  const now = assessReflex(latest.state, decision.state, {
    observationSequence: latest.sequence,
    observedAt: latest.observedAt,
  });
  return newlyUrgent(now, basis);
}

export function newlyUrgent(current: ReflexAssessment, previous: ReflexAssessment | null): readonly ReflexCode[] {
  const before = new Set(previous?.urgentCodes ?? []);
  return current.urgentCodes.filter((code) => !before.has(code));
}

/** Human-readable explanation of a reflex, for the activity feed and the trace. */
export function describeReflex(assessment: ReflexAssessment): string {
  if (assessment.reasons.length === 0) return "No immediate danger observed.";
  return assessment.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join(" ");
}
