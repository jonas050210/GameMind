import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeReward, DEFAULT_REWARD_CONFIG, type RewardInput } from "../src/core/learning/reward.js";
import { InvalidWorldSeedError, normalizeWorldSeed, WorldSeedStore } from "../src/games/minecraft/world-seed.js";

function rewardInput(overrides: Partial<RewardInput> = {}): RewardInput {
  return {
    status: "failed",
    confirmed: false,
    progress: false,
    safetyDenied: false,
    itemsGained: 0,
    itemsConsumed: 0,
    healthDelta: 0,
    foodDelta: 0,
    durationMs: 800,
    distanceAfter: null,
    health: 20,
    hunger: 20,
    goalClass: "collect",
    skillId: "test-skill",
    ...overrides,
  } as RewardInput;
}

test("reward: repeated failures on one target cost more than a first failure", () => {
  const first = computeReward(rewardInput({ attemptsOnTarget: 1 }), DEFAULT_REWARD_CONFIG);
  const repeated = computeReward(rewardInput({ attemptsOnTarget: 4 }), DEFAULT_REWARD_CONFIG);
  assert.equal(first.waste, 0);
  assert.ok(repeated.waste < 0, "a fourth failed attempt on the same target is penalised");
  assert.ok(repeated.total < first.total);
});

test("reward: prolonged inactivity without progress is penalised", () => {
  const brief = computeReward(rewardInput({ durationMs: 800 }), DEFAULT_REWARD_CONFIG);
  const idle = computeReward(rewardInput({ durationMs: 9_000 }), DEFAULT_REWARD_CONFIG);
  assert.ok(idle.waste < brief.waste, "a long action that changed nothing is inactivity");
});

test("reward: wandering that does not close the distance to an explore goal is penalised, closing it is not", () => {
  const wandering = computeReward(
    rewardInput({ goalClass: "explore", distanceBefore: 10, distanceAfter: 12 }),
    DEFAULT_REWARD_CONFIG,
  );
  const approaching = computeReward(
    rewardInput({ goalClass: "explore", distanceBefore: 10, distanceAfter: 4 }),
    DEFAULT_REWARD_CONFIG,
  );
  assert.ok(wandering.waste < approaching.waste, "moving away from the goal is worse than moving toward it");
  assert.equal(approaching.waste, 0);
});

test("reward: consumed resources that produced nothing are waste; a recovery after failures earns a bonus", () => {
  const wasted = computeReward(rewardInput({ itemsConsumed: 3 }), DEFAULT_REWARD_CONFIG);
  assert.ok(wasted.waste < 0);
  const recovered = computeReward(
    rewardInput({ status: "succeeded", progress: true, itemsGained: 1, attemptsOnTarget: 2, durationMs: 800 }),
    DEFAULT_REWARD_CONFIG,
  );
  assert.ok(recovered.waste > 0, "reaching the target after earlier failures is rewarded");
  assert.ok(Object.keys(recovered).includes("waste"), "the breakdown names the term");
});

test("world seed: numeric seeds, text seeds, empty clears, and invalid values are refused", () => {
  assert.equal(normalizeWorldSeed("  12345 "), "12345");
  assert.throws(() => normalizeWorldSeed(BigInt(1) as never), InvalidWorldSeedError, "non-text, non-number input is refused");
  assert.equal(normalizeWorldSeed("-9223372036854775808"), "-9223372036854775808", "the Java long minimum is accepted");
  assert.equal(normalizeWorldSeed("abc def"), "abc def", "text seeds are accepted");
  assert.equal(normalizeWorldSeed("   "), null, "blank clears the seed");
  assert.equal(normalizeWorldSeed(42), "42");
  assert.throws(() => normalizeWorldSeed("9223372036854775808"), InvalidWorldSeedError);
  assert.throws(() => normalizeWorldSeed("x".repeat(65)), /at most 64/);
  assert.throws(() => normalizeWorldSeed("bad\u0001seed"), /control characters/);
  assert.throws(() => normalizeWorldSeed({ seed: 1 }), /text or a number/);
});

test("world seed: the store persists atomically, reloads, and reports an unreadable file instead of guessing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamemind-seed-"));
  try {
    const path = join(directory, "world-config.json");
    const store = new WorldSeedStore(path);
    assert.equal(store.value, null);
    store.set("8675309");
    const reloaded = new WorldSeedStore(path);
    assert.equal(reloaded.value, "8675309");
    assert.equal(reloaded.error, null);
    const written = JSON.parse(await readFile(path, "utf8")) as { seed: string };
    assert.equal(written.seed, "8675309");

    await writeFile(path, "{not json", "utf8");
    const broken = new WorldSeedStore(path);
    assert.equal(broken.value, null, "an unreadable file yields no seed");
    assert.match(broken.error ?? "", /Could not read/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
