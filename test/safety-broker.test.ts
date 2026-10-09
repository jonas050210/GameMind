import assert from "node:assert/strict";
import test from "node:test";
import { SafetyBroker } from "../src/core/safety-broker.js";
import type { SafetyWorldContext } from "../src/core/safety-broker.js";

function worldContext(overrides: Partial<SafetyWorldContext> = {}): SafetyWorldContext {
  return {
    sequence: 1,
    observedAtMs: 1_000,
    health: 20,
    food: 20,
    gameMode: "survival",
    visibleHostiles: 0,
    nearestHostileDistance: null,
    isNight: false,
    ...overrides,
  };
}

test("the broker denies high-risk capabilities until the operator opts in", () => {
  const broker = new SafetyBroker({ maxRisk: "medium" });
  broker.beginRun("run-1");
  broker.updateWorld(worldContext());

  const denied = broker.evaluate({
    capability: "minecraft.attack_hostile",
    risk: "high",
    skillId: "minecraft.attack-hostile",
    nowMs: 1_500,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "RISK_ABOVE_CEILING");

  const opted = new SafetyBroker({ maxRisk: "medium", optedInCapabilities: ["minecraft.attack_hostile"] });
  opted.beginRun("run-2");
  opted.updateWorld(worldContext());
  const allowed = opted.evaluate({
    capability: "minecraft.attack_hostile",
    risk: "high",
    skillId: "minecraft.attack-hostile",
    nowMs: 1_500,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, "ALLOWED");
});

test("an unavailable observation fails closed, a stale one is refused, read-only actions still run", () => {
  const broker = new SafetyBroker({ maxObservationAgeMs: 5_000 });
  broker.beginRun("run-fresh");
  const blind = broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 });
  assert.equal(blind.allowed, false);
  assert.equal(blind.code, "NO_OBSERVATION");

  broker.updateWorld(worldContext({ observedAtMs: 0 }));
  const stale = broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 10_000 });
  assert.equal(stale.allowed, false);
  assert.equal(stale.code, "STALE_OBSERVATION");

  const readOnly = broker.evaluate({ capability: "minecraft.look", risk: "low", nowMs: 10_000 });
  assert.equal(readOnly.allowed, true, "looking around never depends on a fresh observation");
});

test("run and per-capability budgets bound a runaway planner", () => {
  const broker = new SafetyBroker({ maxActionsPerRun: 2, perCapabilityMaxPerRun: { "minecraft.navigate": 5 } });
  broker.beginRun("run-budget");
  broker.updateWorld(worldContext());
  const request = { capability: "minecraft.navigate", risk: "low" as const, nowMs: 1_000 };
  assert.equal(broker.evaluate(request).allowed, true);
  assert.equal(broker.evaluate(request).allowed, true);
  const third = broker.evaluate(request);
  assert.equal(third.allowed, false);
  assert.equal(third.code, "RUN_ACTION_BUDGET");

  const perCapability = new SafetyBroker({ perCapabilityMaxPerRun: { "minecraft.eat_food": 1 } });
  perCapability.beginRun("run-cap");
  perCapability.updateWorld(worldContext());
  assert.equal(
    perCapability.evaluate({ capability: "minecraft.eat_food", risk: "low", nowMs: 1_000 }).allowed,
    true,
  );
  const exhausted = perCapability.evaluate({ capability: "minecraft.eat_food", risk: "low", nowMs: 1_000 });
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.code, "CAPABILITY_BUDGET");
});

test("cooldowns separate repeated actions in time", () => {
  const broker = new SafetyBroker({ cooldownMsByCapability: { "minecraft.place_block": 500 } });
  broker.beginRun("run-cooldown");
  broker.updateWorld(worldContext());
  const request = { capability: "minecraft.place_block", risk: "medium" as const, nowMs: 1_000 };
  assert.equal(
    broker.evaluate({ ...request, nowMs: 1_000 }).allowed,
    true,
    "the first swing is approved",
  );
  const early = broker.evaluate({ ...request, nowMs: 1_200 });
  assert.equal(early.allowed, false);
  assert.equal(early.code, "CAPABILITY_COOLDOWN");
  assert.equal(
    broker.evaluate({ ...request, nowMs: 1_600 }).allowed,
    true,
    "the cooldown expires after 500 ms",
  );
});

test("pause blocks world changes, trip blocks everything until an operator resumes", () => {
  const broker = new SafetyBroker();
  broker.beginRun("run-pause");
  broker.updateWorld(worldContext());
  broker.pause("operator is watching");
  const paused = broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 });
  assert.equal(paused.allowed, false);
  assert.equal(paused.code, "RUN_PAUSED");
  assert.equal(
    broker.evaluate({ capability: "minecraft.look", risk: "low", nowMs: 1_000 }).allowed,
    true,
    "inspection keeps working while paused",
  );

  broker.resume();
  assert.equal(broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 }).allowed, true);
  broker.trip("health collapsed");
  const tripped = broker.evaluate({ capability: "minecraft.look", risk: "low", nowMs: 1_000 });
  assert.equal(tripped.allowed, false);
  assert.equal(tripped.code, "RUN_TRIPPED");
  broker.resume();
  assert.equal(
    broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 }).allowed,
    false,
    "resume() must not clear a trip; only an explicit reset may",
  );
});

test("clearing a trip lifts the pause the trip imposed but never an operator's own pause", () => {
  const broker = new SafetyBroker();
  broker.beginRun("run-trip-reset");
  broker.updateWorld(worldContext());

  broker.trip("health collapsed");
  assert.equal(broker.snapshot().tripped, true);
  assert.equal(broker.snapshot().paused, true, "tripping freezes the run as well as denying approvals");
  broker.clearTrip();
  assert.equal(broker.snapshot().tripped, false);
  assert.equal(
    broker.snapshot().paused,
    false,
    "the pause that came from the trip is released with it, so a reset actually restarts the agent",
  );

  broker.pause("operator is reading the trace");
  broker.trip("lava at the player's feet");
  broker.clearTrip();
  assert.equal(broker.snapshot().tripped, false);
  assert.equal(broker.snapshot().paused, true, "an explicit pause outlives the trip that followed it");
  assert.equal(broker.snapshot().pauseReason, "operator is reading the trace", "and keeps its own reason");
  assert.equal(
    broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 }).code,
    "RUN_PAUSED",
    "so the run stays frozen until the operator resumes it",
  );
  broker.resume();
  assert.equal(broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 }).allowed, true);
});

test("a disabled policy is a panic switch for everything but reading", () => {
  const broker = new SafetyBroker({ enabled: false });
  broker.beginRun("run-disabled");
  broker.updateWorld(worldContext());
  assert.equal(
    broker.evaluate({ capability: "minecraft.inspect_block", risk: "low", nowMs: 1_000 }).allowed,
    true,
  );
  const denied = broker.evaluate({ capability: "minecraft.eat_food", risk: "low", nowMs: 1_000 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "POLICY_DISABLED");
});

test("the denylist wins over the allowlist, and the allowlist excludes everything else", () => {
  const denylist = new SafetyBroker({ denylist: ["minecraft.build_shelter"] });
  denylist.beginRun("run-deny");
  denylist.updateWorld(worldContext());
  assert.equal(
    denylist.evaluate({ capability: "minecraft.build_shelter", risk: "medium", nowMs: 1_000 }).code,
    "CAPABILITY_DENIED",
  );

  const allowlist = new SafetyBroker({ allowlist: ["minecraft.navigate"] });
  allowlist.beginRun("run-allow");
  allowlist.updateWorld(worldContext());
  assert.equal(allowlist.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 }).allowed, true);
  const notAllowed = allowlist.evaluate({ capability: "minecraft.craft_item", risk: "low", nowMs: 1_000 });
  assert.equal(notAllowed.allowed, false);
  assert.equal(notAllowed.code, "CAPABILITY_NOT_ALLOWLISTED");
});

test("the protected health floor only allows recovery skills", () => {
  const broker = new SafetyBroker({
    protectedHealthFloor: 6,
    protectedStateRecoverySkills: ["minecraft.eat-food", "minecraft.navigate"],
  });
  broker.beginRun("run-floor");
  broker.updateWorld(worldContext({ health: 5 }));
  const blocked = broker.evaluate({
    capability: "minecraft.mine_block",
    risk: "medium",
    skillId: "minecraft.mine-block",
    nowMs: 1_000,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "PROTECTED_STATE");
  assert.equal(
    broker.evaluate({ capability: "minecraft.eat_food", risk: "low", skillId: "minecraft.eat-food", nowMs: 1_000 })
      .allowed,
    true,
  );
});

test("hazards block stationary actions but never the escape", () => {
  const broker = new SafetyBroker({
    hazardMaxDistance: 2.5,
    hazardBlockedCapabilities: ["minecraft.mine_block", "minecraft.rest"],
  });
  broker.beginRun("run-hazard");
  broker.updateWorld(worldContext({ nearestHazardDistance: 1.4, nearestHazardName: "lava" }));
  const dig = broker.evaluate({ capability: "minecraft.mine_block", risk: "medium", nowMs: 1_000 });
  assert.equal(dig.allowed, false);
  assert.equal(dig.code, "HAZARD_NEARBY");
  assert.match(dig.message, /A lava block is 1\.4 blocks away/);
  assert.equal(
    broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 }).allowed,
    true,
    "leaving the area stays allowed while a hazard is close",
  );

  broker.updateWorld(worldContext({ nearestHazardDistance: 9 }));
  assert.equal(broker.evaluate({ capability: "minecraft.mine_block", risk: "medium", nowMs: 1_000 }).allowed, true);
});

test("a running-out-of-air check denies stationary work and the void dimension denies everything", () => {
  const broker = new SafetyBroker({ drowningBlockedCapabilities: ["minecraft.rest"] });
  broker.beginRun("run-drown");
  broker.updateWorld(worldContext({ oxygenTicks: 40 }));
  assert.equal(broker.evaluate({ capability: "minecraft.rest", risk: "low", nowMs: 1_000 }).code, "DROWNING_RISK");
  broker.updateWorld(worldContext({ oxygenTicks: 300 }));
  assert.equal(broker.evaluate({ capability: "minecraft.rest", risk: "low", nowMs: 1_000 }).allowed, true);

  const voidBroker = new SafetyBroker({ hazardMaxDistance: 2.5 });
  voidBroker.beginRun("run-void");
  voidBroker.updateWorld(worldContext({ dimension: "minecraft:the_void" }));
  assert.equal(voidBroker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 }).code, "VOID");
});

test("the snapshot reports policy, counters and the most recent verdicts for the UI", () => {
  const broker = new SafetyBroker({ maxActionsPerRun: 1 });
  broker.beginRun("run-snapshot");
  broker.updateWorld(worldContext());
  broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 });
  broker.evaluate({ capability: "minecraft.navigate", risk: "medium", nowMs: 1_000 });
  const snapshot = broker.snapshot();
  assert.equal(snapshot.runId, "run-snapshot");
  assert.equal(snapshot.actionsApproved, 1);
  assert.equal(snapshot.actionsDenied, 1);
  assert.equal(snapshot.approvedByCapability["minecraft.navigate"], 1);
  assert.equal(snapshot.deniedByCode["RUN_ACTION_BUDGET"], 1);
  assert.equal(snapshot.world?.health, 20);
  assert.equal(snapshot.recentVerdicts[0]?.code, "RUN_ACTION_BUDGET");
  assert.equal(snapshot.policy.maxActionsPerRun, 1);
});

test("configure() validates the policy instead of accepting nonsense", () => {
  const broker = new SafetyBroker();
  assert.throws(() => broker.configure({ maxActionsPerRun: 0 }), /positive integer/);
  assert.throws(() => broker.configure({ maxObservationAgeMs: 10 }), /at least 1000 ms/);
});

test("an older sequence from a finished run cannot overwrite the live world context", () => {
  const broker = new SafetyBroker();
  broker.beginRun("run-order");
  broker.updateWorld(worldContext({ sequence: 9, health: 12 }));
  broker.updateWorld(worldContext({ sequence: 4, health: 3 }));
  assert.equal(broker.world?.health, 12);
  broker.endRun();
  broker.updateWorld(worldContext({ sequence: 4, health: 3 }));
  assert.equal(broker.world?.health, 3, "outside a run the newest write wins, e.g. a fresh session");
});
