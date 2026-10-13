import assert from "node:assert/strict";
import test from "node:test";
import {
  SHELTER_SEAL_TOTAL,
  analyzeShelterSeal,
  analyzeShelterSealFromObservation,
  shelterSealTargets,
  type ShelterCellState,
} from "../src/games/minecraft/shelter.js";
import { isShelteredFromState } from "../src/games/minecraft/decision-model.js";
import { block, observationAt, stack } from "./support/observations.js";

const feet = { x: 0, y: 64, z: 0 };

/** Cell reader over a fixed set of solid coordinates; everything else is observed open. */
function reader(solid: Array<[number, number, number]>, unknown: Array<[number, number, number]> = []) {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const solidKeys = new Set(solid.map(([x, y, z]) => key(x, y, z)));
  const unknownKeys = new Set(unknown.map(([x, y, z]) => key(x, y, z)));
  return (x: number, y: number, z: number): ShelterCellState => {
    if (unknownKeys.has(key(x, y, z))) return "unknown";
    return solidKeys.has(key(x, y, z)) ? "solid" : "open";
  };
}

/** All 25 enclosure coordinates, for building a fully closed fixture. */
function fullEnclosure(): Array<[number, number, number]> {
  return shelterSealTargets(feet.x, feet.y, feet.z).map((target) => [target.x, target.y, target.z]);
}

test("the enclosure has 25 distinct cells, the player's own cell is never one of them, and the roof centre is built last", () => {
  const targets = shelterSealTargets(feet.x, feet.y, feet.z);
  assert.equal(targets.length, SHELTER_SEAL_TOTAL);
  assert.equal(SHELTER_SEAL_TOTAL, 25);
  const keys = new Set(targets.map((target) => `${target.x},${target.y},${target.z}`));
  assert.equal(keys.size, 25, "no duplicate cells");
  assert.equal(keys.has("0,64,0"), false, "the feet cell stays open for the agent");
  assert.equal(keys.has("0,65,0"), false, "the head cell stays open for the agent");
  assert.deepEqual(targets.at(-1), { x: 0, y: 66, z: 0, layer: "roof" });
  // Layers are built bottom-up so every block has an already-placed support below or beside it.
  assert.deepEqual(targets.slice(0, 8).map((target) => target.layer), Array(8).fill("feet"));
  assert.deepEqual(targets.slice(8, 16).map((target) => target.layer), Array(8).fill("head"));
  assert.deepEqual(targets.slice(16).map((target) => target.layer), Array(9).fill("roof"));
});

test("four walls at feet level are not a shelter: diagonals and the roof stay open", () => {
  const fourWalls: Array<[number, number, number]> = [[1, 64, 0], [-1, 64, 0], [0, 64, 1], [0, 64, -1]];
  const analysis = analyzeShelterSeal(feet.x, feet.y, feet.z, reader(fourWalls), { solid: true, safe: true });
  assert.equal(analysis.sealed, false);
  assert.equal(analysis.solidCount, 4);
  assert.equal(analysis.missing.length, 21);
});

test("a fully observed 3×3×3 enclosure on a safe floor is sealed", () => {
  const analysis = analyzeShelterSeal(feet.x, feet.y, feet.z, reader(fullEnclosure()), { solid: true, safe: true });
  assert.equal(analysis.sealed, true);
  assert.equal(analysis.solidCount, 25);
  assert.deepEqual(analysis.solidByLayer, { feet: 8, head: 8, roof: 9 });
  assert.equal(analysis.missing.length, 0);
});

test("a missing roof centre keeps the shelter open even when all walls exist", () => {
  const withoutCentre = fullEnclosure().filter(([x, y, z]) => !(x === 0 && y === 66 && z === 0));
  const analysis = analyzeShelterSeal(feet.x, feet.y, feet.z, reader(withoutCentre), { solid: true, safe: true });
  assert.equal(analysis.sealed, false);
  assert.deepEqual(analysis.missing.map((target) => `${target.x},${target.y},${target.z}`), ["0,66,0"]);
});

test("an unobserved cell is never counted as closed, and it is reported as unknown", () => {
  const unknownRoof: Array<[number, number, number]> = [[0, 66, 0]];
  const analysis = analyzeShelterSeal(
    feet.x,
    feet.y,
    feet.z,
    reader(fullEnclosure().filter(([x, y, z]) => !(x === 0 && y === 66 && z === 0)), unknownRoof),
    { solid: true, safe: true },
  );
  assert.equal(analysis.sealed, false);
  assert.equal(analysis.unknown.length, 1);
});

test("an unsafe or missing floor blocks the seal even when all 25 cells are solid", () => {
  const unsafe = analyzeShelterSeal(feet.x, feet.y, feet.z, reader(fullEnclosure()), { solid: true, safe: false });
  const missingFloor = analyzeShelterSeal(feet.x, feet.y, feet.z, reader(fullEnclosure()), { solid: false, safe: false });
  assert.equal(unsafe.sealed, false);
  assert.equal(missingFloor.sealed, false);
});

test("the observation-based check agrees with the cell rule, and an unknown region in the scan is not evidence of air", () => {
  const closed = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [
      block("grass_block", 0, 63, 0),
      ...fullEnclosure().map(([x, y, z]) => block("dirt", x, y, z)),
    ],
    inventory: [stack("dirt", 0)],
  });
  assert.equal(analyzeShelterSealFromObservation(closed).sealed, true);
  assert.equal(isShelteredFromState(closed), true);

  const fourWallsOnly = observationAt({ x: 0.5, y: 64, z: 0.5 }, {
    nearbyBlocks: [
      block("grass_block", 0, 63, 0),
      block("dirt", 1, 64, 0),
      block("dirt", -1, 64, 0),
      block("dirt", 0, 64, 1),
      block("dirt", 0, 64, -1),
    ],
  });
  assert.equal(isShelteredFromState(fourWallsOnly), false, "four feet-level walls are not sheltered");
});
