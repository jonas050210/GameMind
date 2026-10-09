import assert from "node:assert/strict";
import test from "node:test";
import {
  bestPickaxeTier,
  canMineWithTier,
  estimatedDigSeconds,
  isMineableBlockName,
  minecraftDroppableJunkNames,
  minecraftMiningRequirements,
  minecraftPlaceableBlockNames,
  miningDropFor,
  pickaxeTier,
} from "../src/games/minecraft/mining.js";
import {
  attackCooldownMs,
  bestWeapon,
  combatIsAllowed,
  estimatedHitsToKill,
  minecraftHostileHealth,
  weaponDamageFor,
} from "../src/games/minecraft/combat.js";
import {
  SHELTER_CARDINAL_DIRECTIONS,
  SHELTER_DIRECTIONS,
  placeableBlockCounts,
  planShelter,
} from "../src/games/minecraft/shelter.js";
import { verifySkillPostcondition } from "../src/games/minecraft/skill-contracts.js";
import { isHazardBlockName, observedHazards, blockObservationPriority } from "../src/games/minecraft/block-classes.js";
import {
  MINECRAFT_COMBAT_CAPABILITY,
  MINECRAFT_SAFETY_POLICY,
  isNightTicks,
  minecraftSafetyContext,
} from "../src/games/minecraft/safety-context.js";
import type { MineabilityVerdict } from "../src/games/minecraft/mining.js";
import type { CombatVerdict } from "../src/games/minecraft/combat.js";
import { block, observationAt, stack } from "./support/observations.js";

/** Narrows a verdict union so the tests can assert on the failure code itself. */
function mineCode(verdict: MineabilityVerdict): string {
  return verdict.mineable ? "MINEABLE" : verdict.code;
}

function combatCode(verdict: CombatVerdict): string {
  return verdict.allowed ? "ALLOWED" : verdict.code;
}

test("mining rules encode the tool tiers the game actually enforces", () => {
  assert.equal(miningDropFor("stone"), "cobblestone");
  assert.equal(miningDropFor("deepslate_coal_ore"), "coal");
  assert.equal(miningDropFor("oak_log"), null, "logs are gathered by the collect skill, not mined");
  assert.equal(isMineableBlockName("dirt"), true);
  assert.equal(isMineableBlockName("diamond_block"), false, "only allowlisted blocks may be mined");

  assert.deepEqual(bestPickaxeTier([{ name: "stone_pickaxe" }, { name: "wooden_pickaxe" }]), {
    tier: 2,
    name: "stone_pickaxe",
  });
  assert.deepEqual(bestPickaxeTier([{ name: "oak_log" }]), { tier: 0, name: null });
  assert.equal(pickaxeTier("netherite_pickaxe"), 4);

  assert.equal(canMineWithTier("dirt", 0).mineable, true, "hands can dig dirt");
  const withoutTool = canMineWithTier("stone", 0);
  assert.equal(withoutTool.mineable, false);
  assert.equal(mineCode(withoutTool), "TOOL_REQUIRED");
  const weakTool = canMineWithTier("deepslate_iron_ore", 1);
  assert.equal(weakTool.mineable, false);
  assert.equal(mineCode(weakTool), "TOOL_TIER_INSUFFICIENT");
  assert.equal(mineCode(canMineWithTier("not_a_block", 4)), "BLOCK_NOT_MINEABLE_CLASS");

  assert.ok(
    estimatedDigSeconds("stone", 2) < estimatedDigSeconds("stone", 1),
    "a better pickaxe must measurably reduce the estimated dig time",
  );
  assert.equal(estimatedDigSeconds("bedrock", 4), Number.POSITIVE_INFINITY);
  assert.ok(estimatedDigSeconds("stone", 1) >= 0.5);

  for (const [name, requirement] of Object.entries(minecraftMiningRequirements)) {
    assert.ok(requirement.drop.length > 0, `${name} needs a drop`);
    assert.ok(requirement.baseSeconds > 0, `${name} needs a positive dig time`);
    if (requirement.requiresPickaxe) assert.ok(requirement.minPickaxeTier >= 1, `${name} tier mismatch`);
  }
  assert.ok(minecraftPlaceableBlockNames.includes("dirt"));
  assert.ok(!(minecraftPlaceableBlockNames as readonly string[]).includes("diamond_block"), "no wasting valuables on walls");
  for (const junk of minecraftDroppableJunkNames) {
    assert.ok(!junk.includes("pickaxe") && !junk.includes("bread"), `${junk} is not junk`);
  }
});

test("combat is refused unless every precondition holds, and the reasons are explicit", () => {
  const base = {
    enabled: true,
    health: 20,
    minHealth: 10,
    retreatHealth: 6,
    hostileCountNearby: 1,
    maxEngageableHostiles: 1,
    weapon: { name: "stone_sword", damage: weaponDamageFor("stone_sword") },
    requiredDamage: 4,
    targetDistance: 2,
    maxTargetDistance: 4,
    hitsAlreadyAttempted: 0,
    maxHits: 4,
    hostileName: "zombie",
    hostileType: "zombie",
    hunger: 18,
  };
  assert.equal(combatIsAllowed(base).allowed, true);
  assert.equal(combatCode(combatIsAllowed({ ...base, enabled: false })), "COMBAT_DISABLED");
  assert.equal(combatCode(combatIsAllowed({ ...base, hostileName: "cow", hostileType: "cow" })), "COMBAT_TARGET_INVALID");
  assert.equal(combatCode(combatIsAllowed({ ...base, health: null })), "COMBAT_HEALTH_TOO_LOW");
  assert.equal(combatCode(combatIsAllowed({ ...base, health: 8 })), "COMBAT_HEALTH_TOO_LOW");
  assert.equal(combatCode(combatIsAllowed({ ...base, weapon: null })), "COMBAT_NO_WEAPON");
  assert.equal(
    combatIsAllowed({ ...base, weapon: { name: "wooden_sword", damage: weaponDamageFor("wooden_sword") } }).allowed,
    true,
    "a wooden sword meets the vanilla 4-damage bar",
  );
  assert.equal(combatCode(combatIsAllowed({ ...base, weapon: { name: "air", damage: weaponDamageFor("air") } })), "COMBAT_NO_WEAPON");
  assert.equal(combatCode(combatIsAllowed({ ...base, hostileCountNearby: 3 })), "COMBAT_OUTNUMBERED");
  assert.equal(combatCode(combatIsAllowed({ ...base, targetDistance: 9 })), "COMBAT_OUT_OF_RANGE");
  assert.equal(combatCode(combatIsAllowed({ ...base, hitsAlreadyAttempted: 4 })), "COMBAT_HIT_BUDGET");
  assert.equal(combatCode(combatIsAllowed({ ...base, hunger: 2 })), "COMBAT_EXHAUSTED");

  assert.equal(weaponDamageFor("air"), 1, "an empty hand is unarmed damage, not zero");
  assert.equal(bestWeapon([{ name: "oak_log" }, { name: "stone_sword" }])?.name, "stone_sword");
  assert.equal(bestWeapon([{ name: "oak_log" }]), null);
  assert.ok(attackCooldownMs() > 0);
  assert.equal(estimatedHitsToKill(5, minecraftHostileHealth.zombie ?? 20), 4);
});

test("shelter planning only proposes cells that are observed air with observed solid support", () => {
  const open = observationAt({ x: 0, y: 64, z: 0 }, {
    inventory: [stack("dirt", 6)],
    nearbyBlocks: [
      // Ground ring at feet level - 1 so every cardinal cell has support.
      ...SHELTER_CARDINAL_DIRECTIONS.map(([dx, dz]) => block("grass_block", dx, 63, dz)),
      block("grass_block", 0, 63, 0),
    ],
  });
  const withBlocks = open;

  const plan = planShelter(withBlocks, { mode: "cardinal", maxBlocks: 4 });
  assert.equal(plan.cells.length, 4, "all four cardinal sides are open and supported");
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.sheltered, false);
  assert.equal(plan.blocksNeeded, 4);
  assert.deepEqual(
    plan.cells.map((cell) => [cell.x, cell.z]).sort(),
    [[-1, 0], [0, -1], [0, 1], [1, 0]].sort(),
  );
  for (const cell of plan.cells) assert.equal(cardinal(cell), true);

  // Already walled in on three sides: only the remaining gap is planned.
  const nearlyClosed = {
    ...withBlocks,
    nearbyBlocks: [...(withBlocks.nearbyBlocks ?? []), block("cobblestone", 1, 64, 0), block("cobblestone", 0, 64, 1), block("cobblestone", -1, 64, 0)],
  };
  const closed = planShelter(nearlyClosed, { mode: "cardinal", maxBlocks: 4 });
  assert.equal(closed.cells.length, 1);
  assert.equal(closed.skipped.filter((skip) => skip.reason === "occupied").length, 3);
  assert.equal(closed.solidCardinalCells, 3);

  // Nothing observed at all: absence of data is not evidence of a floor, so nothing is proposed.
  const unobserved = observationAt({ x: 0, y: 64, z: 0 }, { nearbyBlocks: [] });
  const refused = planShelter(observationAt({ x: 0, y: 64, z: 0 }, { inventory: [stack("dirt", 4)] }), { mode: "cardinal" });
  assert.equal(refused.cells.length, 0);
  assert.equal(refused.skipped.length, SHELTER_CARDINAL_DIRECTIONS.length);
  assert.ok(refused.skipped.every((skip) => skip.reason === "unknown"), "unobserved support is unknown, not air");

  // An observed non-solid block below the cell means the placed block would fall: refuse it.
  const noSupport = observationAt({ x: 0, y: 64, z: 0 }, {
    nearbyBlocks: SHELTER_CARDINAL_DIRECTIONS.map(([dx, dz]) => block("air", dx, 63, dz)),
  });
  const falling = planShelter(
    { ...noSupport, inventory: [stack("dirt", 4)] },
    { mode: "cardinal" },
  );
  assert.equal(falling.cells.length, 0);
  assert.ok(falling.skipped.every((skip) => skip.reason === "no-support"));

  // A lava support cell is refused rather than used as a step.
  const lavaSupport = observationAt({ x: 0, y: 64, z: 0 }, {
    nearbyBlocks: [...SHELTER_CARDINAL_DIRECTIONS.map(([dx, dz]) => block(dx === 1 && dz === 0 ? "lava" : "grass_block", dx, 63, dz))],
  });
  const lavaPlan = planShelter(lavaSupport, { mode: "cardinal" });
  assert.ok(
    lavaPlan.skipped.some((skip) => skip.reason === "unsafe-support" && skip.x === 1 && skip.z === 0),
    "placing on lava is never proposed",
  );

  // maxBlocks bounds the plan; full mode covers the diagonals as well.
  assert.equal(planShelter(withBlocks, { mode: "cardinal", maxBlocks: 2 }).cells.length, 2);
  const fullGround = observationAt({ x: 0, y: 64, z: 0 }, {
    inventory: [stack("dirt", 8)],
    nearbyBlocks: SHELTER_DIRECTIONS.map(([dx, dz]) => block("grass_block", dx, 63, dz)),
  });
  assert.equal(planShelter(fullGround, { mode: "full", maxBlocks: 8 }).cells.length, SHELTER_DIRECTIONS.length);
  assert.equal(placeableBlockCounts(withBlocks).get("dirt"), 6);
});

function cardinal(cell: { direction: readonly [number, number] }): boolean {
  return cell.direction[0] === 0 || cell.direction[1] === 0;
}

test("postconditions reject a placement claim the world does not confirm", () => {
  const before = observationAt({ x: 0, y: 64, z: 0 });
  const afterPlaced = observationAt({ x: 0, y: 64, z: 0 }, {
    nearbyBlocks: [block("dirt", 1, 64, 0)],
  });
  const input = { x: 1, y: 64, z: 0, blockName: "dirt" };
  assert.equal(verifySkillPostcondition("minecraft.place-block", input, before, afterPlaced).verified, true);
  assert.equal(
    verifySkillPostcondition("minecraft.place-block", input, before, before).verified,
    false,
    "an unchanged world contradicts the confirmation",
  );

  const afterMined = observationAt({ x: 0, y: 64, z: 0 }, {
    nearbyBlocks: [],
    inventory: [stack("cobblestone", 1)],
  });
  const beforeMined = observationAt({ x: 0, y: 64, z: 0 }, {
    nearbyBlocks: [block("stone", 1, 64, 0)],
  });
  assert.equal(
    verifySkillPostcondition("minecraft.mine-block", { x: 1, y: 64, z: 0, blockName: "stone" }, beforeMined, afterMined)
      .verified,
    true,
  );
  assert.equal(
    verifySkillPostcondition("minecraft.mine-block", { x: 1, y: 64, z: 0, blockName: "stone" }, beforeMined, beforeMined)
      .verified,
    false,
    "a dig that removed nothing and dropped nothing is not a success",
  );

  const shelterAfter = observationAt({ x: 0, y: 64, z: 0 }, {
    nearbyBlocks: [
      ...SHELTER_CARDINAL_DIRECTIONS.map(([dx, dz]) => block("dirt", dx, 64, dz)),
      ...SHELTER_CARDINAL_DIRECTIONS.map(([dx, dz]) => block("grass_block", dx, 63, dz)),
    ],
  });
  assert.equal(
    verifySkillPostcondition("minecraft.build-shelter", { mode: "cardinal", maxBlocks: 4 }, observationAt({ x: 0, y: 64, z: 0 }), shelterAfter)
      .verified,
    true,
  );
  assert.equal(
    verifySkillPostcondition("minecraft.build-shelter", { mode: "cardinal", maxBlocks: 4 }, observationAt({ x: 0, y: 64, z: 0 }), observationAt({ x: 0, y: 64, z: 0 }))
      .verified,
    false,
  );

  const hostileGone = observationAt({ x: 0, y: 64, z: 0 }, { entities: [] });
  const hostilePresent = observationAt({ x: 0, y: 64, z: 0 }, {
    entities: [{ id: "e1", name: "zombie", type: "zombie", position: { x: 2, y: 64, z: 0 }, distance: 2, health: 12 }],
  });
  assert.equal(verifySkillPostcondition("minecraft.attack-hostile", { entityId: "e1" }, hostilePresent, hostileGone).verified, true);
  assert.equal(
    verifySkillPostcondition("minecraft.attack-hostile", { entityId: "e1" }, hostilePresent, hostilePresent).verified,
    false,
    "a swing that left the hostile standing is not a kill",
  );

  const dropped = observationAt({ x: 0, y: 64, z: 0 }, { inventory: [] });
  const held = observationAt({ x: 0, y: 64, z: 0 }, { inventory: [stack("dirt", 4)] });
  assert.equal(verifySkillPostcondition("minecraft.drop-item", { itemName: "dirt", count: 4 }, held, dropped).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.drop-item", { itemName: "dirt", count: 4 }, held, held).verified, false);
});

test("hazard blocks are recognised and ordered ahead of ordinary terrain", () => {
  assert.equal(isHazardBlockName("lava"), true);
  assert.equal(isHazardBlockName("fire"), true);
  assert.equal(isHazardBlockName("magma_block"), true);
  // Water counts as a hazard because the agent can drown in it; the *escape* rule only fires for
  // blocks that hurt on contact, which is what `observedHazards` is used for.
  assert.equal(isHazardBlockName("water"), true);
  assert.equal(isHazardBlockName("cobblestone"), false);
  const hazards = observedHazards(
    [block("stone", 1, 64, 0), block("lava", 4, 64, 0), block("fire", 2, 64, 0)],
    { x: 0.5, y: 64.5, z: 0.5 },
  );
  assert.deepEqual(hazards.map((hazard) => hazard.name), ["fire", "lava"]);
  assert.ok(hazards[0]!.distance < hazards[1]!.distance);
  // Truncation order is what keeps a scarce block in the observation at all.
  assert.equal(blockObservationPriority("oak_log"), 2, "planned resources are never truncated away first");
  assert.equal(blockObservationPriority("lava"), 2);
  assert.equal(blockObservationPriority("stone"), 1, "mineable terrain beats plain scenery");
  assert.equal(blockObservationPriority("torch"), 0);
  assert.ok(
    blockObservationPriority("oak_log") > blockObservationPriority("stone"),
    "a log must survive the local-cube cap ahead of ordinary stone",
  );
});

test("the safety context projects the observation onto the facts the broker needs", () => {
  const night = observationAt({ x: 0, y: 64, z: 0 }, {
    time: { dayTicks: 18_000, day: 0, isNight: true },
    nearbyBlocks: [block("lava", 1, 64, 0)],
    entities: [{ id: "e1", name: "zombie", type: "zombie", position: { x: 5, y: 64, z: 0 }, distance: 5, health: 20 }],
    player: {
      username: "GameMind",
      position: { x: 0.5, y: 64, z: 0.5 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 14,
      food: 16,
      foodSaturation: 0,
      oxygenLevel: 300,
      onGround: true,
      inventoryFull: true,
    },
  });
  const context = minecraftSafetyContext(night, { observedAtMs: 5_000 });
  assert.equal(context.health, 14);
  assert.equal(context.food, 16);
  assert.equal(context.isNight, true);
  assert.equal(context.visibleHostiles, 1);
  assert.equal(context.nearestHostileDistance, 5);
  assert.equal(context.nearestHazardName, "lava");
  assert.ok((context.nearestHazardDistance ?? 99) < 2, "lava one block away is a near hazard");
  assert.equal(context.oxygenTicks, 300);
  assert.equal(context.dimension, "overworld");

  assert.equal(isNightTicks(6_000), false);
  assert.equal(isNightTicks(13_000), true);
  assert.equal(isNightTicks(22_999), true);
  assert.equal(isNightTicks(23_000), false);
  assert.equal(isNightTicks(6_000, true), true, "an adapter that classifies night itself is believed");
});

test("the Minecraft policy denies combat by default and bounds it when opted in", () => {
  assert.equal(MINECRAFT_SAFETY_POLICY.maxRisk, "medium");
  assert.deepEqual(MINECRAFT_SAFETY_POLICY.optedInCapabilities, []);
  assert.equal(MINECRAFT_COMBAT_CAPABILITY, "minecraft.attack_hostile");
  assert.equal(MINECRAFT_SAFETY_POLICY.perCapabilityMaxPerRun[MINECRAFT_COMBAT_CAPABILITY] !== undefined, true);
  assert.equal(MINECRAFT_SAFETY_POLICY.hazardMaxDistance !== null, true);
  assert.ok(MINECRAFT_SAFETY_POLICY.hazardBlockedCapabilities.includes("minecraft.mine_block"));
  assert.ok(
    !MINECRAFT_SAFETY_POLICY.hazardBlockedCapabilities.includes("minecraft.navigate"),
    "escaping a hazard must never be blocked by the hazard rule",
  );
  assert.ok(MINECRAFT_SAFETY_POLICY.protectedStateRecoverySkills.includes("minecraft.eat-food"));
});
