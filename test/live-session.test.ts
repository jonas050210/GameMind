/**
 * Regression tests for the live-session readers, written against the shapes Mineflayer 1.20.4 actually
 * produces (numeric dimension ids, `bot.game = {}` before login, two independent game-mode sources, a
 * `timeOfDay` that is already a tick count, and vitals that simply do not exist until the first
 * `update_health` packet).
 *
 * These are offline tests of parsing rules only: they do not prove that a live server behaves this way —
 * they pin down what the code does when it does.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  airTicksFromSession,
  describeSessionField,
  dimensionDefinitelyNotOverworld,
  gameModeDefinitelyNotSurvival,
  isSurvivalLike,
  normalizeDimension,
  readDimension,
  readGameMode,
  readTimeInfo,
  readVitals,
  type LiveBotLike,
} from "../src/games/minecraft/live-session.js";

const value = (raw: unknown): string | null => normalizeDimension(raw).value;

test("dimension is read from what the session reports, in every shape Mineflayer uses", () => {
  assert.equal(value("overworld"), "overworld");
  assert.equal(value("minecraft:overworld"), "overworld");
  // A numeric dimension id from the login packet: 0 = overworld.
  assert.equal(value(0), "overworld");
  assert.equal(value(-1), "the_nether");
  assert.equal(value(1), "the_end");
  // Level names a Bukkit/Spigot/Paper server can report instead of a dimension id.
  assert.equal(value("world"), "overworld");
  assert.equal(value("World" as unknown as string), "overworld");
  // A custom world name is a real answer and is kept verbatim; it is never folded into "overworld".
  assert.equal(value("custom:lobby"), "custom:lobby");
  assert.equal(value("flat_world_preset"), "flat_world_preset");
  // Unusable input is reported as no value at all.
  assert.equal(value(undefined), null);
  assert.equal(value(null), null);
  assert.equal(value(Number.NaN), null);
  assert.equal(value(""), null);
  assert.equal(value({ name: "overworld" }), null);
});

test("an unmapped dimension id and an unknown name are explained, not guessed", () => {
  const unmapped = normalizeDimension(7);
  assert.equal(unmapped.value, null);
  assert.equal(unmapped.evidence, "unreported");
  assert.match(String(unmapped.note ?? ""), /does not map/);

  const custom = normalizeDimension("custom:lobby");
  assert.equal(custom.value, "custom:lobby");
  assert.equal(custom.evidence, "single-source");
  assert.match(String(custom.note ?? ""), /overworld/i, "the reader must say it did not treat this as the overworld");
});

test("a dimension the session never sent is unknown, never 'not the overworld'", () => {
  // `bot.game` is an empty object until the login packet has been handled.
  const fresh = readDimension({ game: {} } as unknown as LiveBotLike);
  assert.equal(fresh.value, null);
  assert.equal(fresh.evidence, "unreported");
  assert.equal(dimensionDefinitelyNotOverworld(fresh), false);

  const missing = readDimension({} as unknown as LiveBotLike);
  assert.equal(missing.value, null);
  assert.match(missing.observed, /bot\.game\.dimension=undefined/);
  assert.equal(dimensionDefinitelyNotOverworld(missing), false);

  const nether = readDimension({ game: { dimension: "minecraft:the_nether" } } as unknown as LiveBotLike);
  assert.equal(nether.value, "the_nether");
  assert.equal(dimensionDefinitelyNotOverworld(nether), true);

  // This is the exact live failure the gate had: an absent field read as "definitely not the overworld".
  assert.notEqual(readDimension({ game: { dimension: undefined } } as unknown as LiveBotLike).value, "overworld");
});

test("game mode is cross-checked between the two live sources", () => {
  const agreeing = readGameMode({
    game: { gameMode: "survival" },
    player: { gamemode: 0 },
  } as unknown as LiveBotLike);
  assert.equal(agreeing.value, "survival");
  assert.equal(agreeing.evidence, "verified");
  assert.equal(agreeing.source, "bot.game.gameMode + bot.player.gamemode");

  const onlyGame = readGameMode({ game: { gameMode: "creative" } } as unknown as LiveBotLike);
  assert.equal(onlyGame.value, "creative");
  assert.equal(onlyGame.evidence, "single-source");
  assert.equal(gameModeDefinitelyNotSurvival(onlyGame), true);

  // `bot.game.gameMode` only refreshes on a `game_state_change` with reason 3, so it can lag a `/gamemode`
  // change that `bot.player.gamemode` already saw. A disagreement is reported as a disagreement.
  const conflicting = readGameMode({
    game: { gameMode: "creative" },
    player: { gamemode: 0 },
  } as unknown as LiveBotLike);
  assert.equal(conflicting.value, null);
  assert.equal(conflicting.evidence, "conflicting");
  assert.equal(gameModeDefinitelyNotSurvival(conflicting), false, "a conflict must not become a refusal");
  assert.match(conflicting.observed, /bot\.game\.gameMode=creative/);
  assert.match(conflicting.observed, /bot\.player\.gamemode=0/);
  assert.match(String(conflicting.note ?? ""), /survival \(bot\.player\.gamemode\)/);

  // A hardcore server reports `hardcore: true` at login with `gameMode: "survival"` afterwards.
  const hardcore = readGameMode({
    game: { gameMode: "survival", hardcore: true },
    player: { gamemode: 0 },
  } as unknown as LiveBotLike);
  assert.equal(hardcore.value, "hardcore");
  assert.equal(isSurvivalLike(hardcore.value), true);
  assert.equal(gameModeDefinitelyNotSurvival(hardcore), false);

  const unreported = readGameMode({ game: {} } as unknown as LiveBotLike);
  assert.equal(unreported.value, null);
  assert.equal(unreported.evidence, "unreported");
  assert.equal(gameModeDefinitelyNotSurvival(unreported), false);

  // The raw mode id is a bitfield on some servers: survival plus the hardcore flag reads as hardcore,
  // and a value that is not explicable stays unknown instead of defaulting to Creative.
  assert.equal(readGameMode({ player: { gamemode: 4 } } as unknown as LiveBotLike).value, "hardcore");
  assert.equal(readGameMode({ player: { gamemode: 99 } } as unknown as LiveBotLike).value, null);
});

test("vitals keep 'the session never said' separate from zero, dead and full", () => {
  const silent = readVitals({} as unknown as LiveBotLike);
  assert.equal(silent.health, null);
  assert.equal(silent.food, null);
  assert.equal(silent.foodSaturation, null);
  assert.equal(silent.airTicks, null);
  assert.equal(silent.alive, null, "an unreported life state is not a death");
  assert.match(silent.healthObserved, /health=undefined/);

  const dead = readVitals({ health: 0, isAlive: false } as unknown as LiveBotLike);
  assert.equal(dead.health, 0);
  assert.equal(dead.alive, false);

  const aliveWithoutFlag = readVitals({ health: 12.5 } as unknown as LiveBotLike);
  assert.equal(aliveWithoutFlag.alive, true);

  // NaN and undefined arrive from real sessions mid-respawn; neither may become 0.
  const partial = readVitals({ health: Number.NaN, food: undefined } as unknown as LiveBotLike);
  assert.equal(partial.health, null);
  assert.equal(partial.food, null);
  assert.equal(partial.alive, null);

  // An explicit life flag wins over an inferred one, including when it contradicts health.
  assert.equal(readVitals({ health: 20, isAlive: false } as unknown as LiveBotLike).alive, false);
});

test("the air gauge is converted from Mineflayer's levels back to ticks", () => {
  // `bot.oxygenLevel` is `Math.round(air_supply / 15)`, so a full gauge is 20 levels, not 10.
  assert.equal(airTicksFromSession(20).value, 300);
  assert.equal(airTicksFromSession(10).value, 150);
  assert.equal(airTicksFromSession(0).value, 0);
  assert.equal(airTicksFromSession(undefined).value, null, "no air metadata is not 'full lungs'");
  assert.equal(airTicksFromSession(null).value, null);
  // Mineflayer uses a negative gauge for "not submerged", which is not a partial reading.
  assert.equal(airTicksFromSession(-1).value, null);
  // An out-of-range gauge is clamped to the contract's range rather than trusted.
  assert.equal(airTicksFromSession(40).value, 300);
  assert.equal(airTicksFromSession(20).evidence, "single-source");
});

test("time is read as ticks, and only when the session actually has a clock", () => {
  assert.equal(readTimeInfo({} as unknown as LiveBotLike), null);
  assert.equal(readTimeInfo({ time: {} } as unknown as LiveBotLike), null, "the initialised-but-empty time object is not a measurement");
  assert.equal(readTimeInfo({ time: { timeOfDay: null, isDay: null } } as unknown as LiveBotLike), null);

  // Mineflayer sets `timeOfDay = time % 24000`: already ticks. Scaling it by 24000 (the old bug) pinned
  // every value to the top of the day and made the run believe it was permanently near sunset.
  const day = readTimeInfo({ time: { timeOfDay: 6_000, day: 3, isDay: true } } as unknown as LiveBotLike);
  assert.equal(day?.dayTicks, 6_000);
  assert.equal(day?.day, 3);
  assert.equal(day?.isNight, false);
  assert.equal(day?.source, "time.timeOfDay + time.isDay");

  const night = readTimeInfo({ time: { timeOfDay: 18_000, isDay: false } } as unknown as LiveBotLike);
  assert.equal(night?.dayTicks, 18_000);
  assert.equal(night?.isNight, true);

  // Late sunset is still day according to the server's own flag, which wins over the tick window.
  const serverSaysDay = readTimeInfo({ time: { timeOfDay: 13_500, isDay: true } } as unknown as LiveBotLike);
  assert.equal(serverSaysDay?.isNight, false);

  // Only the day flag: the tick count is reported as unknown, not as 0.
  const flagOnly = readTimeInfo({ time: { isDay: false } } as unknown as LiveBotLike);
  assert.equal(flagOnly?.dayTicks, null);
  assert.equal(flagOnly?.isNight, true);
  assert.equal(flagOnly?.source, "time.isDay");

  // A genuine fraction from another client build is still scaled.
  assert.equal(readTimeInfo({ time: { timeOfDay: 0.25 } } as unknown as LiveBotLike)?.dayTicks, 6_000);
});

test("a session field describes itself with its evidence, so a claim can be audited", () => {
  const verified = readGameMode({ game: { gameMode: "survival" }, player: { gamemode: 0 } } as unknown as LiveBotLike);
  assert.equal(describeSessionField(verified), "survival (verified: bot.game.gameMode + bot.player.gamemode)");

  const single = readGameMode({ game: { gameMode: "adventure" } } as unknown as LiveBotLike);
  assert.equal(describeSessionField(single), "adventure (from bot.game.gameMode)");

  const unreported = readGameMode({ game: {} } as unknown as LiveBotLike);
  assert.match(describeSessionField(unreported), /^unknown \(/);
  assert.match(describeSessionField(unreported), /not reported/);

  const conflicting = readGameMode({ game: { gameMode: "creative" }, player: { gamemode: 0 } } as unknown as LiveBotLike);
  assert.match(describeSessionField(conflicting), /^unknown \(the session reported/);
});
