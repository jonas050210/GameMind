/**
 * Regression tests for three planner defects found in the live-readiness review:
 *  1. The Control Center combat switch never reached the planner, which read only the start-up flag.
 *  2. Every engagement used a fixed budget of 4 swings, one short of a zombie with a wooden sword.
 *  3. Navigation targets (flee, hazard, sidestep, explore) took the player's own height as the goal height,
 *     so a goal on a hill was a block inside terrain.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMBAT_HIT_BUDGET,
  combatEnabledForPlanner,
  hitBudgetFor,
} from "../src/games/minecraft/combat.js";
import { MinecraftTaskDecisionModel, standingYAt } from "../src/games/minecraft/decision-model.js";
import { gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import { block, observationAt, stack } from "./support/observations.js";

const gatherTask = gatherResourceTaskSchema.parse({
  id: "planner-fix-gather",
  kind: "gather_resource",
  resourceName: "oak_log",
  targetCount: 1,
  maxActions: 10,
});

test("the planner follows the live combat flag: arming in the Control Center counts, disarming stops it", () => {
  assert.equal(combatEnabledForPlanner(false, undefined), false, "no adapter flag: the start-up option (off) decides");
  assert.equal(combatEnabledForPlanner(true, undefined), true, "no adapter flag: the start-up option (on) decides");
  assert.equal(combatEnabledForPlanner(false, true), true, "armed on the adapter at runtime enables the planner");
  assert.equal(combatEnabledForPlanner(true, false), false, "disarmed at runtime disables it even with --allow-combat");
});

test("the hit budget follows the target's health and the held weapon, within the capability limit", () => {
  assert.equal(hitBudgetFor("zombie", 4), 6, "20 health with a wooden sword is 5 hits, plus one spare");
  assert.equal(hitBudgetFor("zombie", 5), 5, "a stone sword needs 4 hits, plus one spare");
  assert.equal(hitBudgetFor("slime", 4), 3, "8 health dies in 2 hits, plus one spare");
  assert.equal(hitBudgetFor("unlisted_mob", 4), 6, "an unknown hostile is treated as durable as a zombie");
  assert.equal(hitBudgetFor("zombie", 1), MAX_COMBAT_HIT_BUDGET, "unarmed swings are capped, never unbounded");
  assert.ok(hitBudgetFor("zombie", 4) <= MAX_COMBAT_HIT_BUDGET);
});

test("a fight with a wooden sword is planned with the full budget, not the old fixed 4", () => {
  const zombie = { id: "z9", name: "zombie", type: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2, health: 20 };
  const state = observationAt(
    { x: 0.5, y: 64, z: 0.5 },
    { entities: [zombie], inventory: [stack("wooden_sword", 1)] },
  );
  const decision = new MinecraftTaskDecisionModel().decide(
    state,
    gatherTask,
    {
      excludedTargets: new Set<string>(),
      previousFailureCode: null,
      availableSkills: new Set(["minecraft.navigate", "minecraft.attack-hostile", "minecraft.orient"]),
      combatEnabled: true,
    },
    1,
  );
  assert.equal(decision.selected?.skillId, "minecraft.attack-hostile");
  assert.equal((decision.selected?.input as { maxHits: number }).maxHits, 6);
});

test("a navigation target takes the ground height at its column, not the player's height", () => {
  // Player stands on y=64. The column 3 blocks east has ground at y=66 (solid block, air above), so the stand cell is 67.
  const state = observationAt(
    { x: 0.5, y: 64, z: 0.5 },
    { nearbyBlocks: [block("stone", 3, 66, 0)] },
  );
  assert.equal(standingYAt(state, 3, 0, 64), 67, "stand on top of the hill, not inside it");
});

test("with no observed ground in the column, the target keeps the player's height", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, { nearbyBlocks: [] });
  assert.equal(standingYAt(state, 9, 9, 64), 64);
});

test("a solid block with another solid block above it is not a standing cell", () => {
  const state = observationAt(
    { x: 0.5, y: 64, z: 0.5 },
    { nearbyBlocks: [block("stone", 2, 65, 0), block("stone", 2, 66, 0)] },
  );
  // The top of the column is solid at 66 with 67 unobserved: the highest block with air above is 66 -> stand at 67.
  assert.equal(standingYAt(state, 2, 0, 64), 67);
});
