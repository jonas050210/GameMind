import assert from "node:assert/strict";
import test from "node:test";
import {
  equipmentTierOf,
  equipmentTierRank,
  extendedContextKey,
  rewardConditionedWeight,
} from "../src/core/learning/episode-extended.js";

test("equipmentTierOf: returns 'none' for null/undefined", () => {
  assert.equal(equipmentTierOf(null), "none");
  assert.equal(equipmentTierOf(undefined), "none");
});

test("equipmentTierOf: identifies wooden tools", () => {
  assert.equal(equipmentTierOf("wooden_pickaxe"), "wooden");
  assert.equal(equipmentTierOf("wooden_sword"), "wooden");
});

test("equipmentTierOf: identifies stone tools", () => {
  assert.equal(equipmentTierOf("stone_pickaxe"), "stone");
});

test("equipmentTierOf: identifies iron tools", () => {
  assert.equal(equipmentTierOf("iron_sword"), "iron");
});

test("equipmentTierOf: identifies diamond tools", () => {
  assert.equal(equipmentTierOf("diamond_pickaxe"), "diamond");
});

test("equipmentTierOf: returns 'none' for unrecognised items", () => {
  assert.equal(equipmentTierOf("apple"), "none");
  assert.equal(equipmentTierOf("dirt"), "none");
});

test("equipmentTierRank: ranks correctly", () => {
  assert.ok(equipmentTierRank("none") < equipmentTierRank("wooden"));
  assert.ok(equipmentTierRank("wooden") < equipmentTierRank("stone"));
  assert.ok(equipmentTierRank("stone") < equipmentTierRank("iron"));
  assert.ok(equipmentTierRank("iron") < equipmentTierRank("diamond"));
});

test("extendedContextKey: returns base key when no extensions", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";
  assert.equal(extendedContextKey(base, {}), base);
});

test("extendedContextKey: appends time of day", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";
  assert.equal(extendedContextKey(base, { timeOfDay: "night" }), `${base}|night`);
});

test("extendedContextKey: skips unknown time of day", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";
  assert.equal(extendedContextKey(base, { timeOfDay: "unknown" }), base);
});

test("extendedContextKey: appends equipment tier when not none", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";
  assert.equal(extendedContextKey(base, { equipmentTier: "iron" }), `${base}|eq:iron`);
});

test("extendedContextKey: skips none equipment tier", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";
  assert.equal(extendedContextKey(base, { equipmentTier: "none" }), base);
});

test("extendedContextKey: appends crafting table flag", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";
  assert.equal(extendedContextKey(base, { hasCraftingTable: true }), `${base}|table`);
});

test("extendedContextKey: combines multiple extensions", () => {
  const base = "minecraft.gather_resource|collect|near|none|ok";
  const key = extendedContextKey(base, {
    timeOfDay: "night",
    equipmentTier: "stone",
    hasCraftingTable: true,
  });
  assert.ok(key.includes(base));
  assert.ok(key.includes("night"));
  assert.ok(key.includes("eq:stone"));
  assert.ok(key.includes("table"));
});

test("rewardConditionedWeight: neutral with no evidence", () => {
  const weight = rewardConditionedWeight(0.5, 0, 0, 5, 0.7, 0.9, 12, 0.75, 1.25);
  assert.equal(weight, 1);
});

test("rewardConditionedWeight: increases for high success and positive reward", () => {
  const weight = rewardConditionedWeight(0.9, 2.0, 20, 5, 0.7, 0.9, 12, 0.75, 1.25);
  assert.ok(weight > 1.0);
});

test("rewardConditionedWeight: decreases for low success and negative reward", () => {
  const weight = rewardConditionedWeight(0.3, -0.5, 20, 5, 0.7, 0.9, 12, 0.75, 1.25);
  assert.ok(weight < 1.0);
});

test("rewardConditionedWeight: clamps to range", () => {
  const low = rewardConditionedWeight(0.1, -2.0, 100, 5, 0.7, 0.9, 12, 0.75, 1.25);
  const high = rewardConditionedWeight(1.0, 3.0, 100, 5, 0.7, 0.9, 12, 0.75, 1.25);
  assert.ok(low >= 0.75);
  assert.ok(high <= 1.25);
});
