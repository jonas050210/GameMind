import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReward,
  DEFAULT_REWARD_CONFIG,
  emptyRewardAggregate,
  updateRewardAggregate,
  parseRewardAggregate,
  type RewardInput,
} from "../src/core/learning/reward.js";

function baseInput(overrides: Partial<RewardInput> = {}): RewardInput {
  return {
    status: "succeeded",
    confirmed: true,
    progress: true,
    safetyDenied: false,
    itemsGained: 1,
    itemsConsumed: 0,
    healthDelta: 0,
    foodDelta: 0,
    durationMs: 1000,
    distanceAfter: null,
    health: 20,
    hunger: 18,
    goalClass: "collect",
    skillId: "minecraft.gather_resource",
    ...overrides,
  };
}

test("computeReward: positive for successful gathering", () => {
  const reward = computeReward(baseInput({ itemsGained: 3 }));
  assert.ok(reward.total > 0);
  assert.ok(reward.progress > 0);
});

test("computeReward: negative progress for failed action", () => {
  const reward = computeReward(
    baseInput({ status: "failed", progress: false, confirmed: false }),
  );
  assert.ok(reward.progress <= 0);
});

test("computeReward: penalises death", () => {
  const reward = computeReward(baseInput({ status: "disconnected" }));
  assert.ok(reward.survival < 0);
  assert.ok(reward.total < 0);
});

test("computeReward: penalises safety denials", () => {
  const safe = computeReward(baseInput({ safetyDenied: false }));
  const denied = computeReward(baseInput({ safetyDenied: true }));
  assert.ok(denied.safety < safe.safety);
});

test("computeReward: penalises health loss", () => {
  const noDamage = computeReward(baseInput({ healthDelta: 0 }));
  const damaged = computeReward(baseInput({ healthDelta: -6 }));
  assert.ok(damaged.survival < noDamage.survival);
});

test("computeReward: rewards health recovery", () => {
  const reward = computeReward(baseInput({ healthDelta: 4 }));
  assert.ok(reward.survival > 0);
});

test("computeReward: efficiency bonus for fast actions", () => {
  const fast = computeReward(baseInput({ durationMs: 300 }));
  const slow = computeReward(baseInput({ durationMs: 4000 }));
  assert.ok(fast.efficiency > slow.efficiency);
});

test("computeReward: rewards eating when hungry", () => {
  const hungry = computeReward(
    baseInput({ hunger: 5, foodDelta: 4, goalClass: "eat" }),
  );
  assert.ok(hungry.progress > 0);
});

test("computeReward: does not over-reward eating when full", () => {
  const full = computeReward(
    baseInput({ hunger: 19, foodDelta: 1, goalClass: "eat" }),
  );
  const hungry = computeReward(
    baseInput({ hunger: 5, foodDelta: 1, goalClass: "eat" }),
  );
  assert.ok(hungry.progress > full.progress);
});

test("computeReward: rewards exploration for explore goals", () => {
  const reward = computeReward(
    baseInput({ goalClass: "explore", distanceAfter: 30 }),
  );
  assert.ok(reward.exploration > 0);
});

test("computeReward: does not reward exploration for non-explore goals", () => {
  const reward = computeReward(
    baseInput({ goalClass: "collect", distanceAfter: 30 }),
  );
  assert.equal(reward.exploration, 0);
});

test("computeReward: caps component values", () => {
  const extreme = computeReward(
    baseInput({ healthDelta: -20, itemsGained: 100 }),
  );
  assert.ok(Math.abs(extreme.survival) <= DEFAULT_REWARD_CONFIG.componentCap);
  assert.ok(Math.abs(extreme.progress) <= DEFAULT_REWARD_CONFIG.componentCap);
});

test("computeReward: returns complete breakdown", () => {
  const reward = computeReward(baseInput());
  assert.ok("survival" in reward);
  assert.ok("progress" in reward);
  assert.ok("efficiency" in reward);
  assert.ok("safety" in reward);
  assert.ok("exploration" in reward);
  assert.ok("total" in reward);
  assert.ok(Number.isFinite(reward.total));
});

test("reward aggregate: starts empty", () => {
  const agg = emptyRewardAggregate();
  assert.equal(agg.count, 0);
  assert.equal(agg.mean, 0);
  assert.equal(agg.ewma, 0);
});

test("reward aggregate: updates mean and EWMA", () => {
  let agg = emptyRewardAggregate();
  agg = updateRewardAggregate(agg, 1.0);
  assert.equal(agg.count, 1);
  assert.equal(agg.mean, 1.0);
  assert.equal(agg.ewma, 1.0);

  agg = updateRewardAggregate(agg, 0.5);
  assert.equal(agg.count, 2);
  assert.equal(agg.mean, 0.75);
});

test("reward aggregate: tracks min and max", () => {
  let agg = emptyRewardAggregate();
  agg = updateRewardAggregate(agg, 1.0);
  agg = updateRewardAggregate(agg, -0.5);
  agg = updateRewardAggregate(agg, 2.0);
  assert.equal(agg.min, -0.5);
  assert.equal(agg.max, 2.0);
});

test("reward aggregate: tracks positive rate", () => {
  let agg = emptyRewardAggregate();
  agg = updateRewardAggregate(agg, 1.0);
  agg = updateRewardAggregate(agg, -0.5);
  agg = updateRewardAggregate(agg, 0.5);
  assert.ok(Math.abs(agg.positiveRate - 2 / 3) < 0.01);
});

test("reward aggregate: parses invalid input", () => {
  const parsed = parseRewardAggregate(null);
  assert.equal(parsed.count, 0);
});
