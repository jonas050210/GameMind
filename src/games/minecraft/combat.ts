/**
 * Combat knowledge. This project treats attacking as the highest-risk capability it has, so the
 * tables here exist mainly to express when *not* to fight: the safety conditions are hard-coded into
 * `combatIsAllowed` and are re-checked by the adapter at the moment of the swing.
 */

import { isHostileMinecraftEntity } from "./threats.js";

/** Java Edition 1.20.4 damage per swing for the weapons the agent can craft. */
export const minecraftWeaponDamage: Readonly<Record<string, number>> = {
  wooden_sword: 4,
  stone_sword: 5,
  iron_sword: 7,
  diamond_sword: 8,
  netherite_sword: 9,
  golden_sword: 4,
  wooden_axe: 7,
  stone_axe: 9,
  iron_axe: 9,
  diamond_axe: 9,
};

export const UNARMED_DAMAGE = 1;

/** Base health of hostiles the agent may meet. Unknown entities are assumed as durable as a zombie. */
export const minecraftHostileHealth: Readonly<Record<string, number>> = {
  zombie: 20,
  husk: 20,
  drowned: 20,
  skeleton: 20,
  stray: 20,
  bogged: 16,
  spider: 16,
  cave_spider: 16,
  creeper: 20,
  enderman: 40,
  slime: 8,
  phantom: 20,
  witch: 26,
  pillager: 24,
  vindicator: 24,
  evoker: 24,
};

const ATTACK_COOLDOWN_MS = 600;

export function weaponDamageFor(itemName: string | null | undefined): number {
  if (!itemName) return UNARMED_DAMAGE;
  return minecraftWeaponDamage[itemName] ?? UNARMED_DAMAGE;
}

/** Best weapon in the given items, preferring swords (faster cooldown, no durability penalty on blocks). */
export function bestWeapon(items: Iterable<{ readonly name: string }>): { name: string; damage: number } | null {
  let best: { name: string; damage: number } | null = null;
  for (const item of items) {
    const damage = minecraftWeaponDamage[item.name];
    if (damage === undefined) continue;
    const isSword = item.name.endsWith("_sword");
    const bestIsSword = best !== null && best.name.endsWith("_sword");
    if (
      best === null ||
      (isSword && !bestIsSword) ||
      (isSword === bestIsSword && damage > best.damage)
    ) {
      best = { name: item.name, damage };
    }
  }
  return best;
}

/**
 * Time between melee swings for the held weapon, from approximate vanilla attack speeds (Java 1.20+). A swing
 * sent before the cooldown has elapsed deals reduced damage, so the executor waits this long between swings instead
 * of using one fixed interval. Unknown or no weapon: bare hands (4 swings per second).
 */
const HAND_COOLDOWN_MS = 250;
export function attackCooldownMs(weaponName?: string | null): number {
  if (!weaponName) return HAND_COOLDOWN_MS;
  if (weaponName.endsWith("_sword")) return 625;
  if (weaponName.endsWith("_axe")) return weaponName.startsWith("iron_") ? 1_100 : 1_000;
  if (weaponName.endsWith("_pickaxe")) return 833;
  if (weaponName.endsWith("_shovel") || weaponName.endsWith("_hoe")) return 1_000;
  if (weaponName === "trident") return 909;
  return ATTACK_COOLDOWN_MS;
}

/** Survival melee reach, in blocks, measured from the eye to the target's bounding box. */
export const MELEE_REACH_BLOCKS = 3;
/**
 * A hostile is engaged only within this distance (blocks, to its feet). The executor closes the gap with
 * pathfinder, so this is the approach limit, not the swing reach. Decision and adapter share it.
 */
export const COMBAT_APPROACH_MAX_BLOCKS = 8;

export function estimatedHitsToKill(weaponDamage: number, hostileHealth: number): number {
  return Math.max(1, Math.ceil(hostileHealth / Math.max(0.5, weaponDamage)));
}

export interface CombatSafetyInput {
  readonly enabled: boolean;
  readonly health: number | null;
  readonly minHealth: number;
  readonly retreatHealth: number;
  readonly hostileCountNearby: number;
  readonly maxEngageableHostiles: number;
  readonly weapon: { name: string; damage: number } | null;
  readonly requiredDamage: number;
  readonly targetDistance: number;
  readonly maxTargetDistance: number;
  readonly hitsAlreadyAttempted: number;
  readonly maxHits: number;
  readonly hostileName: string;
  readonly hostileType: string;
  readonly hunger: number | null;
}

export type CombatVerdict =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly code: MinecraftCombatCode; readonly reason: string };

export type MinecraftCombatCode =
  | "COMBAT_DISABLED"
  | "COMBAT_TARGET_INVALID"
  | "COMBAT_NO_WEAPON"
  | "COMBAT_HEALTH_TOO_LOW"
  | "COMBAT_OUTNUMBERED"
  | "COMBAT_HIT_BUDGET"
  | "COMBAT_OUT_OF_RANGE"
  | "COMBAT_EXHAUSTED";

/**
 * All combat preconditions in one pure function so they can be unit-tested and reused: the decision
 * model uses it to decide whether a defend candidate may exist at all, and the adapter re-checks it
 * immediately before swinging.
 */
export function combatIsAllowed(input: CombatSafetyInput): CombatVerdict {
  if (!input.enabled) {
    return {
      allowed: false,
      code: "COMBAT_DISABLED",
      reason: "Combat is not enabled for this run; the agent flees instead of attacking.",
    };
  }
  if (!isHostileMinecraftEntity(input.hostileName, input.hostileType)) {
    return {
      allowed: false,
      code: "COMBAT_TARGET_INVALID",
      reason: `'${input.hostileName}' is not on the hostile list; attacking is refused.`,
    };
  }
  if (input.health === null) {
    return { allowed: false, code: "COMBAT_HEALTH_TOO_LOW", reason: "Health is unknown; combat is refused." };
  }
  if (input.health < input.minHealth) {
    return {
      allowed: false,
      code: "COMBAT_HEALTH_TOO_LOW",
      reason: `Health ${input.health} is below the combat floor of ${input.minHealth}; retreat instead.`,
    };
  }
  if (input.weapon === null || input.weapon.damage < input.requiredDamage) {
    return {
      allowed: false,
      code: "COMBAT_NO_WEAPON",
      reason: `No weapon dealing at least ${input.requiredDamage} damage is available${
        input.weapon ? ` (best is ${input.weapon.name} at ${input.weapon.damage})` : ""
      }; attacking would only prolong the fight.`,
    };
  }
  if (input.hostileCountNearby > input.maxEngageableHostiles) {
    return {
      allowed: false,
      code: "COMBAT_OUTNUMBERED",
      reason: `${input.hostileCountNearby} hostiles are nearby (limit ${input.maxEngageableHostiles}); retreat instead of engaging.`,
    };
  }
  if (input.targetDistance > input.maxTargetDistance) {
    return {
      allowed: false,
      code: "COMBAT_OUT_OF_RANGE",
      reason: `The hostile is ${input.targetDistance.toFixed(1)} blocks away, beyond the ${input.maxTargetDistance}-block reach limit.`,
    };
  }
  if (input.hitsAlreadyAttempted >= input.maxHits) {
    return {
      allowed: false,
      code: "COMBAT_HIT_BUDGET",
      reason: `The hit budget of ${input.maxHits} is spent; withdraw rather than extend the fight.`,
    };
  }
  if (input.hunger !== null && input.hunger <= 2) {
    return {
      allowed: false,
      code: "COMBAT_EXHAUSTED",
      reason: `Hunger is ${input.hunger}/20; fighting while nearly starving risks a death the agent cannot recover from.`,
    };
  }
  return {
    allowed: true,
    reason: `Engage with ${input.weapon.name} (${input.weapon.damage} damage) while health is ${input.health.toFixed(1)}.`,
  };
}
