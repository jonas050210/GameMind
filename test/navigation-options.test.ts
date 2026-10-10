/** The two movement settings an operator may change (doors, drop-down). The defaults stay the conservative ones. */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MINECRAFT_CONFIG, minecraftAdapterConfigFromEnv } from "../src/games/minecraft/minecraft-adapter.js";

test("the defaults keep doors closed to the planner and a one-block drop", () => {
  assert.equal(DEFAULT_MINECRAFT_CONFIG.navigationAllowDoors, false);
  assert.equal(DEFAULT_MINECRAFT_CONFIG.navigationMaxDropDown, 1);
  const config = minecraftAdapterConfigFromEnv({});
  assert.equal(config.navigationAllowDoors, false);
  assert.equal(config.navigationMaxDropDown, 1);
});

test("the environment can change both settings", () => {
  const config = minecraftAdapterConfigFromEnv({ MINECRAFT_NAV_ALLOW_DOORS: "true", MINECRAFT_NAV_MAX_DROP: "3" });
  assert.equal(config.navigationAllowDoors, true);
  assert.equal(config.navigationMaxDropDown, 3);
});

test("bad values are refused with the variable's name in the message", () => {
  assert.throws(() => minecraftAdapterConfigFromEnv({ MINECRAFT_NAV_ALLOW_DOORS: "yes" }), /MINECRAFT_NAV_ALLOW_DOORS/);
  assert.throws(() => minecraftAdapterConfigFromEnv({ MINECRAFT_NAV_MAX_DROP: "4" }), /MINECRAFT_NAV_MAX_DROP/);
  assert.throws(() => minecraftAdapterConfigFromEnv({ MINECRAFT_NAV_MAX_DROP: "1.5" }), /MINECRAFT_NAV_MAX_DROP/);
});
