/**
 * Shared drowning thresholds, in air ticks (a full breath is 300; air drains one tick per tick under water).
 * The reflex layer and the safety broker both read these, so they cannot drift apart again.
 *
 *  - DROWNING_SURFACE_AIR_TICKS: head under water below this is an urgent reflex that overrides any task. About ten
 *    seconds of air remain at 200, which is enough to swim out.
 *  - DROWNING_ACTION_BLOCK_AIR_TICKS: at or below this, the broker refuses stationary actions (anything that keeps the
 *    agent in place) unless the capability is the surfacing one.
 *  - Land reflex: a DROWNING reflex also fires on land below DROWNING_ACTION_BLOCK_AIR_TICKS, matching the broker.
 *
 * Ordering invariant (tested): surface > block > 0.
 */
export const DROWNING_SURFACE_AIR_TICKS = 200;
export const DROWNING_ACTION_BLOCK_AIR_TICKS = 80;
export const DROWNING_FULL_AIR_TICKS = 300;

/**
 * Health (half-hearts, 0..20) and hunger (half-drumsticks, 0..20) lines shared by the reflex layer, the
 * decision model and the combat skill. Each number used to be written out in two or three modules; the
 * copies could drift apart without any test noticing, because only the drowning lines had a shared home.
 *
 *  - CRITICAL_HEALTH: at or below this, the reflex layer calls the state critical and combat refuses to start.
 *  - LOW_HEALTH: at or below this, health is a notice and the combat floor ("do not start a fight below").
 *  - CRITICAL_HUNGER: at or below this, the agent is starving and stops working on the task.
 *  - LOW_HUNGER: at or below this, food becomes something worth a detour.
 */
export const CRITICAL_HEALTH = 6;
export const LOW_HEALTH = 10;
export const CRITICAL_HUNGER = 4;
export const LOW_HUNGER = 8;

/**
 * Hunger lines the decision model and the reward shape share: food becomes the agent's priority at or
 * below FOOD_PRIORITY_HUNGER, and health only regenerates from REGEN_HUNGER upwards, which decides
 * whether resting or eating is the recovery path.
 */
export const FOOD_PRIORITY_HUNGER = 14;
export const REGEN_HUNGER = 18;
