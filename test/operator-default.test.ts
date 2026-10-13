import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MINECRAFT_OPERATOR, applyDefaultMinecraftOperator } from "../src/app/operator-default.js";
import { minecraftAdapterConfigFromEnv } from "../src/games/minecraft/minecraft-adapter.js";

test("the project operator is used when no operator is configured", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyDefaultMinecraftOperator(env), "JonasBubi");
  assert.equal(env.MINECRAFT_OPERATOR, DEFAULT_MINECRAFT_OPERATOR);
  assert.equal(minecraftAdapterConfigFromEnv(env).operatorUsername, "JonasBubi");
});

test("a blank operator counts as unset and gets the default", () => {
  const env: NodeJS.ProcessEnv = { MINECRAFT_OPERATOR: "   " };
  assert.equal(applyDefaultMinecraftOperator(env), "JonasBubi");
});

test("an explicitly configured operator overrides the default", () => {
  const env: NodeJS.ProcessEnv = { MINECRAFT_OPERATOR: "Operator_1" };
  assert.equal(applyDefaultMinecraftOperator(env), "Operator_1");
  assert.equal(env.MINECRAFT_OPERATOR, "Operator_1");
});

test("the adapter configuration still defaults to no operator when the CLI default is not applied", () => {
  assert.equal(minecraftAdapterConfigFromEnv({}).operatorUsername, null);
});
