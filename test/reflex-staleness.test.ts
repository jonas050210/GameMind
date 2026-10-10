/**
 * The stale-decision guard, offline unit tests: a decision computed from one world snapshot must not be dispatched
 * unchanged once a newly urgent condition appears (drowning, a threat, a hazard), but routine change must not force a
 * re-decision. The snapshots are minimal objects that carry only the fields the reflex assessment reads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { urgentReflexesSince, type ObservedSnapshot } from "../src/games/minecraft/reflex.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";

function snapshot(sequence: number, player: Record<string, unknown>, entities: unknown[] = []): ObservedSnapshot {
  const base = {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    oxygenLevel: 300,
    onGround: true,
    alive: true,
    inWater: false,
    headInWater: false,
  };
  const state = { player: { ...base, ...player }, entities, nearbyBlocks: [], inventory: [], equipment: {} };
  return { state: state as unknown as MinecraftObservation, sequence, observedAt: new Date(1_700_000_000_000 + sequence * 500).toISOString() };
}

test("an unchanged world produces no urgent reflex, so the decision is dispatched as made", () => {
  const decision = snapshot(1, {});
  const latest = snapshot(2, {});
  assert.deepEqual([...urgentReflexesSince(decision, latest)], []);
});

test("the same observation is never treated as a change", () => {
  const decision = snapshot(3, { health: 2 });
  assert.deepEqual([...urgentReflexesSince(decision, decision)], []);
});

test("a newly critical health level is urgent and blocks the stale decision", () => {
  const decision = snapshot(1, { health: 20 });
  const latest = snapshot(2, { health: 4 });
  const urgent = urgentReflexesSince(decision, latest);
  assert.ok(urgent.length > 0, "critical health that was not present when the decision was made is urgent");
});

test("a condition already present in the decision's basis is not re-flagged (edge trigger)", () => {
  const decision = snapshot(1, { health: 4 });
  const latest = snapshot(2, { health: 4 });
  assert.deepEqual([...urgentReflexesSince(decision, latest)], [], "an old, already-known threat does not discard every decision");
});

test("entering the water while air is running out is urgent", () => {
  const decision = snapshot(1, { inWater: false, headInWater: false, oxygenLevel: 300 });
  const latest = snapshot(2, { inWater: true, headInWater: true, oxygenLevel: 40 });
  assert.ok(urgentReflexesSince(decision, latest).length > 0, "drowning risk that appears after the decision is urgent");
});
