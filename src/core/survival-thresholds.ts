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
