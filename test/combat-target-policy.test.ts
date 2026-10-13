/**
 * Two questions the agent must never confuse: "is it a threat?" (`threats.ts`, which drives fleeing, sheltering
 * and refusing to mine next to it) and "may we fight it?" (`combat.ts`, which drives engagement). A creeper is
 * the case that proves the split: worth running from, never worth hitting.
 *
 * These tests pin that split, the exclusive combat floor, and the classification of the refusal the split
 * produces — a declined fight is standing policy, not a failed swing, so it must not be counted against the
 * attack skill.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  combatIsAllowed,
  combatTargetRule,
  minecraftCombatTargets,
  minecraftHostileHealth,
  type CombatSafetyInput,
} from "../src/games/minecraft/combat.js";
import { isHostileMinecraftEntity } from "../src/games/minecraft/threats.js";
import { classifyFailure, failureIsExternal } from "../src/core/failure-taxonomy.js";
import { COMBAT_MIN_HEALTH } from "../src/core/survival-thresholds.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import { observationAt, stack } from "./support/observations.js";

const gatherTask = gatherResourceTaskSchema.parse({
  id: "target-policy-gather",
  kind: "gather_resource",
  resourceName: "oak_log",
  targetCount: 1,
  maxActions: 10,
});

const COMBAT_SKILLS = new Set(["minecraft.navigate", "minecraft.attack-hostile", "minecraft.craft-item", "minecraft.place-crafting-table", "minecraft.rest", "minecraft.orient"]);

function safetyInput(overrides: Partial<CombatSafetyInput> = {}): CombatSafetyInput {
  return {
    enabled: true,
    health: 20,
    minHealth: COMBAT_MIN_HEALTH,
    retreatHealth: 6,
    hostileCountNearby: 1,
    maxEngageableHostiles: 1,
    weapon: { name: "stone_sword", damage: 5 },
    requiredDamage: 4,
    targetDistance: 2,
    maxTargetDistance: 8,
    hitsAlreadyAttempted: 0,
    maxHits: 5,
    // Mineflayer reports a broad category in `type` ("mob"), so the name list carries the classification.
    hostileName: "zombie",
    hostileType: "mob",
    hunger: 18,
    ...overrides,
  };
}

function code(overrides: Partial<CombatSafetyInput>): string | null {
  const verdict = combatIsAllowed(safetyInput(overrides));
  return verdict.allowed ? null : verdict.code;
}

function decideAt(entity: { id: string; name: string; type: string; position: { x: number; y: number; z: number }; distance: number; health: number | null }, health = 20) {
  const base = observationAt({ x: 0.5, y: 64, z: 0.5 }, { entities: [entity], inventory: [stack("wooden_sword", 1)] });
  const state = { ...base, player: { ...base.player, health } };
  return new MinecraftTaskDecisionModel().decide(
    state,
    gatherTask,
    { excludedTargets: new Set<string>(), previousFailureCode: null, availableSkills: COMBAT_SKILLS, combatEnabled: true },
    1,
  );
}

test("every hostile whose health we know also has an explicit engage/avoid rule", () => {
  // Anti-drift: a mob added to the health table without a rule would silently fall through to "avoid", which is
  // safe but invisible. Naming the gap is what keeps the two tables from drifting apart.
  const missing = Object.keys(minecraftHostileHealth).filter((name) => minecraftCombatTargets[name] === undefined);
  assert.deepEqual(missing, [], "each known hostile is deliberately engaged or deliberately avoided");
  for (const [name, rule] of Object.entries(minecraftCombatTargets)) {
    assert.ok(["engage", "avoid"].includes(rule.policy), `${name} has a policy`);
    assert.ok(rule.reason.length > 20, `${name} says why, because the reason is what the operator reads`);
  }
});

test("zombies, skeletons and spiders are engaged; creepers and endermen are avoided", () => {
  for (const name of ["zombie", "husk", "drowned", "skeleton", "stray", "spider", "cave_spider", "slime"]) {
    assert.equal(combatTargetRule(name).policy, "engage", name);
    assert.equal(code({ hostileName: name }), null, `${name} may be fought with a stone sword at full health`);
  }
  for (const name of ["creeper", "enderman", "bogged", "phantom", "witch", "pillager", "vindicator", "evoker"]) {
    assert.equal(combatTargetRule(name).policy, "avoid", name);
    assert.equal(code({ hostileName: name }), "COMBAT_TARGET_AVOID", name);
  }
  assert.match(combatTargetRule("creeper").reason, /explode/i, "the reason names the actual danger");
});

test("an unlisted hostile is avoided instead of used as an experiment", () => {
  for (const name of ["wither_skeleton", "warden", "blaze", "something_new"]) {
    assert.equal(combatTargetRule(name).policy, "avoid", name);
    // Wither skeletons and wardens are hostile, so the target check is what refuses them, not the hostile list.
    if (name !== "something_new") assert.ok(isHostileMinecraftEntity(name, "mob"), `${name} is a threat to flee from`);
  }
  assert.match(combatTargetRule("warden").reason, /warden/, "the refusal quotes the mob it declined");
});

test("full health and a good weapon do not make a creeper worth hitting", () => {
  const verdict = combatIsAllowed(safetyInput({ hostileName: "creeper", health: 20, weapon: { name: "diamond_sword", damage: 8 }, hostileCountNearby: 1 }));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed ? null : verdict.code, "COMBAT_TARGET_AVOID");
});

test("an enderman is a threat to flee from but never a target to fight", () => {
  // Regression: `enderman` was missing from the hostile name list while already carrying 40 health in the
  // combat table, so a live run neither fled from it nor refused it — it simply did not see it as a threat.
  assert.equal(isHostileMinecraftEntity("enderman", "mob"), true, "flees, shelters and refuses to mine next to it");
  assert.equal(code({ hostileName: "enderman", hostileType: "mob" }), "COMBAT_TARGET_AVOID", "and still never swings at it");
});

test("the combat floor is exclusive: at exactly 14 the agent rests, above it fights", () => {
  assert.equal(code({ health: COMBAT_MIN_HEALTH }), "COMBAT_HEALTH_TOO_LOW", "at the floor, no fight");
  assert.equal(code({ health: COMBAT_MIN_HEALTH + 0.5 }), null, "strictly above the floor, fight");
  assert.equal(code({ health: 10 }), "COMBAT_HEALTH_TOO_LOW", "the old floor is now well below it");
  const verdict = combatIsAllowed(safetyInput({ health: COMBAT_MIN_HEALTH }));
  assert.match(verdict.allowed ? verdict.reason : verdict.reason, /rest|eat/i, "the refusal says what to do instead");
});

test("declining a hostile class is a safety refusal, not a failure of the attack skill", () => {
  const failure = classifyFailure("COMBAT_TARGET_AVOID", "'creeper' is avoided: it explodes.");
  assert.equal(failure.kind, "safety", "policy, not a swing that missed");
  assert.equal(failure.owner, "Safety Broker");
  assert.equal(failure.retryable, false, "swinging again at the same creeper changes nothing");
  assert.match(failure.label, /never engaged/);
  assert.match(String(failure.hint), /minecraftCombatTargets/, "the hint names the table to change");
  // External kinds are left out of a skill's statistics, so refusing creepers must not teach the learner that
  // attacking is bad at them.
  assert.equal(failureIsExternal(failure), true);
});

test("the planner engages an ordinary zombie, so the avoid gate did not close combat", () => {
  const decision = decideAt({ id: "z1", name: "zombie", type: "mob", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2, health: 20 });
  assert.equal(decision.selected?.skillId, "minecraft.attack-hostile");
  assert.equal((decision.selected?.input as { minHealth: number }).minHealth, COMBAT_MIN_HEALTH, "the planner passes the shared floor, not a copy");
});

test("an avoided hostile is declined in the plan, with the reason in the decision log", () => {
  const decision = decideAt({ id: "e1", name: "enderman", type: "mob", position: { x: 3.5, y: 64, z: 0.5 }, distance: 3, health: 40 });
  assert.notEqual(decision.selected?.goalId, "defend", "no swing is planned at an enderman");
  assert.notEqual(decision.selected?.skillId, "minecraft.attack-hostile");
  const note = (decision.rejected ?? []).find((entry) => entry.goalId === "defend");
  assert.ok(note, "the trace says defence was considered");
  assert.match(note.detail, /never engaged/i, "and why it was declined");
});

test("unarmed next to an avoided hostile, no weapon is prepared for a fight that will never happen", () => {
  // Before the target check moved ahead of the weapon logic, this planned `prepare-weapon`: the agent would have
  // spent a crafting table and materials on a sword it was then refused to use.
  const base = observationAt({ x: 0.5, y: 64, z: 0.5 }, { entities: [{ id: "c1", name: "creeper", type: "mob", position: { x: 7.5, y: 64, z: 0.5 }, distance: 7, health: 20 }] });
  const decision = new MinecraftTaskDecisionModel().decide(
    { ...base, inventory: [stack("oak_planks", 2), stack("stick", 1)] },
    gatherTask,
    { excludedTargets: new Set<string>(), previousFailureCode: null, availableSkills: COMBAT_SKILLS, combatEnabled: true },
    1,
  );
  assert.notEqual(decision.selected?.goalId, "prepare-weapon");
});

test("at exactly the combat floor a zombie is not fought: healing or leaving wins", () => {
  const decision = decideAt({ id: "z2", name: "zombie", type: "mob", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2, health: 20 }, COMBAT_MIN_HEALTH);
  assert.notEqual(decision.selected?.skillId, "minecraft.attack-hostile", "no fight starts at the floor");
  const note = (decision.rejected ?? []).find((entry) => entry.goalId === "defend");
  assert.match(note?.detail ?? "", /combat floor/i, "the refusal quotes the floor it hit");
});
