/**
 * Raw meat as food.
 *
 * An animal drops `beef`, `chicken`, `mutton`, `porkchop` or `rabbit` — never the cooked form. Until these were
 * on the food list, a kill produced an item the agent would not pick up and could not eat, and cooking is not
 * available in any task route. Two things make this more than adding names to a list: raw chicken carries a
 * chance of the Hunger effect, so it has to be eaten *last* rather than whenever the arithmetic prefers it, and
 * rotten flesh — the drop from every zombie — has to stay out of the list on purpose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minecraftFoodNames, minecraftPickupNames, minecraftPickupItemInputSchema } from "../src/games/minecraft/capabilities.js";
import { foodNamesWithoutNutrition, isEatLastFood, isMinecraftFoodName, minecraftFoodNutrition } from "../src/games/minecraft/recipes.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { DEFAULT_GATHER_LOG_TASK } from "../src/games/minecraft/task.js";
import { observationAt } from "./support/observations.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = new MinecraftTaskDecisionModel();
const origin = { x: 0.5, y: 64, z: 0.5 };
const RAW_MEAT = ["beef", "chicken", "mutton", "porkchop", "rabbit"] as const;

function item(name: string, count: number, slot = 9) {
  return { slot, name, type: 1, count, metadata: null, durabilityUsed: null };
}

const context = () => ({ excludedTargets: new Set<string>(), previousFailureCode: null });

/**
 * A state that wants to eat. Health below the resting line makes eating a priority even at food 17, which is
 * what the risk-tier test needs: at a nearly full bar the arithmetic prefers the *smallest* meal.
 */
function hungryState(food: number, inventory: ReturnType<typeof item>[]) {
  const base = observationAt(origin, { inventory });
  return { ...base, player: { ...base.player, food, health: 12 } };
}

/** One drop on the ground and nothing to eat in the inventory, which is when food sourcing is considered. */
function droppedFood(name: string, x: number, z: number) {
  const base = observationAt(origin, {
    inventory: [],
    itemDrops: [{ id: `${name}-${x}-${z}`, name, count: 1, position: { x: x + 0.5, y: 64.2, z: z + 0.5 }, distance: Math.hypot(x - origin.x, z - origin.z) }],
  });
  return { ...base, player: { ...base.player, food: 12, health: 20 } };
}

test("raw meat from the animals an agent can meet is food, at vanilla hunger values", () => {
  const expected: Record<string, number> = { beef: 3, chicken: 2, mutton: 2, porkchop: 3, rabbit: 3 };
  for (const [name, hunger] of Object.entries(expected)) {
    assert.equal(isMinecraftFoodName(name), true, `${name} is food`);
    assert.equal(minecraftFoodNutrition[name as keyof typeof minecraftFoodNutrition], hunger, `${name} restores ${hunger}`);
  }
  // Each cooked form restores strictly more than the raw one, which is why cooking is worth a furnace later.
  for (const raw of RAW_MEAT) {
    const cooked = `cooked_${raw}`;
    assert.ok(isMinecraftFoodName(cooked), cooked);
    assert.ok(
      minecraftFoodNutrition[cooked as keyof typeof minecraftFoodNutrition] > minecraftFoodNutrition[raw as keyof typeof minecraftFoodNutrition],
      `${cooked} beats ${raw}`,
    );
  }
});

test("raw meat is on the pickup allowlist, so a drop is collected instead of ignored", () => {
  for (const name of RAW_MEAT) {
    assert.ok((minecraftPickupNames as readonly string[]).includes(name), `${name} may be picked up`);
    assert.equal(minecraftPickupItemInputSchema.parse({ x: 4, y: 64, z: 0, itemName: name }).itemName, name);
  }
  assert.ok(
    (minecraftFoodNames as readonly string[]).every((name) => (minecraftPickupNames as readonly string[]).includes(name)),
    "anything eatable is also pickup-able, or the agent could never obtain it",
  );
});

test("rotten flesh stays out on purpose: 4 hunger against an 80% chance of draining it again", () => {
  assert.equal(isMinecraftFoodName("rotten_flesh"), false);
  assert.ok(!(minecraftPickupNames as readonly string[]).includes("rotten_flesh"));
  // Every zombie drops it, so the planner meets it constantly; it must not plan a pickup for it.
  const decision = model.decide(droppedFood("rotten_flesh", 4, 0), DEFAULT_GATHER_LOG_TASK, context(), 1);
  assert.ok(!JSON.stringify(decision.selected?.input ?? {}).includes("rotten_flesh"), "no pickup is planned for it");
});

test("every food name has a nutrition value, so no caller can compute with undefined", () => {
  assert.deepEqual(foodNamesWithoutNutrition(), []);
  assert.ok(minecraftFoodNames.length >= 24, `${minecraftFoodNames.length} foods are known`);
});

test("the fake adapter reads the shared nutrition table instead of keeping its own copy", () => {
  // A private copy is how a new food name turns into NaN hunger: the eat action used to index it with a
  // non-null assertion. Source-scanned, like the other anti-drift tests in this repository.
  const source = readFileSync(path.join(ROOT, "src/testing/fake-minecraft-adapter.ts"), "utf8");
  assert.match(source, /import \{ minecraftFoodNutrition \}/, "it imports the shared table");
  assert.ok(!/cooked_beef: 8/.test(source), "no private nutrition numbers are left");
  assert.match(source, /nutrition === undefined/, "an unknown value throws instead of becoming NaN");
});

test("cooked meat is eaten before the raw form when both are carried", () => {
  const decision = model.decide(hungryState(9, [item("beef", 1, 9), item("cooked_beef", 1, 10)]), DEFAULT_GATHER_LOG_TASK, context(), 1);
  assert.deepEqual(decision.selected?.input, { item: "cooked_beef" });
});

test("raw chicken is eaten last, even when it wastes less of the hunger bar", () => {
  // Food 17 needs 3: chicken (2) wastes nothing and bread (5) wastes 2, so the arithmetic alone picks the
  // chicken — with its 30% chance of the Hunger effect. The risk tier has to come first.
  assert.equal(isEatLastFood("chicken"), true);
  assert.equal(isEatLastFood("cooked_chicken"), false);
  assert.equal(isEatLastFood("beef"), false, "raw beef carries no effect, only low saturation");
  const decision = model.decide(hungryState(17, [item("chicken", 1, 9), item("bread", 1, 10)]), DEFAULT_GATHER_LOG_TASK, context(), 1);
  assert.deepEqual(decision.selected?.input, { item: "bread" }, "the risky item loses to a wasteful safe one");
});

test("raw chicken is still eaten when it is the only food there is", () => {
  // The tier orders choices; it must never be a reason to starve with food in the inventory.
  const decision = model.decide(hungryState(17, [item("chicken", 2, 9)]), DEFAULT_GATHER_LOG_TASK, context(), 1);
  assert.deepEqual(decision.selected?.input, { item: "chicken" });
});

test("a dropped raw meat on the ground is worth a detour, and the reason names it", () => {
  const decision = model.decide(droppedFood("beef", 4, 0), DEFAULT_GATHER_LOG_TASK, context(), 1);
  assert.match(String(decision.selected?.rationale ?? ""), /beef/i);
});
