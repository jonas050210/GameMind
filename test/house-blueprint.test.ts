import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLargeHouseBlueprint,
  generateLargeHouseBlueprint,
  type LargeHouseConceptId,
} from "../src/games/minecraft/house-blueprint.js";

const conceptIds: readonly LargeHouseConceptId[] = ["A", "B", "C"];

test("all large-house concepts produce deterministic, bounded, relative two-floor block plans", () => {
  for (const conceptId of conceptIds) {
    const plan = generateLargeHouseBlueprint(conceptId);
    const duplicate = generateLargeHouseBlueprint(conceptId);
    assert.deepEqual(plan, duplicate, `${conceptId} should have a stable offline plan`);
    assert.equal(plan.format, "gamemind-house-blueprint-v1");
    assert.equal(plan.conceptId, conceptId);
    assert.equal(plan.floors, 2);
    assert.deepEqual(plan.origin, { x: 0, y: 0, z: 0 });
    assert.ok(plan.blocks.length > 500);
    assert.ok(plan.blocks.length < 20_000);
    assert.ok(plan.dimensions.x <= 25 && plan.dimensions.z <= 25 && plan.dimensions.y <= 20);
    assert.equal(new Set(plan.blocks.map(({ x, y, z }) => `${x},${y},${z}`)).size, plan.blocks.length);
    assert.ok(plan.blocks.every(({ x, y, z }) =>
      Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
      x >= 0 && x < plan.dimensions.x && y >= 0 && y < plan.dimensions.y && z >= 0 && z < plan.dimensions.z,
    ));
    assert.equal(Object.values(plan.materials).reduce((sum, count) => sum + count, 0), plan.blocks.length);
    assert.equal(plan.layers.reduce((sum, layer) => sum + layer.blockCount, 0), plan.blocks.length);
    assert.ok(plan.rooms.some((room) => room.floor === "ground"));
    assert.ok(plan.rooms.some((room) => room.floor === "upper"));
    assert.ok(plan.warnings.some((warning) => /planning-only/i.test(warning)));
    const summary = formatLargeHouseBlueprint(plan);
    assert.match(summary, new RegExp(`blueprint ${conceptId}:`));
    assert.match(summary, /Material estimate/);
    assert.match(summary, /does not inspect a Minecraft world/i);
  }
});

test("courtyard concept keeps the interior open and never emits out-of-bounds blocks", () => {
  const plan = generateLargeHouseBlueprint("B");
  assert.ok(plan.blocks.every(({ x, z }) => !(x >= 8 && x <= 12 && z >= 7 && z <= 11)));
  assert.ok(plan.blocks.some(({ x, z }) => x === 7 && z >= 7 && z <= 11), "west courtyard wall should be generated outside the open area");
  assert.ok(plan.blocks.some(({ x, z }) => x === 13 && z >= 7 && z <= 11), "east courtyard wall should be generated outside the open area");
});

test("house plans identify optional features they deliberately omit", () => {
  for (const conceptId of conceptIds) {
    const plan = generateLargeHouseBlueprint(conceptId);
    assert.ok(plan.exclusions.length > 0);
    assert.match(formatLargeHouseBlueprint(plan), /Not included:/);
  }
});
