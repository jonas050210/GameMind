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

/**
 * Which hostiles the agent may engage, and which it avoids even though they are hostile.
 *
 * Being on the hostile list (`threats.ts`) decides *flee or not*; this table decides *fight or not*. They are
 * separate questions, and before this table existed the answer to the second one was "anything hostile", which
 * meant walking into a creeper with a wooden sword. Every entry says why, because the reason is what the
 * operator reads in the decision log when the agent declines a fight.
 *
 * Anything not listed is **avoided**: an unknown hostile is not a target to experiment on. That default also
 * covers the mobs nobody would fight at this gear level (blaze, ghast, warden, ...) without listing them all.
 */
export type CombatTargetPolicy = "engage" | "avoid";

export interface CombatTargetRule {
  readonly policy: CombatTargetPolicy;
  readonly reason: string;
}

export const minecraftCombatTargets: Readonly<Record<string, CombatTargetRule>> = {
  // Zombie family: melee only, slow, no ranged pressure, 20 health is inside the hit budget with a stone sword.
  zombie: { policy: "engage", reason: "slow and melee-only; 20 health is inside the hit budget" },
  husk: { policy: "engage", reason: "a zombie that does not burn in daylight; same melee-only pressure" },
  drowned: { policy: "engage", reason: "melee-only in water and on land; the trident variant is rare and drops it" },
  // Skeleton family: ranged, so approaching costs health, but it cannot chase effectively and 20 health dies fast.
  skeleton: { policy: "engage", reason: "ranged but fragile and slow to kite; close the gap and it dies in a few swings" },
  stray: { policy: "engage", reason: "a skeleton whose arrows slow; still fragile, but the approach costs more" },
  // Spider family: fast and can climb, but low health and no ranged attack.
  spider: { policy: "engage", reason: "16 health and no ranged attack; the danger is speed, which strafing answers" },
  cave_spider: { policy: "engage", reason: "16 health, but its poison matters — fight it only above the combat floor" },
  slime: { policy: "engage", reason: "8 health and low damage; the cheapest kill available" },
  // Avoided hostiles. Each reason is what makes the fight a bad trade, not a difficulty estimate.
  creeper: { policy: "avoid", reason: "it explodes: a melee kill can land inside the blast, and the agent cannot outrun the fuse at melee range" },
  enderman: { policy: "avoid", reason: "40 health, teleports out of melee, and turns hostile when looked at — the hit budget cannot cover it" },
  bogged: { policy: "avoid", reason: "poison arrows: poison keeps draining health after the fight ends, which no retreat can undo" },
  phantom: { policy: "avoid", reason: "aerial and swooping; melee reach cannot be held, so the fight is a series of unanswerable hits" },
  witch: { policy: "avoid", reason: "throws potions from range and heals itself; 26 health is more than the budget allows" },
  pillager: { policy: "avoid", reason: "crossbow at range with 24 health; the approach costs more than the kill returns" },
  vindicator: { policy: "avoid", reason: "24 health and more melee damage than any weapon the agent can craft early" },
  evoker: { policy: "avoid", reason: "summons vexes, so the fight is never one target and the outnumbered rule would trip mid-swing" },
};

/** Unknown hostile: avoided rather than tried. */
const UNKNOWN_TARGET_RULE: CombatTargetRule = {
  policy: "avoid",
  reason: "not on the engageable list, so it is avoided rather than tested",
};

export function combatTargetRule(hostileName: string): CombatTargetRule {
  const normalized = hostileName.toLowerCase().replaceAll(" ", "_");
  return minecraftCombatTargets[normalized] ?? { ...UNKNOWN_TARGET_RULE, reason: `'${hostileName}' is ${UNKNOWN_TARGET_RULE.reason}` };
}

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
 * Time between melee swings for the held weapon, from vanilla attack speeds (Java 1.20+). A swing sent
 * before the cooldown has elapsed deals reduced damage, so the executor waits this long between swings instead
 * of using one fixed interval. Unknown or no weapon: bare hands (4 swings per second).
 *
 * The table is attacks per second, exactly the value vanilla puts in an item's `attack_speed` attribute, and
 * the cooldown is derived from it (1000 / speed). It used to be a chain of `endsWith` guesses, which got the
 * axes wrong: wooden, stone and golden axes swing at 0.8 (1250 ms), not 1.0, so the agent swung a fifth of a
 * second early and dealt reduced damage on every axe hit but the first.
 */
const HAND_ATTACKS_PER_SECOND = 4;
const minecraftAttackSpeed: Readonly<Record<string, number>> = {
  wooden_sword: 1.6,
  stone_sword: 1.6,
  iron_sword: 1.6,
  diamond_sword: 1.6,
  netherite_sword: 1.6,
  golden_sword: 1.6,
  wooden_axe: 0.8,
  stone_axe: 0.8,
  golden_axe: 0.8,
  iron_axe: 0.9,
  diamond_axe: 1.0,
  netherite_axe: 1.0,
  wooden_pickaxe: 1.2,
  stone_pickaxe: 1.2,
  golden_pickaxe: 1.2,
  iron_pickaxe: 1.2,
  diamond_pickaxe: 1.2,
  netherite_pickaxe: 1.2,
  wooden_shovel: 1.0,
  stone_shovel: 1.0,
  golden_shovel: 1.0,
  iron_shovel: 1.0,
  diamond_shovel: 1.0,
  netherite_shovel: 1.0,
  wooden_hoe: 1.0,
  golden_hoe: 1.0,
  stone_hoe: 2.0,
  iron_hoe: 3.0,
  diamond_hoe: 4.0,
  netherite_hoe: 4.0,
  trident: 1.1,
};

export function attackCooldownMs(weaponName?: string | null): number {
  const speed = weaponName ? minecraftAttackSpeed[weaponName] : undefined;
  return Math.round(1_000 / (speed ?? HAND_ATTACKS_PER_SECOND));
}

/** Attack speed of a weapon in swings per second; null when the item is not in the vanilla table. */
export function attackSpeedOf(weaponName: string): number | null {
  return minecraftAttackSpeed[weaponName] ?? null;
}

/** Every weapon whose damage is known must also have a swing speed, or the executor would guess. */
export function weaponsWithoutAttackSpeed(): readonly string[] {
  return Object.keys(minecraftWeaponDamage).filter((name) => minecraftAttackSpeed[name] === undefined);
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

/** Health used when a hostile is not in the table: as durable as a zombie. */
const DEFAULT_HOSTILE_HEALTH = 20;
/** Upper bound of the attack capability's `maxHits` input (see the capability schema). */
export const MAX_COMBAT_HIT_BUDGET = 6;

/**
 * Swings the agent is allowed for one engagement: the hits needed to kill the hostile with the held weapon, plus
 * one spare swing for armour or a miss, capped at the capability limit. A fixed budget of 4 ended fights against a
 * zombie with a wooden sword (5 hits needed) one hit short.
 */
export function hitBudgetFor(hostileName: string, weaponDamage: number): number {
  const health = minecraftHostileHealth[hostileName] ?? DEFAULT_HOSTILE_HEALTH;
  return Math.min(MAX_COMBAT_HIT_BUDGET, estimatedHitsToKill(weaponDamage, health) + 1);
}

/**
 * Whether the planner may propose defence. The live adapter flag wins once the adapter reports one, so an operator
 * who disarms combat in the Control Center stops the planner too. Otherwise the start-up option decides.
 */
export function combatEnabledForPlanner(startupAllowed: boolean, adapterArmed: boolean | undefined): boolean {
  return adapterArmed ?? startupAllowed;
}

export interface CombatSafetyInput {
  readonly enabled: boolean;
  readonly health: number | null;
  /** Exclusive floor: combat needs health strictly above this (see `COMBAT_MIN_HEALTH`). */
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
  | "COMBAT_TARGET_AVOID"
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
  // Hostile decides *flee or not*; this decides *fight or not*. A creeper is worth fleeing and never worth
  // hitting, and an unlisted hostile is avoided instead of used as an experiment.
  const target = combatTargetRule(input.hostileName);
  if (target.policy === "avoid") {
    return {
      allowed: false,
      code: "COMBAT_TARGET_AVOID",
      reason: `'${input.hostileName}' is avoided: ${target.reason}. The agent flees or shelters instead of engaging.`,
    };
  }
  if (input.health === null) {
    return { allowed: false, code: "COMBAT_HEALTH_TOO_LOW", reason: "Health is unknown; combat is refused." };
  }
  // Exclusive floor: a fight needs health strictly *above* `minHealth`, so at exactly the floor the decision
  // model's rest candidate (which fires at `health <= REST_HEALTH_THRESHOLD`) wins instead of tying with it.
  if (input.health <= input.minHealth) {
    return {
      allowed: false,
      code: "COMBAT_HEALTH_TOO_LOW",
      reason: `Health ${input.health} is at or below the combat floor of ${input.minHealth}; rest and eat instead of fighting.`,
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
