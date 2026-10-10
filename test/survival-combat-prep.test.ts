/**
 * Combat preparation, offline decision tests: an unarmed agent with a hostile close, combat enabled, and the materials
 * and a table already in reach crafts a wooden sword before engaging. When any requirement is missing, it does not
 * plan a fetch; it records which requirement is missing, so the flee decision is explained.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BAND_SAFETY, MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import { block, observationAt, stack } from "./support/observations.js";

const gatherTask = gatherResourceTaskSchema.parse({
  id: "combat-prep-gather",
  kind: "gather_resource",
  resourceName: "oak_log",
  targetCount: 1,
  maxActions: 10,
});

const zombie = { id: "z1", name: "zombie", type: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2, health: 20 };

function unarmedWith(items: ReturnType<typeof stack>[], nearby: ReturnType<typeof block>[]) {
  return observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: nearby,
    entities: [zombie],
    inventory: items,
  });
}

const SKILLS = new Set([
  "minecraft.navigate",
  "minecraft.collect-log",
  "minecraft.attack-hostile",
  "minecraft.craft-item",
  "minecraft.place-crafting-table",
  "minecraft.rest",
  "minecraft.orient",
]);

function decide(state: ReturnType<typeof observationAt>, combatEnabled: boolean) {
  return new MinecraftTaskDecisionModel().decide(
    state,
    gatherTask,
    { excludedTargets: new Set<string>(), previousFailureCode: null, availableSkills: SKILLS, combatEnabled },
    1,
  );
}

test("unarmed, planks and a stick in hand, a table in reach: the agent crafts a sword before engaging", () => {
  const state = unarmedWith([stack("oak_planks", 2), stack("stick", 1)], [block("crafting_table", 2, 64, 0)]);
  const decision = decide(state, true);
  assert.equal(decision.selected?.goalId, "prepare-weapon", "preparing a weapon is chosen over fleeing");
  assert.equal(decision.selected?.priorityBand, BAND_SAFETY);
  assert.equal(decision.selected?.skillId, "minecraft.craft-item");
  const input = decision.selected?.input as { item: string; craftingTable?: { x: number; y: number; z: number } };
  assert.equal(input.item, "wooden_sword");
  assert.deepEqual(input.craftingTable, { x: 2, y: 64, z: 0 }, "the craft is bound to the table that is actually in reach");
});

test("the same agent with combat disabled never plans a weapon: the operator switch still governs fighting", () => {
  const state = unarmedWith([stack("oak_planks", 2), stack("stick", 1)], [block("crafting_table", 2, 64, 0)]);
  const decision = decide(state, false);
  assert.notEqual(decision.selected?.goalId, "prepare-weapon");
});

test("no table in reach: no craft is planned, and the reason names the table", () => {
  const state = unarmedWith([stack("oak_planks", 2), stack("stick", 1)], [block("oak_log", 12, 64, 0)]);
  const decision = decide(state, true);
  assert.notEqual(decision.selected?.goalId, "prepare-weapon");
  const note = (decision.rejected ?? []).find((entry) => entry.goalId === "defend");
  assert.ok(note, "the trace records why defence was not possible");
  assert.match(note.detail, /crafting table/i);
});

test("too few planks: no craft is planned, and the reason states the sword's requirements", () => {
  const state = unarmedWith([stack("oak_planks", 1)], [block("crafting_table", 2, 64, 0)]);
  const decision = decide(state, true);
  assert.notEqual(decision.selected?.goalId, "prepare-weapon");
  const note = (decision.rejected ?? []).find((entry) => entry.goalId === "defend");
  assert.match(note?.detail ?? "", /2 planks and 1 stick/);
});

test("a sword already in the inventory counts as armed: no preparation is planned", () => {
  const state = unarmedWith([stack("wooden_sword", 1), stack("oak_planks", 2), stack("stick", 1)], [block("crafting_table", 2, 64, 0)]);
  const decision = decide(state, true);
  assert.notEqual(decision.selected?.goalId, "prepare-weapon");
});
