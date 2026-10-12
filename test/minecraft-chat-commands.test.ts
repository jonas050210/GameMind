import assert from "node:assert/strict";
import test from "node:test";
import { parseMinecraftChatCommand } from "../src/games/minecraft/chat-commands.js";
import { minecraftGiveItemInputSchema } from "../src/games/minecraft/capabilities.js";
import { canMineWithTier, minecraftMiningRequirements, miningDropFor } from "../src/games/minecraft/mining.js";

test("chat grammar supports explicit movement, hold, stop, status and one-turn questions", () => {
  assert.deepEqual(parseMinecraftChatCommand("folge mir"), { kind: "mode", mode: "follow" });
  assert.deepEqual(parseMinecraftChatCommand("komm zu mir"), { kind: "mode", mode: "come" });
  assert.deepEqual(parseMinecraftChatCommand("bleib hier"), { kind: "mode", mode: "hold" });
  assert.deepEqual(parseMinecraftChatCommand("STOPP"), { kind: "mode", mode: "stop" });
  assert.deepEqual(parseMinecraftChatCommand("status"), { kind: "mode", mode: "status" });
  assert.deepEqual(parseMinecraftChatCommand("ja"), { kind: "confirm", yes: true });
  assert.deepEqual(parseMinecraftChatCommand("nein"), { kind: "confirm", yes: false });
  assert.equal(parseMinecraftChatCommand("hey, was gibt's neues?"), null, "ordinary chat is not interpreted as an action");
});

test("resource-count language distinguishes additional amounts from total inventory targets", () => {
  assert.deepEqual(parseMinecraftChatCommand("hol noch 5 diamanten"), {
    kind: "resource",
    resourceName: "diamond_ore",
    itemName: "diamond",
    count: 5,
    countMode: "additional",
    label: "Diamanten",
  });
  assert.deepEqual(parseMinecraftChatCommand("farme weiter, bis du 5 hast"), {
    kind: "continue-resource",
    count: 5,
    countMode: "total",
  });
  assert.deepEqual(parseMinecraftChatCommand("get 5 more iron"), {
    kind: "resource",
    resourceName: "iron_ore",
    itemName: "raw_iron",
    count: 5,
    countMode: "additional",
    label: "Roheisen",
  });
  assert.deepEqual(parseMinecraftChatCommand("mine until you have 5 coal"), {
    kind: "resource",
    resourceName: "coal_ore",
    itemName: "coal",
    count: 5,
    countMode: "total",
    label: "Kohle",
  });
});

test("house grammar keeps generic designs separate from the explicit starter prototype", () => {
  assert.deepEqual(parseMinecraftChatCommand("plan house A"), { kind: "house_blueprint", conceptId: "A" });
  assert.deepEqual(parseMinecraftChatCommand("Plane großes Haus C"), { kind: "house_blueprint", conceptId: "C" });
  assert.deepEqual(parseMinecraftChatCommand("haus plan b"), { kind: "house_blueprint", conceptId: "B" });
  assert.deepEqual(parseMinecraftChatCommand("build a house"), { kind: "house_plan" });
  assert.deepEqual(parseMinecraftChatCommand("baue ein großes Haus"), { kind: "house_plan" });
  assert.deepEqual(parseMinecraftChatCommand("build a small house"), { kind: "house", coordinates: null });
  assert.deepEqual(parseMinecraftChatCommand("build a big house with a small garden"), { kind: "house_plan" });
  assert.deepEqual(parseMinecraftChatCommand("baue Starterhaus"), { kind: "house", coordinates: null });
  assert.deepEqual(parseMinecraftChatCommand("build starter house at -12 64 90"), {
    kind: "house",
    coordinates: { x: -12, y: 64, z: 90 },
  });
});

test("excavation grammar parses dimensions and optional world coordinates", () => {
  assert.deepEqual(parseMinecraftChatCommand("grabe 10x10x10 hier aus"), {
    kind: "excavate",
    width: 10,
    height: 10,
    depth: 10,
    coordinates: null,
  });
  assert.deepEqual(parseMinecraftChatCommand("dig 3×4×5 at -12 64 90"), {
    kind: "excavate",
    width: 3,
    height: 4,
    depth: 5,
    coordinates: { x: -12, y: 64, z: 90 },
  });
  assert.deepEqual(parseMinecraftChatCommand("build a wheat farm 25x50"), {
    kind: "farm_wheat",
    width: 25,
    depth: 50,
    coordinates: null,
  });
  assert.deepEqual(parseMinecraftChatCommand("pflanze Weizenfeld 25x50 bei 10 64 -8"), {
    kind: "farm_wheat",
    width: 25,
    depth: 50,
    coordinates: { x: 10, y: 64, z: -8 },
  });
});

test("operator transfer capability is resource-allowlisted and requires a valid username and bounded count", () => {
  const valid = minecraftGiveItemInputSchema.safeParse({ itemName: "diamond", count: 5, targetUsername: "Operator_1" });
  assert.equal(valid.success, true);
  assert.equal(minecraftGiveItemInputSchema.safeParse({ itemName: "iron_pickaxe", count: 1, targetUsername: "Operator_1" }).success, false);
  assert.equal(minecraftGiveItemInputSchema.safeParse({ itemName: "diamond", count: 65, targetUsername: "Operator_1" }).success, false);
  assert.equal(minecraftGiveItemInputSchema.safeParse({ itemName: "diamond", count: 1, targetUsername: "not a user" }).success, false);
});

test("diamond ore needs iron-tier mining tools and has an explicit diamond drop", () => {
  assert.equal(miningDropFor("diamond_ore"), "diamond");
  assert.equal(minecraftMiningRequirements.diamond_ore.minPickaxeTier, 3);
  assert.equal(canMineWithTier("diamond_ore", 2).mineable, false);
  assert.equal(canMineWithTier("diamond_ore", 3).mineable, true);
  assert.equal(canMineWithTier("deepslate_diamond_ore", 2).mineable, false);
  assert.equal(canMineWithTier("deepslate_diamond_ore", 3).mineable, true);
});
