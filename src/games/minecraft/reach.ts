/**
 * Shared by the live adapter and the simulator, so both judge "close enough to act" the same way.
 */
/** Eye height above the feet, and the client's block-interaction reach. */
const EYE_HEIGHT = 1.62;
const INTERACTION_REACH = 4.5;

/**
 * Whether a player standing at `standingY`, `horizontal` blocks from a target block's centre, can act on it.
 * A target within two blocks vertically is reached as before. An elevated target (a log in a tree) is reached
 * from below when its centre is within interaction reach of the eye. Targets below the feet keep the old rule.
 */
export function standingReaches(
  standingY: number,
  target: { readonly x: number; readonly y: number; readonly z: number },
  horizontal: number,
  range: number,
): boolean {
  if (horizontal > range) return false;
  const dy = target.y - standingY;
  if (Math.abs(dy) <= 2) return true;
  if (dy <= 0) return false;
  const vertical = target.y + 0.5 - (standingY + EYE_HEIGHT);
  return Math.hypot(horizontal, vertical) <= INTERACTION_REACH;
}
