/**
 * The decision model's gates over live session facts. These are the planner half of the two misdetections
 * the live test hit: a survival world read as "not survival", and an overworld read as "no overworld".
 * Both were the *policy* being applied to a value the session had never reported, so the rule under test
 * here is: block only on what the session positively said, and say which it was.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MinecraftTaskDecisionModel,
  RejectionLedger,
  type MinecraftDecisionContext,
} from "../src/games/minecraft/decision-model.js";
import { DEFAULT_GATHER_LOG_TASK, secureFoodTaskSchema } from "../src/games/minecraft/task.js";
import { block, observationAt } from "./support/observations.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";

const origin = { x: 0.5, y: 64, z: 0.5 };
const model = new MinecraftTaskDecisionModel();

function context(overrides: Partial<MinecraftDecisionContext> = {}): MinecraftDecisionContext {
  return { excludedTargets: new Set<string>(), previousFailureCode: null, ledger: new RejectionLedger(), ...overrides };
}

/** A log within reach, so any "blocked" verdict comes from a gate and not from an empty world. */
function world(player: Partial<MinecraftObservation["player"]>): MinecraftObservation {
  return observationAt(origin, {
    player: { ...observationAt(origin).player, ...player },
    nearbyBlocks: [block("oak_log", 2, 64, 0)],
    resourceSightings: [{ name: "oak_log", position: { x: 2, y: 64, z: 0 }, distance: 2.1 }],
  });
}

test("an unreported game mode or dimension does not stop the plan", () => {
  const state = world({
    gameMode: null,
    dimension: null,
    session: {
      dimension: { value: null, evidence: "unreported", source: "no usable dimension", observed: "bot.game.dimension=undefined", note: "the live session has not reported a dimension yet" },
      gameMode: { value: null, evidence: "unreported", source: "no usable game mode", observed: "bot.game.gameMode=undefined", note: "the live session has not reported a game mode" },
    },
  });
  const ledger = new RejectionLedger();
  const decision = model.decide(state, DEFAULT_GATHER_LOG_TASK, context({ ledger }));
  assert.notEqual(decision.terminalStatus, "blocked", `the gate fired anyway: ${decision.summary}`);
  assert.ok(decision.selected, "the agent has something to do");
  const notes = ledger.all.filter((entry) => entry.reason === "not_applicable");
  assert.ok(
    notes.some((entry) => /game mode is unreported/.test(entry.detail)),
    "the uncertainty is recorded instead of hidden",
  );
  assert.ok(notes.some((entry) => /dimension is unreported/.test(entry.detail)));
});

test("a verified non-survival mode blocks, and the refusal quotes the evidence", () => {
  const state = world({
    gameMode: "creative",
    session: {
      gameMode: { value: "creative", evidence: "verified", source: "bot.game.gameMode + bot.player.gamemode", observed: "both said creative", note: null },
    },
  });
  const decision = model.decide(state, DEFAULT_GATHER_LOG_TASK, context());
  assert.equal(decision.terminalStatus, "blocked");
  assert.equal(decision.blockingCode, "TASK_BLOCKED_MODE");
  assert.match(decision.summary, /creative \(verified: bot\.game\.gameMode \+ bot\.player\.gamemode\)/);
});

test("sources that disagree about the mode do not produce a refusal", () => {
  const state = world({
    gameMode: null,
    session: {
      gameMode: {
        value: null,
        evidence: "conflicting",
        source: "the live sources disagree",
        observed: "bot.game.gameMode=creative, bot.player.gamemode=survival",
        note: "the session reported creative (bot.game.gameMode) and survival (bot.player.gamemode)",
      },
    },
  });
  const decision = model.decide(state, DEFAULT_GATHER_LOG_TASK, context());
  assert.notEqual(decision.terminalStatus, "blocked");
  assert.equal(decision.selected?.skillId, "minecraft.collect-log", "a survival player keeps collecting");
});

test("a dimension the session really reported as elsewhere blocks log work", () => {
  const state = world({
    dimension: "the_nether",
    session: {
      dimension: { value: "the_nether", evidence: "single-source", source: "dimension name from the live session", observed: "bot.game.dimension=the_nether", note: null },
    },
  });
  const decision = model.decide(state, DEFAULT_GATHER_LOG_TASK, context());
  assert.equal(decision.terminalStatus, "blocked");
  assert.equal(decision.blockingCode, "TASK_BLOCKED_DIMENSION");
  assert.match(decision.summary, /the_nether \(from dimension name from the live session\)/);
});

test("an unfamiliar dimension name is kept verbatim in the refusal, never folded into overworld", () => {
  const state = world({
    dimension: "custom:lobby",
    session: {
      dimension: {
        value: "custom:lobby",
        evidence: "single-source",
        source: "unrecognised dimension name from the live session",
        observed: "bot.game.dimension=custom:lobby",
        note: "'custom:lobby' is not a dimension this agent knows; it is reported as-is, never as the overworld",
      },
    },
  });
  const decision = model.decide(state, DEFAULT_GATHER_LOG_TASK, context());
  assert.equal(decision.blockingCode, "TASK_BLOCKED_DIMENSION");
  assert.match(decision.summary, /custom:lobby/);
  assert.doesNotMatch(decision.summary, /current dimension is 'overworld'/);
});

test("every decision carries the session facts it was made from", () => {
  const state = world({ gameMode: "survival", dimension: "overworld" });
  const decision = model.decide(state, DEFAULT_GATHER_LOG_TASK, context());
  assert.equal(decision.session?.gameMode.value, "survival");
  assert.equal(decision.session?.gameMode.evidence, "single-source", "the observation said so once, and the record does not claim more");
  assert.equal(decision.session?.dimension.observed, "dimension=\"overworld\"");
  assert.match(JSON.stringify(decision), /gameMode/, "the record is serialisable with its evidence for the trace file");
});

test("missing vitals suppress the health-driven goals instead of inventing healthy numbers", () => {
  const ledger = new RejectionLedger();
  const state = observationAt(origin, {
    player: {
      ...observationAt(origin).player,
      health: null,
      food: null,
      foodSaturation: null,
      alive: null,
    },
  });
  const decision = model.decide(state, secureFoodTaskSchema.parse({ id: "secure", kind: "secure_food", targetHunger: 18 }), context({ ledger }));
  assert.notEqual(decision.terminalStatus, "completed", "an unreported hunger cannot be declared met");
  assert.ok(
    ledger.all.some((entry) => /hunger was not reported/.test(entry.detail)),
    "the reason the task is not complete is recorded",
  );
  assert.doesNotMatch(JSON.stringify(decision), /20\/20 reached the target/);

  const gathering = model.decide(state, DEFAULT_GATHER_LOG_TASK, context());
  assert.doesNotMatch(gathering.summary, /Health is 20\.0\/20/, "no fabricated health appears in a rationale");
});

test("a task no registered skill can carry is named as a missing capability", () => {
  const state = observationAt(origin, {
    player: { ...observationAt(origin).player, food: 3 },
    nearbyBlocks: [block("oak_log", 2, 64, 0)],
    resourceSightings: [{ name: "oak_log", position: { x: 2, y: 64, z: 0 }, distance: 2.1 }],
  });
  const decision = model.decide(state, DEFAULT_GATHER_LOG_TASK, context({ availableSkills: new Set(["minecraft.orient"]) }));
  assert.deepEqual(
    [...(decision.capabilityGap ?? [])],
    ["minecraft.collect-log", "minecraft.mine-block", "minecraft.pickup-item"],
    "the gap names every route the task could have taken",
  );
  assert.ok(decision.blockingCode, "a blocked decision still carries its own code next to the gap");
  const withCollection = model.decide(state, DEFAULT_GATHER_LOG_TASK, context({ availableSkills: new Set(["minecraft.collect-log"]) }));
  assert.deepEqual(withCollection.capabilityGap, null, "one available route is enough not to call it a capability gap");
});
