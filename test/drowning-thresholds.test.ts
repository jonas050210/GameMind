/**
 * Drowning thresholds, offline unit tests. The reflex layer and the safety broker must agree at every air value: a
 * stationary action the broker refuses must be one the reflex layer already calls drowning, and the boundary (exactly
 * the threshold) is treated the same way by both. The surfacing threshold is strictly above the action-block threshold,
 * so the agent reacts before actions are refused.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assessReflex } from "../src/games/minecraft/reflex.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { DROWNING_AIR_TICKS, SafetyBroker } from "../src/core/safety-broker.js";
import {
  DROWNING_ACTION_BLOCK_AIR_TICKS,
  DROWNING_FULL_AIR_TICKS,
  DROWNING_SURFACE_AIR_TICKS,
} from "../src/core/survival-thresholds.js";

function observation(player: Record<string, unknown>): MinecraftObservation {
  return {
    player: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      oxygenLevel: 300,
      onGround: true,
      alive: true,
      inWater: false,
      headInWater: false,
      ...player,
    },
    entities: [],
    nearbyBlocks: [],
    inventory: [],
    equipment: {},
  } as unknown as MinecraftObservation;
}

const hasDrowning = (state: MinecraftObservation) => assessReflex(state, null, {}).reasons.some((reason) => reason.code === "DROWNING");

function brokerRefusesStationary(air: number): boolean {
  const broker = new SafetyBroker({ drowningBlockedCapabilities: ["minecraft.rest"] });
  broker.beginRun(`drown-${air}`);
  broker.updateWorld({
    sequence: 1,
    observedAtMs: 1_000,
    health: 20,
    food: 20,
    gameMode: "survival",
    dimension: "minecraft:overworld",
    oxygenTicks: air,
    isBurning: false,
  } as never);
  return broker.evaluate({ capability: "minecraft.rest", risk: "low", nowMs: 1_000 }).code === "DROWNING_RISK";
}

test("the thresholds are one ordered set: surfacing above action-blocking, both below a full breath", () => {
  assert.equal(DROWNING_AIR_TICKS, DROWNING_ACTION_BLOCK_AIR_TICKS, "the broker reads the shared constant");
  assert.ok(DROWNING_SURFACE_AIR_TICKS > DROWNING_ACTION_BLOCK_AIR_TICKS, "the agent surfaces before actions are refused");
  assert.ok(DROWNING_ACTION_BLOCK_AIR_TICKS > 0);
  assert.ok(DROWNING_SURFACE_AIR_TICKS < DROWNING_FULL_AIR_TICKS);
});

test("on land, the drowning reflex and the broker's refusal agree at every air value, including the boundary", () => {
  for (let air = 0; air <= DROWNING_FULL_AIR_TICKS; air += 1) {
    const reflex = hasDrowning(observation({ oxygenLevel: air }));
    const broker = brokerRefusesStationary(air);
    assert.equal(reflex, broker, `air ${air}: reflex=${reflex} broker=${broker} must agree`);
  }
  assert.equal(hasDrowning(observation({ oxygenLevel: DROWNING_ACTION_BLOCK_AIR_TICKS })), true, "exactly the threshold is urgent");
  assert.equal(hasDrowning(observation({ oxygenLevel: DROWNING_ACTION_BLOCK_AIR_TICKS + 1 })), false);
});

test("submerged with the head under water, the agent is told to surface before air reaches the action-block line", () => {
  const surfaceNow = assessReflex(observation({ headInWater: true, inWater: true, oxygenLevel: DROWNING_SURFACE_AIR_TICKS - 1 }), null, {});
  assert.ok(surfaceNow.reasons.some((reason) => reason.code === "DROWNING"), "urgent just below the surfacing threshold");
  const stillFine = assessReflex(observation({ headInWater: true, inWater: true, oxygenLevel: DROWNING_SURFACE_AIR_TICKS + 1 }), null, {});
  assert.equal(stillFine.reasons.some((reason) => reason.code === "DROWNING"), false, "not urgent while the air supply is comfortable");
  assert.ok(stillFine.reasons.some((reason) => reason.code === "IN_WATER"), "being in water is still reported, so the swim decision can run");
});

test("the broker refuses stationary actions below the block line, and the reflex is a superset of that refusal", () => {
  for (let air = 0; air <= DROWNING_FULL_AIR_TICKS; air += 5) {
    if (brokerRefusesStationary(air)) assert.equal(hasDrowning(observation({ oxygenLevel: air })), true, `air ${air}`);
  }
});
