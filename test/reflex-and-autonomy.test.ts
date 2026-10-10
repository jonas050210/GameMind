import assert from "node:assert/strict";
import test from "node:test";
import { AutonomyController, subgoalSignature } from "../src/games/minecraft/autonomy-controller.js";
import { generateAutonomousTask } from "../src/games/minecraft/autonomous-task.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { assessReflex, newlyUrgent, REFLEX_THRESHOLDS } from "../src/games/minecraft/reflex.js";
import { ProgressTracker } from "../src/games/minecraft/progress-tracker.js";
import type { MinecraftTaskResult } from "../src/games/minecraft/task-runner.js";

function state(overrides: Partial<MinecraftObservation> & { playerOverrides?: Partial<MinecraftObservation["player"]> } = {}): MinecraftObservation {
  const { playerOverrides, ...rest } = overrides;
  return {
    player: {
      username: "TestAgent",
      position: { x: 0, y: 64, z: 0 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 300,
      onGround: true,
      alive: true,
      ...(playerOverrides ?? {}),
    },
    inventory: [],
    equipment: { hand: null, offhand: null, head: null, torso: null, legs: null, feet: null },
    entities: [],
    nearbyBlocks: [],
    resourceSightings: [],
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: false },
    itemDrops: [],
    sampledRegion: { radius: 5, verticalRadius: 3, center: { x: 0, y: 64, z: 0 }, sampledCells: 100, unknownCells: 0, truncated: false },
    time: { dayTicks: 6000, day: 1, isNight: false },
    ...rest,
  } as MinecraftObservation;
}

test("reflexes: critical health and starvation are urgent; ordinary health is not", () => {
  const critical = assessReflex(state({ playerOverrides: { health: REFLEX_THRESHOLDS.criticalHealth - 1 } }));
  assert.equal(critical.urgent, true);
  assert.ok(critical.urgentCodes.includes("CRITICAL_HEALTH"));

  const healthy = assessReflex(state({ playerOverrides: { health: 18 } }));
  assert.equal(healthy.urgent, false);
  assert.deepEqual(healthy.urgentCodes, []);

  const starving = assessReflex(state({ playerOverrides: { food: REFLEX_THRESHOLDS.starvingHunger - 1 } }));
  assert.equal(starving.urgent, true, "starving with no food held is urgent");
});

test("reflexes: a hostile inside the close radius is urgent, one farther away only a notice", () => {
  const close = assessReflex(
    state({ entities: [{ id: "z1", name: "zombie", type: "hostile", position: { x: 2, y: 64, z: 0 }, distance: REFLEX_THRESHOLDS.hostileCloseDistance - 1, health: 20 }] as never }),
  );
  assert.equal(close.urgent, true);

  const far = assessReflex(
    state({ entities: [{ id: "z2", name: "zombie", type: "hostile", position: { x: 7, y: 64, z: 0 }, distance: REFLEX_THRESHOLDS.hostileNearDistance - 1, health: 20 }] as never }),
  );
  assert.equal(far.urgent, false, "a hostile at a moderate distance is noted, not urgent");
  assert.ok(far.reasons.length > 0);
});

test("reflexes: newlyUrgent reports only the urgent codes that were not urgent before", () => {
  const before = assessReflex(state({ playerOverrides: { health: 5 } }));
  const after = assessReflex(state({ playerOverrides: { health: 5, food: 2 } }));
  assert.deepEqual(newlyUrgent(before, null), before.urgentCodes, "with no history every urgent code is new");
  const stillUrgent = newlyUrgent(after, before);
  assert.ok(!stillUrgent.includes("CRITICAL_HEALTH"), "a condition that was already urgent does not re-trigger an interrupt");
});

function result(overrides: Partial<MinecraftTaskResult> & { progressEvents?: number } = {}): MinecraftTaskResult {
  const { progressEvents = 0, ...rest } = overrides;
  return {
    status: "failed",
    failure: { code: "CONSECUTIVE_ACTION_FAILURES", message: "no progress" },
    actions: [],
    metrics: { progressEvents, targetItemsGained: 0, foodGained: 0, actions: 0, wastedActions: 0 },
    finalObservation: null,
    ...rest,
  } as unknown as MinecraftTaskResult;
}

test("autonomy: a subgoal with repeated no-progress attempts cools down and the controller falls back", () => {
  let clock = 1_000_000;
  const tracker = new ProgressTracker();
  const controller = new AutonomyController({ tracker, now: () => clock, cooldownMs: 120_000, failuresBeforeCooldown: 2 });
  const observed = state();
  const first = controller.next(observed);
  assert.ok(first.task, "a subgoal is chosen for an empty inventory");
  const signature = subgoalSignature(first.task!);

  controller.record(first.task!, result());
  assert.equal(controller.next(observed).task && subgoalSignature(controller.next(observed).task!), signature, "one failure is not yet a cooldown");
  controller.record(first.task!, result());

  const afterCooldown = controller.next(observed);
  assert.notEqual(afterCooldown.task === null ? null : subgoalSignature(afterCooldown.task), signature, "the cooling subgoal is not chosen again");
  assert.equal(controller.snapshot().cooldowns.length, 1);

  clock += 120_001;
  const later = controller.next(observed);
  assert.equal(later.task ? subgoalSignature(later.task) : null, signature, "the subgoal is eligible again once the cooldown expires");
});

test("autonomy: a productive run clears the streak and an aborted run is not judged", () => {
  let clock = 0;
  const tracker = new ProgressTracker();
  const controller = new AutonomyController({ tracker, now: () => clock, cooldownMs: 120_000, failuresBeforeCooldown: 2 });
  const task = controller.next(state()).task!;
  controller.record(task, result({ status: "aborted", failure: { code: "REFLEX_INTERRUPT", message: "urgent" } } as never));
  controller.record(task, result({ status: "aborted", failure: { code: "REFLEX_INTERRUPT", message: "urgent" } } as never));
  assert.equal(controller.snapshot().cooldowns.length, 0, "interrupted runs are neutral: they never start a cooldown");
  controller.record(task, result({ progressEvents: 2 } as never));
  assert.equal(controller.snapshot().consecutiveNoProgress, 0, "observed progress resets the no-progress count");
});

test("autonomy: an observed stable world yields the same tasks the milestone generator would, not invented ones", () => {
  const tracker = new ProgressTracker();
  const controller = new AutonomyController({ tracker, now: () => 0 });
  const observed = state({ inventory: [{ slot: 0, name: "bread", type: 1, count: 3, metadata: null, durabilityUsed: null }] as never, playerOverrides: { food: 10 } });
  const expected = generateAutonomousTask(observed, tracker);
  const decision = controller.next(observed);
  assert.equal(decision.task?.id, expected?.id);
});
