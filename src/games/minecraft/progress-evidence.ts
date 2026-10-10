import type { MinecraftObservation } from "./observation.js";
import { isHostileMinecraftEntity } from "./threats.js";

/**
 * What a successful action that gained no item and no food can still prove about the world.
 *
 * The task runner used to call an action "progress" only when the inventory or the food bar went up. Everything that is
 * not gathering was therefore counted as wasted effort and recorded as "no progress": every leg of exploration, every
 * approach to a distant tree, every rest, every retreat from a hostile. Two consumers read that flag and drew the wrong
 * conclusion from it. The autonomy controller judges a subgoal by it, so a subgoal that explored and came back with a
 * map but no logs was scored "no progress" and, after a few of those, put on cooldown until the agent had nothing it was
 * willing to do. And the "wasted actions" figure in every evaluation overstated waste by counting legitimate movement.
 *
 * Each rule below is a before/after comparison of two observations, never a claim the adapter makes about itself. The
 * caller applies them to verified successes only: a walk that timed out part-way is not progress, whatever the distance.
 */
export interface MovementEvidenceInput {
  readonly skillId: string;
  readonly goalId: string;
  /** True for a safety-band action (flee, sidestep, shelter): its purpose is to get away from a threat. */
  readonly safetyBand: boolean;
  /** True for a skill that moves the player toward the position in `input`. */
  readonly movesToTarget: boolean;
  readonly input: unknown;
  readonly before: MinecraftObservation;
  readonly after: MinecraftObservation;
  /** Map cells the action revealed that the agent had never observed. */
  readonly cellsRevealed: number;
}

export interface ProgressEvidence {
  readonly progress: boolean;
  /** The measurement behind the verdict, in words; null when there is none. */
  readonly evidence: string | null;
}

/**
 * Names the rules for "progress" and "wasted action": item and food gains in the task runner, plus the rules in this file.
 * It is part of an evaluation set's identity, so figures measured under another definition are never compared with these
 * (v1 counted item and food gains only, which scored every move, rest and retreat as waste).
 */
export const PROGRESS_DEFINITION = "verified-world-progress.v2";

/** An approach must end at least this much closer to its target to count. */
export const CLOSER_BY_BLOCKS = 1;
/** A retreat must open at least this much distance to the nearest hostile (or leave none in view). */
export const RETREAT_BY_BLOCKS = 2;
/** A rest must raise health by at least this much. */
export const HEALTH_GAIN_POINTS = 1;

const NO_PROGRESS: ProgressEvidence = { progress: false, evidence: null };

/** Distance from the player to the x/z target in `input`, or null when the input names no position. */
export function distanceToInputTarget(state: MinecraftObservation, input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.z !== "number") return null;
  const y = typeof record.y === "number" ? record.y : state.player.position.y;
  return Math.hypot(record.x + 0.5 - state.player.position.x, y - state.player.position.y, record.z + 0.5 - state.player.position.z);
}

/** Distance to the nearest hostile entity in view, or null when none is. */
export function nearestHostileDistance(state: MinecraftObservation): number | null {
  const distances = state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type)).map((entity) => entity.distance);
  return distances.length === 0 ? null : Math.min(...distances);
}

const blocks = (value: number): string => `${value.toFixed(1)} block${value.toFixed(1) === "1.0" ? "" : "s"}`;

export function observedMovementProgress(input: MovementEvidenceInput): ProgressEvidence {
  if (input.goalId.startsWith("explore:") && input.cellsRevealed >= 1) {
    return { progress: true, evidence: `revealed ${input.cellsRevealed} map cell${input.cellsRevealed === 1 ? "" : "s"} the agent had never seen` };
  }

  if (input.movesToTarget) {
    const before = distanceToInputTarget(input.before, input.input);
    const after = distanceToInputTarget(input.after, input.input);
    if (before !== null && after !== null && before - after >= CLOSER_BY_BLOCKS) {
      return { progress: true, evidence: `ended ${blocks(before - after)} closer to its target (${blocks(before)} → ${blocks(after)})` };
    }
  }

  if (input.skillId === "minecraft.rest") {
    const before = input.before.player.health;
    const after = input.after.player.health;
    if (before !== null && after !== null && after - before >= HEALTH_GAIN_POINTS) {
      return { progress: true, evidence: `health rose from ${before} to ${after}` };
    }
  }

  if (input.safetyBand) {
    const before = nearestHostileDistance(input.before);
    const after = nearestHostileDistance(input.after);
    if (before !== null && after === null) {
      return { progress: true, evidence: `no hostile is in view any more (the nearest was ${blocks(before)} away)` };
    }
    if (before !== null && after !== null && after - before >= RETREAT_BY_BLOCKS) {
      return { progress: true, evidence: `the nearest hostile is now ${blocks(after)} away (was ${blocks(before)})` };
    }
  }

  return NO_PROGRESS;
}
