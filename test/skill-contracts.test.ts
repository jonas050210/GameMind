import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pino from "pino";
import type { AdapterAction, AdapterActionOutcome } from "../src/core/types.js";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { MINECRAFT_COLLECT_BLOCK_CAPABILITY } from "../src/games/minecraft/capabilities.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import { MinecraftTaskRunner } from "../src/games/minecraft/task-runner.js";
import { verifySkillPostcondition } from "../src/games/minecraft/skill-contracts.js";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";
import { simulatedWorld, treeAt } from "../src/testing/simulated-minecraft/scenarios.js";
import { observationAt } from "./support/observations.js";

function item(name: string, count: number) {
  return { slot: 9, name, type: 1, count, metadata: null, durabilityUsed: null };
}

test("navigation contract checks the observed position, not the adapter's claim", () => {
  const before = observationAt({ x: 0.5, y: 64, z: 0.5 });
  const arrived = observationAt({ x: 5.5, y: 64, z: 0.5 });
  const stillThere = observationAt({ x: 0.5, y: 64, z: 0.5 });
  assert.equal(verifySkillPostcondition("minecraft.navigate", { x: 5, y: 64, z: 0, range: 1 }, before, arrived).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.navigate", { x: 5, y: 64, z: 0, range: 1 }, before, stillThere).verified, false);
});

test("inventory-gain contracts require an observed increase of the target item", () => {
  const before = observationAt({ x: 0, y: 64, z: 0 });
  const gained = observationAt({ x: 0, y: 64, z: 0 }, { inventory: [item("oak_log", 1)] });
  assert.equal(verifySkillPostcondition("minecraft.collect-log", { blockName: "oak_log" }, before, gained).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.collect-log", { blockName: "oak_log" }, before, before).verified, false);
  assert.equal(verifySkillPostcondition("minecraft.pickup-item", { itemName: "bread" }, before, before).verified, false);
});

test("eating needs both a hunger increase and a consumed item", () => {
  const before = observationAt({ x: 0, y: 64, z: 0 }, {
    player: { ...observationAt({ x: 0, y: 64, z: 0 }).player, food: 6 },
    inventory: [item("bread", 1)],
  });
  const fed = observationAt({ x: 0, y: 64, z: 0 }, {
    player: { ...observationAt({ x: 0, y: 64, z: 0 }).player, food: 11 },
    inventory: [],
  });
  assert.equal(verifySkillPostcondition("minecraft.eat-food", { item: "bread" }, before, fed).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.eat-food", { item: "bread" }, before, before).verified, false);
});

test("rest and table-placement contracts check health and the placed block", () => {
  const before = observationAt({ x: 0, y: 64, z: 0 }, { player: { ...observationAt({ x: 0, y: 64, z: 0 }).player, health: 8 } });
  const healed = observationAt({ x: 0, y: 64, z: 0 }, { player: { ...observationAt({ x: 0, y: 64, z: 0 }).player, health: 9 } });
  assert.equal(verifySkillPostcondition("minecraft.rest", {}, before, healed).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.rest", {}, before, before).verified, false);

  const placed = observationAt({ x: 0, y: 64, z: 0 }, {
    nearbyBlocks: [{ position: { x: 2, y: 64, z: 2 }, name: "crafting_table", type: 1, boundingBox: "block" }],
  });
  assert.equal(verifySkillPostcondition("minecraft.place-crafting-table", { x: 2, y: 64, z: 2 }, before, placed).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.place-crafting-table", { x: 3, y: 64, z: 2 }, before, placed).verified, false);
});

test("without a post-action observation a contract is unavailable rather than passed", () => {
  const result = verifySkillPostcondition("minecraft.collect-log", { blockName: "oak_log" }, observationAt({ x: 0, y: 64, z: 0 }), null);
  assert.equal(result.verified, null);
});

/** An adapter that reports success for collection without changing the world. */
class ConfirmingLiarAdapter extends SimulatedMinecraftAdapter {
  override async executeAction(action: AdapterAction, signal: AbortSignal): Promise<AdapterActionOutcome> {
    if (action.capability === MINECRAFT_COLLECT_BLOCK_CAPABILITY) {
      return { confirmed: true, confirmation: "unsupported_claim", details: {} };
    }
    return super.executeAction(action, signal);
  }
}

test("a confirmation that the next observation contradicts is not credited as progress", async () => {
  const logger = pino({ level: "silent" });
  const adapter = new ConfirmingLiarAdapter({
    definition: simulatedWorld({ seed: 21, placements: treeAt(3, 0, 1) }),
  });
  const trace = new TraceRecorder(new MemoryTraceSink(), logger);
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);
  const runner = new MinecraftTaskRunner(runtime, skills, new MinecraftTaskDecisionModel(), logger, {
    clock: () => adapter.simulatedNowMs,
  });
  const result = await runner.run(gatherResourceTaskSchema.parse({
    id: `liar-${randomUUID().slice(0, 4)}`,
    resourceName: "oak_log",
    targetCount: 1,
    maxExplorationLegs: 0,
  }));

  assert.notEqual(result.status, "succeeded");
  assert.equal(result.metrics.taskSucceeded, false);
  assert.equal(result.metrics.resourceCollected, 0);
  assert.equal(result.metrics.unverifiedConfirmations, 1);
  assert.equal(result.actions[0]?.verification, "unverified");
  assert.equal(result.actions[0]?.failureCode, null, "the adapter's own status stays visible");
  assert.equal(adapter.world.countItem("oak_log"), 0);
  await runtime.shutdown("liar test complete");
});

test("contracts for orientation and equipment compare the observed state", () => {
  const observed: MinecraftObservation = observationAt({ x: 0, y: 64, z: 0 }, {
    player: { ...observationAt({ x: 0, y: 64, z: 0 }).player, orientation: { yaw: 1.5, pitch: 0 } },
  });
  assert.equal(verifySkillPostcondition("minecraft.orient", { yaw: 1.5, pitch: 0 }, null, observed).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.orient", { yaw: -1.5, pitch: 0 }, null, observed).verified, false);
  const equipped = observationAt({ x: 0, y: 64, z: 0 }, {
    equipment: { ...observationAt({ x: 0, y: 64, z: 0 }).equipment, head: item("oak_log", 1) },
  });
  assert.equal(verifySkillPostcondition("minecraft.equip-item", { item: "oak_log", destination: "head" }, null, equipped).verified, true);
});

test("without a pre-action observation an inventory change is unknown, not zero", () => {
  // The task runner can end up without a "before" observation (the action failed first, or the world state was
  // dropped). Treating that as "nothing was gained" reported a plain failure where the truth is unknown, and it
  // hid a real success whenever the agent already had the item before the action started.
  const after = observationAt({ x: 0, y: 64, z: 0 }, { inventory: [item("oak_log", 1)] });
  assert.equal(verifySkillPostcondition("minecraft.collect-log", { blockName: "oak_log" }, null, after).verified, null);
  assert.equal(verifySkillPostcondition("minecraft.pickup-item", { itemName: "bread" }, null, after).verified, null);
  assert.equal(verifySkillPostcondition("minecraft.harvest-berries", { blockName: "sweet_berry_bush" }, null, after).verified, null);
  assert.equal(verifySkillPostcondition("minecraft.drop-item", { itemName: "oak_log", count: 1 }, null, after).verified, null);
  const eatAfter = observationAt({ x: 0, y: 64, z: 0 }, {
    player: { ...observationAt({ x: 0, y: 64, z: 0 }).player, food: 12 },
    inventory: [item("bread", 1)],
  });
  assert.equal(verifySkillPostcondition("minecraft.eat-food", { item: "bread" }, null, eatAfter).verified, null);

  // The same observation with a known baseline is still verified by the delta alone.
  const before = observationAt({ x: 0, y: 64, z: 0 });
  assert.equal(verifySkillPostcondition("minecraft.collect-log", { blockName: "oak_log" }, before, after).verified, true);
});

test("mining and crafting fall back to what the observation can still prove", () => {
  // The block is gone from the observation: mining is proven independently of any inventory delta.
  const before = observationAt({ x: 0, y: 64, z: 0 }, { nearbyBlocks: [{ name: "coal_ore", position: { x: 2, y: 64, z: 0 }, type: 0, boundingBox: "block", distance: 2 }] });
  const after = observationAt({ x: 0, y: 64, z: 0 }, { inventory: [item("coal", 1)] });
  assert.equal(verifySkillPostcondition("minecraft.mine-block", { blockName: "coal_ore", x: 2, y: 64, z: 0 }, before, after).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.mine-block", { blockName: "coal_ore", x: 2, y: 64, z: 0 }, null, after).verified, true);
  // The ore drop table is shared with the miner, so raw_iron is the item that counts, not iron_ore.
  const iron = observationAt({ x: 0, y: 64, z: 0 }, { inventory: [item("raw_iron", 1)] });
  assert.equal(verifySkillPostcondition("minecraft.mine-block", { blockName: "iron_ore", x: 2, y: 64, z: 0 }, before, iron).verified, true);
  // With a baseline and the block still present, nothing is proven.
  const stillThere = observationAt({ x: 0, y: 64, z: 0 }, { nearbyBlocks: [{ name: "coal_ore", position: { x: 2, y: 64, z: 0 }, type: 0, boundingBox: "block", distance: 2 }] });
  assert.equal(verifySkillPostcondition("minecraft.mine-block", { blockName: "coal_ore", x: 2, y: 64, z: 0 }, before, stillThere).verified, false);
  // Crafting without a baseline: the requested amount being present is the only provable part.
  assert.equal(verifySkillPostcondition("minecraft.craft-item", { item: "stick", count: 4 }, null, after).verified, false);
  const sticks = observationAt({ x: 0, y: 64, z: 0 }, { inventory: [item("stick", 4)] });
  assert.equal(verifySkillPostcondition("minecraft.craft-item", { item: "stick", count: 4 }, null, sticks).verified, true);
});
