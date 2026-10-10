import assert from "node:assert/strict";
import { test } from "node:test";
import { MINECRAFT_COLLECT_BLOCK_CAPABILITY } from "../src/games/minecraft/capabilities.js";
import { MAX_NAVIGATION_DISTANCE, navigableGoal } from "../src/games/minecraft/decision-model.js";
import { standingReaches } from "../src/games/minecraft/reach.js";
import { profileAutonomy } from "../src/testing/autonomy-profile.js";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";
import { simulatedWorld } from "../src/testing/simulated-minecraft/scenarios.js";

/*
 * Regression tests for PATH_NOT_FOUND and NAVIGATION_TARGET_TOO_FAR:
 *  - an elevated log (a tree trunk 3+ blocks up) is reachable from the ground, within interaction reach;
 *  - a navigation goal beyond the navigation distance is clamped to a waypoint, not refused;
 *  - an identical navigation or collect input that failed is not sent again in the same run.
 */

test("an elevated target is reached from below only within interaction reach", () => {
  // Standing on the ground (feet y=64) with a log 3 blocks up: reachable when close, not when far away.
  assert.equal(standingReaches(64, { x: 0, y: 67, z: 0 }, 1, 3), true);
  assert.equal(standingReaches(64, { x: 0, y: 67, z: 0 }, 3, 3), true, "3 blocks away is still within reach");
  assert.equal(standingReaches(64, { x: 0, y: 67, z: 0 }, 4, 3), false, "4 blocks away is out of range");
  assert.equal(standingReaches(64, { x: 0, y: 72, z: 0 }, 1, 3), false, "a block 8 up is out of reach");
  // The old rule is unchanged: within two blocks vertically is reached, and blocks below are not reached from above.
  assert.equal(standingReaches(64, { x: 0, y: 66, z: 0 }, 1, 3), true);
  assert.equal(standingReaches(64, { x: 0, y: 60, z: 0 }, 1, 3), false);
});

test("a far navigation goal is clamped to a waypoint on the way, at the bot's height", () => {
  const from = { x: 0, y: 64.7, z: 0 };
  const far = { x: 200, y: 64, z: 0 };
  const waypoint = navigableGoal(from, far);
  const distance = Math.hypot(waypoint.x - from.x, waypoint.z - from.z);
  assert.ok(distance <= MAX_NAVIGATION_DISTANCE, `waypoint is ${distance.toFixed(1)} blocks away, within the navigation limit`);
  assert.ok(waypoint.x > 0 && waypoint.x < far.x, "the waypoint lies on the way to the target");
  assert.equal(waypoint.y, 64, "the waypoint keeps the bot's floored height");

  assert.deepEqual(navigableGoal(from, { x: 10, y: 66, z: 10 }), { x: 10, y: 66, z: 10 }, "a near target is unchanged");
});

test("the simulator collects an elevated log from the ground instead of refusing it as unreachable", async () => {
  const definition = simulatedWorld({
    seed: 1,
    placements: [{ x: 2, y: 67, z: 0, name: "oak_log" }],
  });
  const adapter = new SimulatedMinecraftAdapter({ definition });
  const session = await adapter.connect();
  try {
    const signal = new AbortController().signal;
    const outcome = await adapter.executeAction(
      {
        actionId: "elevated-log-1",
        sessionId: session.id,
        capability: MINECRAFT_COLLECT_BLOCK_CAPABILITY,
        input: { x: 2, y: 67, z: 0, blockName: "oak_log", dangerRadius: 6 },
      },
      signal,
    );
    assert.equal(outcome.confirmed, true, "a log 3 blocks up, within reach from the ground, is collected");
  } finally {
    await adapter.disconnect?.();
  }
});

test("an autonomous run does not repeat an identical failed navigation or collect, and sends no over-long goal", async () => {
  const original = SimulatedMinecraftAdapter.prototype.executeAction;
  const failures: string[] = [];
  let tooFar = 0;
  SimulatedMinecraftAdapter.prototype.executeAction = async function (this: SimulatedMinecraftAdapter, action, signal) {
    try {
      return await original.call(this, action, signal);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NAVIGATION_TARGET_TOO_FAR") tooFar += 1;
      if (action.capability === "minecraft.navigate" || action.capability === MINECRAFT_COLLECT_BLOCK_CAPABILITY) {
        failures.push(`${action.capability}:${JSON.stringify(action.input)}`);
      }
      throw error;
    }
  };
  try {
    await profileAutonomy({ scenario: "explore-remote-log", seed: 101, virtualSeconds: 600 });
    const repeated = failures.length - new Set(failures).size;
    assert.ok(failures.length > 0, "the run exercised failing navigation (the check is not vacuous)");
    assert.equal(repeated, 0, "no identical navigation or collect input failed twice in one run");
    assert.equal(tooFar, 0, "no navigation target is refused as too far");
  } finally {
    SimulatedMinecraftAdapter.prototype.executeAction = original;
  }
});
