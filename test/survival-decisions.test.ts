import assert from "node:assert/strict";
import test from "node:test";
import {
  MinecraftTaskDecisionModel,
  type MinecraftDecisionContext,
} from "../src/games/minecraft/decision-model.js";
import {
  craftItemTaskSchema,
  DEFAULT_GATHER_LOG_TASK,
  gatherResourceTaskSchema,
  secureFoodTaskSchema,
  type MinecraftTask,
} from "../src/games/minecraft/task.js";
import { WorldMemory } from "../src/games/minecraft/world-memory.js";
import { block, observationAt } from "./support/observations.js";

const origin = { x: 0.5, y: 64, z: 0.5 };
const model = new MinecraftTaskDecisionModel();

function context(overrides: Partial<MinecraftDecisionContext> = {}): MinecraftDecisionContext {
  return { excludedTargets: new Set<string>(), previousFailureCode: null, ...overrides };
}

function item(name: string, count: number, slot = 9) {
  return { slot, name, type: 1, count, metadata: null, durabilityUsed: null };
}

function hostile(id: string, x: number, z: number, name = "zombie") {
  return { id, name, type: "hostile", position: { x, y: origin.y, z }, distance: Math.hypot(x - origin.x, z - origin.z), health: 20 };
}

function sighting(name: string, x: number, y: number, z: number, properties?: Record<string, string | number | boolean>) {
  return {
    name,
    position: { x, y, z },
    distance: Math.hypot(x + 0.5 - origin.x, y - origin.y, z + 0.5 - origin.z),
    ...(properties ? { properties } : {}),
  };
}

function dropAt(name: string, x: number, z: number) {
  return { id: `${name}-${x}-${z}`, name, count: 1, position: { x: x + 0.5, y: 64.2, z: z + 0.5 }, distance: Math.hypot(x - origin.x, z - origin.z) };
}

const gather = DEFAULT_GATHER_LOG_TASK;
const secure: MinecraftTask = secureFoodTaskSchema.parse({ id: "secure", kind: "secure_food", targetHunger: 18 });

test("hostile avoidance outranks eating, food sourcing, and gathering", () => {
  const state = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 5 },
    inventory: [item("bread", 1)],
    entities: [hostile("z1", origin.x + 3, origin.z)],
    nearbyBlocks: [block("oak_log", 2, 64, 0)],
  });
  const decision = model.decide(state, gather, context());
  assert.equal(decision.selected?.goalId, "avoid-nearby-hostile");
  assert.equal(decision.selected?.priorityBand, 0);
  assert.equal(decision.band, 0);
});

test("food is eaten only when hunger is at or below the survival threshold", () => {
  const hungry = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 14 },
    inventory: [item("bread", 1)],
  });
  assert.equal(model.decide(hungry, gather, context()).selected?.goalId, "restore-hunger");

  const satisfied = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 15 },
    inventory: [item("bread", 1)],
    nearbyBlocks: [block("oak_log", 1, 64, 0)],
  });
  assert.notEqual(model.decide(satisfied, gather, context()).selected?.goalId, "restore-hunger");
});

test("eating prefers the most nutritious food that does not overfill the hunger bar", () => {
  const state = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 9 },
    inventory: [item("apple", 1, 9), item("cooked_beef", 1, 10)],
  });
  const decision = model.decide(state, gather, context());
  assert.deepEqual(decision.selected?.input, { item: "cooked_beef" });
});

test("a known dropped food item is picked up before progress, and a remote one is approached first", () => {
  const near = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 6 },
    itemDrops: [dropAt("bread", 4, 0)],
  });
  const nearDecision = model.decide(near, gather, context());
  assert.equal(nearDecision.selected?.goalId, "pickup:bread");
  assert.equal(nearDecision.selected?.skillId, "minecraft.pickup-item");

  const remote = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 6 },
    itemDrops: [dropAt("bread", 34, 0)],
  });
  const remoteDecision = model.decide(remote, gather, context());
  assert.equal(remoteDecision.selected?.goalId, "approach:item:bread");
  assert.equal((remoteDecision.selected?.input as { range: number }).range, 3);
});

test("with no food source and low hunger the agent explores for food; at moderate hunger it keeps progressing", () => {
  const low = observationAt(origin, { player: { ...observationAt(origin).player, food: 5 } });
  const lowDecision = model.decide(low, gather, context());
  assert.equal(lowDecision.selected?.goalId, "explore:food");
  assert.equal(lowDecision.selected?.priorityBand, 1);

  const moderate = observationAt(origin, { player: { ...observationAt(origin).player, food: 9 } });
  const moderateDecision = model.decide(moderate, gather, context());
  assert.equal(moderateDecision.selected?.priorityBand, 2, "exploring for food waits until hunger is low");
  assert.notEqual(moderateDecision.selected?.goalId, "explore:food");
});

test("exploration budget exhaustion stops food seeking with an explicit critical-hunger block", () => {
  const starving = observationAt(origin, { player: { ...observationAt(origin).player, food: 3 } });
  const decision = model.decide(starving, gather, context({ explorationLegsUsed: 8 }));
  assert.equal(decision.terminalStatus, "blocked");
  assert.match(decision.summary, /critically low/);
});

test("a ripe berry bush is harvested as a survival source; an unripe one is ignored", () => {
  const ripe = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 6 },
    resourceSightings: [sighting("sweet_berry_bush", 5, 64, 2, { age: 3 })],
  });
  const ripeDecision = model.decide(ripe, gather, context());
  assert.equal(ripeDecision.selected?.skillId, "minecraft.harvest-berries");
  assert.deepEqual(ripeDecision.selected?.input, { x: 5, y: 64, z: 2, dangerRadius: 6 });

  const unripe = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 6 },
    resourceSightings: [sighting("sweet_berry_bush", 5, 64, 2, { age: 1 })],
  });
  assert.notEqual(model.decide(unripe, gather, context()).selected?.skillId, "minecraft.harvest-berries");
});

test("a remembered unripe bush is revisited to refresh observation without assuming that it matured", () => {
  const memory = new WorldMemory();
  const lastSeen = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 6 },
    resourceSightings: [sighting("sweet_berry_bush", 4, 64, 0, { age: 1 })],
  });
  memory.observe(lastSeen, 1);

  const away = { x: 30.5, y: 64, z: 0.5 };
  const stale = observationAt(away, { player: { ...observationAt(away).player, food: 6 } });
  memory.observe(stale, 2);
  const refresh = model.decide(stale, secure, context({
    memory,
    origin: { x: origin.x, z: origin.z },
    explorationLegsUsed: secure.maxExplorationLegs,
  }));
  assert.equal(refresh.selected?.goalId, "recheck:berry");
  assert.equal(refresh.selected?.skillId, "minecraft.navigate");
  assert.deepEqual(refresh.selected?.input, { x: 4, y: 64, z: 0, range: 3 });
  assert.match(refresh.selected?.rationale ?? "", /ripeness is not assumed/);

  const returned = observationAt({ x: 4.5, y: 64, z: 0.5 }, {
    player: { ...observationAt(origin).player, position: { x: 4.5, y: 64, z: 0.5 }, food: 6 },
    resourceSightings: [sighting("sweet_berry_bush", 4, 64, 0, { age: 3 })],
  });
  memory.observe(returned, 3);
  const harvest = model.decide(returned, secure, context({ memory, origin: { x: origin.x, z: origin.z } }));
  assert.equal(harvest.selected?.skillId, "minecraft.harvest-berries");
});

test("resting is chosen when health is low, food supports regeneration, and no hostile is visible", () => {
  const state = observationAt(origin, { player: { ...observationAt(origin).player, health: 8, food: 20 } });
  const decision = model.decide(state, gather, context());
  assert.equal(decision.selected?.skillId, "minecraft.rest");
  assert.equal(decision.selected?.priorityBand, 1);
});

test("resting requires food for regeneration, an available rest skill, and remaining rest budget", () => {
  const lowFood = observationAt(origin, { player: { ...observationAt(origin).player, health: 8, food: 15 } });
  assert.notEqual(model.decide(lowFood, gather, context()).selected?.skillId, "minecraft.rest");

  const fed = observationAt(origin, { player: { ...observationAt(origin).player, health: 8, food: 20 } });
  assert.notEqual(
    model.decide(fed, gather, context({ availableSkills: new Set(["minecraft.navigate"]) })).selected?.skillId,
    "minecraft.rest",
  );
  assert.notEqual(model.decide(fed, gather, context({ restMsUsed: 60_000 })).selected?.skillId, "minecraft.rest");
});

test("critical health without a rest option names the missing healing skill", () => {
  const state = observationAt(origin, { player: { ...observationAt(origin).player, health: 5, food: 20 } });
  const decision = model.decide(state, gather, context({ availableSkills: new Set(["minecraft.navigate"]) }));
  assert.equal(decision.terminalStatus, "blocked");
  assert.match(decision.summary, /no validated healing skill/);
});

test("critical health with low food explains that regeneration is impossible", () => {
  const state = observationAt(origin, { player: { ...observationAt(origin).player, health: 5, food: 10 } });
  const decision = model.decide(state, gather, context());
  assert.equal(decision.terminalStatus, "blocked");
  assert.match(decision.summary, /natural regeneration needs food/);
});

test("a remembered log beyond the collection limit is approached before collection", () => {
  const state = observationAt(origin, {
    resourceSightings: [sighting("oak_log", 30, 64, 0)],
  });
  const decision = model.decide(state, gather, context());
  assert.equal(decision.selected?.goalId, "approach:oak_log");
  assert.equal(decision.selected?.priorityBand, 2);
  assert.deepEqual(decision.selected?.input, { x: 30, y: 64, z: 0, range: 3 });
});

test("a log far beyond the approach range is not approached; the agent explores instead", () => {
  const state = observationAt(origin, { resourceSightings: [sighting("oak_log", 60, 64, 0)] });
  const decision = model.decide(state, gather, context());
  assert.equal(decision.selected?.goalId, "explore:resource");
});

test("the previous target wins a near tie, which prevents flip-flopping between equal goals", () => {
  const state = observationAt(origin, {
    nearbyBlocks: [block("oak_log", 2, 64, 2), block("oak_log", 0, 64, -3)],
  });
  const first = model.decide(state, gather, context());
  const other = first.alternatives[0]?.targetKey ?? null;
  assert.ok(other);
  const sticky = model.decide(state, gather, context({ previousGoalKey: other }));
  assert.equal(sticky.selected?.targetKey, other);
  assert.equal(first.selected?.targetKey !== other, true);
});

test("skills that are not registered for the adapter are never offered", () => {
  const state = observationAt(origin, { itemDrops: [dropAt("bread", 4, 0)], player: { ...observationAt(origin).player, food: 6 } });
  const decision = model.decide(state, gather, context({ availableSkills: new Set(["minecraft.navigate", "minecraft.collect-log"]) }));
  assert.notEqual(decision.selected?.skillId, "minecraft.pickup-item");
});

test("secure-food completes once hunger reaches the target and never gathers", () => {
  const done = observationAt(origin, { player: { ...observationAt(origin).player, food: 18 }, nearbyBlocks: [block("oak_log", 1, 64, 0)] });
  const decision = model.decide(done, secure, context());
  assert.equal(decision.terminalStatus, "completed");
  assert.equal(decision.selected, null);
});

test("a recovery sidestep is axis-aligned and never routes back across the estimated stalled cell", () => {
  const state = observationAt(origin, { nearbyBlocks: [block("oak_log", 5, 64, 0)] });
  const decision = model.decide(state, gather, context({
    stuck: { reason: "NAVIGATION_STUCK", at: { x: 0, z: 0 }, toward: { x: 5.5, z: 0.5 } },
  }));
  assert.equal(decision.selected?.goalId, "recover:sidestep");
  const input = decision.selected?.input as { x: number; z: number };
  assert.ok(input.x === 0 || input.z === 0, "sidesteps are straight moves");
  assert.notEqual(input.x, 6, "the straight route east would cross the stalled cell");
});

test("the craft plan projects the remaining steps and shrinks as material is already in inventory", () => {
  const task = craftItemTaskSchema.parse({ id: "craft", kind: "craft_item", targetItem: "wooden_pickaxe", targetCount: 1 });
  const empty = model.decide(observationAt(origin, { resourceSightings: [sighting("oak_log", 2, 64, 0)] }), task, context());
  assert.ok(empty.plan.length > 3, "a pickaxe from nothing needs several steps");
  assert.ok(empty.plan.some((step) => step.startsWith("craft 1 wooden_pickaxe")));

  const ready = model.decide(
    observationAt(origin, {
      inventory: [item("oak_planks", 9), item("stick", 2, 10), item("crafting_table", 1, 11)],
      nearbyBlocks: [block("crafting_table", 1, 64, 0)],
    }),
    task,
    context(),
  );
  assert.deepEqual(ready.plan, ["craft 1 wooden_pickaxe"], "an observed table in reach needs no placement");
});

test("the knowledge snapshot reflects what the agent has remembered", () => {
  const memory = WorldMemory.fromObservation(observationAt(origin, {
    resourceSightings: [sighting("oak_log", 20, 64, 0), sighting("sweet_berry_bush", 8, 64, 8, { age: 3 })],
  }), 0);
  const decision = model.decide(observationAt(origin), gather, context({ memory }));
  assert.equal(decision.knowledge.resourceBlocks.oak_log, 1);
  assert.equal(decision.knowledge.ripeBerryBushes, 1);
});

test("gather targets stay excluded after failure, and the verdict is explicit when nothing is left", () => {
  const state = observationAt(origin, { nearbyBlocks: [block("oak_log", 1, 64, 0)] });
  const decision = model.decide(state, gatherResourceTaskSchema.parse({ ...gather, maxExplorationLegs: 0 }), context({
    excludedTargets: new Set(["1,64,0"]),
    previousFailureCode: "ACTION_NOT_CONFIRMED",
  }));
  assert.equal(decision.terminalStatus, "blocked");
  assert.match(decision.summary, /No untried observed oak_log target remains after ACTION_NOT_CONFIRMED/);
});
