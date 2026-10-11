import assert from "node:assert/strict";
import test from "node:test";
import {
  MinecraftTaskDecisionModel,
  RejectionLedger,
  BAND_PROGRESS,
  BAND_SAFETY,
  BAND_SURVIVAL,
  type MinecraftDecisionContext,
} from "../src/games/minecraft/decision-model.js";
import type { PolicyAdvisor, PolicyAssessment } from "../src/core/learning/policy-advisor.js";
import {
  buildShelterTaskSchema,
  craftItemTaskSchema,
  gatherResourceTaskSchema,
  mineResourceTaskSchema,
  type MinecraftTask,
} from "../src/games/minecraft/task.js";
import { block, observationAt, stack } from "./support/observations.js";

const model = new MinecraftTaskDecisionModel();

function context(overrides: Partial<MinecraftDecisionContext> = {}): MinecraftDecisionContext {
  return { excludedTargets: new Set<string>(), previousFailureCode: null, ...overrides };
}

const skills = new Set([
  "minecraft.navigate",
  "minecraft.collect-log",
  "minecraft.mine-block",
  "minecraft.place-block",
  "minecraft.build-shelter",
  "minecraft.attack-hostile",
  "minecraft.drop-item",
  "minecraft.equip-item",
  "minecraft.craft-item",
  "minecraft.place-crafting-table",
  "minecraft.eat-food",
  "minecraft.pickup-item",
  "minecraft.harvest-berries",
  "minecraft.rest",
  "minecraft.orient",
  "minecraft.inspect-block",
]);

function decide(
  state: Parameters<typeof model.decide>[0],
  task: MinecraftTask,
  overrides: Partial<MinecraftDecisionContext> = {},
) {
  return model.decide(state, task, context({ availableSkills: skills, ...overrides }), 1);
}

const gatherTask = gatherResourceTaskSchema.parse({ id: "t", resourceName: "oak_log", targetCount: 1, maxActions: 10 });
const mineTask = mineResourceTaskSchema.parse({ id: "t-mine", resourceName: "stone", targetCount: 1, maxActions: 10 });
const shelterTask = buildShelterTaskSchema.parse({ id: "t-shelter", maxBlocks: 4, maxActions: 10 });

test("an adjacent lava block outranks the task goal and the agent moves away", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("lava", 1, 64, 0), block("grass_block", 0, 63, 0), block("oak_log", 5, 64, 0)],
  });
  const decision = decide(state, gatherTask);
  assert.equal(decision.selected?.goalId, "avoid-hazard");
  assert.equal(decision.selected?.priorityBand, BAND_SAFETY);
  assert.equal(decision.selected?.skillId, "minecraft.navigate");
  assert.match(decision.selected?.rationale ?? "", /lava/);
  const overtaken = (decision.rejected ?? []).find((entry) => entry.reason === "lower_band");
  assert.ok(overtaken, "the trace records that the task goal was overtaken, not abandoned");
});

test("combat is never planned without the operator switch, and the refusal is recorded", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("oak_log", 12, 64, 0)],
    entities: [
      { id: "e1", name: "zombie", type: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2, health: 20 },
    ],
    inventory: [stack("stone_sword", 1)],
  });
  const denied = decide(state, gatherTask);
  assert.notEqual(denied.selected?.goalId, "defend");
  const note = (denied.rejected ?? []).find((entry) => entry.goalId === "defend");
  assert.ok(note, "the trace must say why defending was not offered");
  assert.match(note.detail, /combat is not enabled/i);

  const enabled = decide(state, gatherTask, { combatEnabled: true });
  assert.equal(enabled.selected?.goalId, "defend");
  assert.equal(enabled.selected?.priorityBand, BAND_SAFETY);
  assert.equal(enabled.selected?.skillId, "minecraft.attack-hostile");
  const input = enabled.selected?.input as { entityId: string; maxHits: number };
  assert.equal(input.entityId, "e1");
  // A stone sword (5 damage) needs 4 hits on a 20-health zombie, plus one spare swing.
  assert.equal(input.maxHits, 5);
});

test("defence is refused even with combat enabled when the weapon is too weak", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("oak_log", 12, 64, 0)],
    entities: [
      { id: "e1", name: "zombie", type: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2, health: 20 },
    ],
    // Carried blocks, no blade: fighting would only prolong it.
    inventory: [stack("dirt", 3)],
  });
  const decision = decide(state, gatherTask, { combatEnabled: true });
  assert.notEqual(decision.selected?.goalId, "defend", "no weapon means no fight");
  const note = (decision.rejected ?? []).find((entry) => entry.goalId === "defend");
  assert.ok(note && note.reason === "no_skill");
  assert.match(note.detail, /weapon/i);
});

test("shelter becomes a survival goal when it is dark, the agent is hurt and blocks are carried", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    time: { dayTicks: 18_000, day: 0, isNight: true },
    player: {
      username: "GameMind",
      position: { x: 0.5, y: 64, z: 0.5 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 8,
      food: 18,
      foodSaturation: 0,
      oxygenLevel: 300,
      onGround: true,
    },
    nearbyBlocks: [block("grass_block", 0, 63, 0)],
    inventory: [stack("dirt", 6)],
  });
  const decision = decide(state, gatherTask);
  assert.equal(decision.selected?.goalId, "build-shelter");
  assert.equal(decision.selected?.priorityBand, BAND_SURVIVAL);
  assert.equal(decision.selected?.skillId, "minecraft.build-shelter");

  // Full health in daylight must not turn shelter building into a distraction from the task.
  const day = {
    ...state,
    time: { dayTicks: 6_000, day: 0, isNight: false },
    player: { ...state.player, health: 20 },
  };
  const daytime = decide(day, gatherTask);
  assert.notEqual(daytime.selected?.goalId, "build-shelter");
});

test("the shelter task is verified from observed blocks, not from the placement calls", () => {
  const open = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("grass_block", 0, 63, 0)],
    inventory: [stack("dirt", 4)],
  });
  const pending = decide(open, shelterTask);
  assert.equal(pending.terminalStatus, null);
  assert.equal(pending.selected?.goalId, "build-shelter");

  const closed = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [
      block("grass_block", 0, 63, 0),
      block("dirt", 1, 64, 0),
      block("dirt", -1, 64, 0),
      block("dirt", 0, 64, 1),
      block("dirt", 0, 64, -1),
    ],
    inventory: [stack("dirt", 0)],
  });
  const done = decide(closed, shelterTask);
  assert.equal(done.terminalStatus, "completed");
  assert.match(done.summary, /four cardinal sides/);

  // Without blocks the task must be reported as impossible here instead of pretending.
  const empty = { ...open, inventory: [] };
  const blocked = decide(empty, shelterTask);
  assert.equal(blocked.terminalStatus, "blocked");
  assert.match(blocked.summary, /no placeable blocks/);
});

test("a mining goal resolves the tool prerequisite before digging", () => {
  const noTool = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("stone", 1, 64, 0), block("oak_log", 2, 64, 3), block("grass_block", 0, 63, 0)],
  });
  const first = decide(noTool, mineTask);
  assert.ok(
    ["minecraft.gather-log", "minecraft.collect-log", "minecraft.craft-item", "minecraft.navigate"].includes(
      first.selected?.skillId ?? "",
    ),
    `expected a step towards a pickaxe, got ${first.selected?.skillId}`,
  );
  assert.match(first.summary + (first.selected?.rationale ?? ""), /pickaxe/i);

  const withPickaxe = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("stone", 1, 64, 0), block("grass_block", 0, 63, 0)],
    equipment: { hand: stack("wooden_pickaxe", 1, 36), offhand: null, head: null, torso: null, legs: null, feet: null },
  });
  const mine = decide(withPickaxe, mineTask);
  assert.equal(mine.selected?.goalId, "mine:stone");
  assert.equal(mine.selected?.skillId, "minecraft.mine-block");
  const mineInput = mine.selected?.input as { x: number; y: number; z: number; blockName: string };
  assert.deepEqual(
    { x: mineInput.x, y: mineInput.y, z: mineInput.z, blockName: mineInput.blockName },
    { x: 1, y: 64, z: 0, blockName: "stone" },
  );

  // A pickaxe in the inventory but not in hand must be equipped rather than used from the backpack.
  const inBackpack = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("stone", 1, 64, 0), block("grass_block", 0, 63, 0)],
    inventory: [stack("stone_pickaxe", 1)],
  });
  const equipped = decide(inBackpack, mineTask);
  assert.equal(equipped.selected?.goalId, "equip:pickaxe");
  assert.equal(equipped.selected?.skillId, "minecraft.equip-item");

  // A tool that is carried but not held must go into the hand before the block is touched.
  const swap = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("deepslate_iron_ore", 1, 64, 0), block("grass_block", 0, 63, 0)],
    inventory: [stack("stone_pickaxe", 1)],
  });
  const swapped = decide(swap, mineResourceTaskSchema.parse({ id: "t-iron", resourceName: "deepslate_iron_ore", targetCount: 1, maxActions: 10 }));
  assert.equal(swapped.selected?.goalId, "equip:pickaxe");
  assert.equal(swapped.selected?.skillId, "minecraft.equip-item");

  // A block above every carried tool is refused instead of attempted and failed.
  const tooHard = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("deepslate_iron_ore", 1, 64, 0), block("grass_block", 0, 63, 0)],
    equipment: { hand: stack("wooden_pickaxe", 1, 36), offhand: null, head: null, torso: null, legs: null, feet: null },
  });
  const refused = decide(tooHard, mineResourceTaskSchema.parse({ id: "t-iron-2", resourceName: "deepslate_iron_ore", targetCount: 1, maxActions: 10 }));
  assert.notEqual(refused.selected?.skillId, "minecraft.mine-block");
  assert.match(refused.summary + (refused.selected?.rationale ?? ""), /pickaxe/);
});

test("a full inventory frees space with terrain only, and only when the world says it is full", () => {
  const full = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    player: {
      username: "GameMind",
      position: { x: 0.5, y: 64, z: 0.5 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 20,
      food: 20,
      foodSaturation: 0,
      oxygenLevel: 300,
      onGround: true,
      inventoryFull: true,
    },
    nearbyBlocks: [block("oak_log", 3, 64, 0), block("grass_block", 0, 63, 0)],
    inventory: [stack("dirt", 40), stack("sand", 12), stack("bread", 2)],
  });
  const decision = decide(full, gatherTask);
  assert.equal(decision.selected?.goalId, "free-inventory");
  assert.equal(decision.selected?.skillId, "minecraft.drop-item");
  const input = decision.selected?.input as { itemName: string; count: number };
  assert.equal(input.itemName, "dirt", "the most abundant junk stack goes, never the bread");
  assert.equal(input.count, 40);

  const notFull = { ...full, player: { ...full.player, inventoryFull: false } };
  assert.notEqual(decide(notFull, gatherTask).selected?.goalId, "free-inventory");

  const fullButValuable = { ...full, inventory: [stack("iron_ingot", 3), stack("diamond", 2)] };
  const nothing = decide(fullButValuable, gatherTask);
  assert.notEqual(nothing.selected?.skillId, "minecraft.drop-item");
  const note = (nothing.rejected ?? []).find((entry) => entry.goalId === "free-inventory");
  assert.ok(note, "the trace explains that there is nothing safe to drop");
});

test("learned weights re-rank progress goals but never touch safety goals", () => {
  const blocked: PolicyAssessment = {
    multiplier: 1,
    penalty: 0,
    blocked: { reason: "this cell was walled in three times" },
    contextKey: "learned",
    notes: ["blocked by failure memory"],
  };
  const neutral: PolicyAssessment = { multiplier: 1, penalty: 0, blocked: null, contextKey: "learned", notes: [] };
  const advisor: PolicyAdvisor = {
    id: "test-advisor",
    source: "experience",
    assess: (query) => (query.skillId === "minecraft.collect-log" ? blocked : neutral),
    describe: () => ({ id: "test-advisor", source: "experience", contexts: 1, failureEntries: 1, weights: {} }),
  };
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("oak_log", 3, 64, 0), block("grass_block", 0, 63, 0)],
  });
  const decision = decide(state, gatherTask, { advisor });
  assert.notEqual(decision.selected?.skillId, "minecraft.collect-log", "a learned veto must suppress the goal");
  const note = (decision.rejected ?? []).find((entry) => entry.reason === "policy_penalty");
  assert.ok(note && /walled in/.test(note.detail));

  // The same advisor facing a hazard cannot talk the agent out of escaping.
  const lavaState = {
    ...state,
    nearbyBlocks: [block("lava", 1, 64, 0), block("oak_log", 3, 64, 0), block("grass_block", 0, 63, 0)],
  };
  const safety = decide(lavaState, gatherTask, { advisor });
  assert.equal(safety.selected?.goalId, "avoid-hazard");
  assert.equal(safety.selected?.priorityBand, BAND_SAFETY);
});

test("the rejection ledger de-duplicates and exposes exactly what the model dropped", () => {
  const ledger = new RejectionLedger();
  const candidate = {
    goalId: "collect:oak_log",
    targetKey: "1,64,0",
    priorityBand: BAND_PROGRESS,
    score: 10,
    skillId: "minecraft.collect-log",
    input: null,
    rationale: "test",
  };
  ledger.reject(candidate, "excluded_after_failure", "already tried");
  ledger.reject(candidate, "excluded_after_failure", "already tried");
  ledger.reject(candidate, "threatened", "zombie nearby");
  assert.equal(ledger.size, 2);
  assert.deepEqual(ledger.all.map((entry) => entry.reason).sort(), ["excluded_after_failure", "threatened"]);
  assert.equal(ledger.all[0]?.score, 10);
});

test("a completed mining goal is reported from the observed drop count", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("stone", 1, 64, 0)],
    inventory: [stack("cobblestone", 4)],
  });
  const decision = decide(state, mineResourceTaskSchema.parse({ id: "t2", resourceName: "stone", targetCount: 4 }));
  assert.equal(decision.terminalStatus, "completed");
  assert.match(decision.summary, /4\/4 cobblestone/);

  const partial = {
    ...state,
    inventory: [stack("cobblestone", 1)],
    equipment: { hand: stack("wooden_pickaxe", 1, 36), offhand: null, head: null, torso: null, legs: null, feet: null },
  };
  const again = decide(
    partial,
    mineResourceTaskSchema.parse({ id: "t-mine-4", resourceName: "stone", targetCount: 4, maxActions: 10 }),
  );
  assert.equal(again.terminalStatus, null, "one cobblestone does not finish a four-item goal");
});

test("craft plans project a prerequisite chain that the trace can show", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [
      block("oak_log", 1, 64, 2),
      block("oak_log", 2, 64, 2),
      block("oak_log", 3, 64, 2),
      block("stone", 1, 64, -2),
      block("grass_block", 0, 63, 0),
    ],
  });
  const decision = decide(
    state,
    craftItemTaskSchema.parse({ id: "t-stone-pickaxe", kind: "craft_item", targetItem: "stone_pickaxe", targetCount: 1, maxActions: 40 }),
    {},
  );
  assert.ok(decision.plan.length > 0, "a multi-step plan must be visible in the trace");
  assert.ok(
    decision.plan.some((step) => /mine .*cobblestone|cobblestone/i.test(step)),
    `the plan should include mining for cobblestone, got: ${decision.plan.join(" | ")}`,
  );
  assert.ok(decision.selected, "the first step is an actual action, not a comment");
});

test("the safety note from the broker is carried into the decision record", () => {
  const state = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [block("oak_log", 3, 64, 0)],
  });
  const decision = decide(state, gatherTask, {
    safetyNote: { allowed: false, code: "HAZARD_NEARBY", message: "lava was here a moment ago" },
  });
  assert.deepEqual(decision.safety, { allowed: false, code: "HAZARD_NEARBY", message: "lava was here a moment ago" });
  const plain = decide(state, gatherTask);
  assert.equal(plain.safety, null);
});
