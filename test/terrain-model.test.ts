import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalTerrainModel } from "../src/games/minecraft/terrain-model.js";
import { chooseExplorationWaypoint } from "../src/games/minecraft/exploration.js";
import { MinecraftTaskDecisionModel, type MinecraftDecisionContext } from "../src/games/minecraft/decision-model.js";
import { DEFAULT_GATHER_LOG_TASK } from "../src/games/minecraft/task.js";
import { WorldMemory } from "../src/games/minecraft/world-memory.js";
import { block, observationAt } from "./support/observations.js";

const player = { x: 0.5, y: 64, z: 0.5 };
const context: MinecraftDecisionContext = {
  excludedTargets: new Set<string>(),
  previousFailureCode: null,
};

test("the current terrain model reports water, body-level obstacles, unknowns, and corridor confidence", () => {
  const state = observationAt(player, {
    nearbyBlocks: [
      block("grass_block", 0, 63, 0),
      block("water", 1, 64, 0),
      block("stone", 2, 64, 0),
      block("grass_block", 3, 63, 0),
    ],
    sampledRegion: {
      radius: 3,
      verticalRadius: 2,
      center: { x: 0, y: 64, z: 0 },
      sampledCells: 245,
      unknownCells: 7,
      truncated: false,
    },
  });
  const terrain = buildLocalTerrainModel(state);
  const summary = terrain.summary();
  const route = terrain.assessRoute({ x: 4.5, z: 0.5 });

  assert.equal(summary.waterColumns, 1);
  assert.equal(summary.hazardColumns, 1);
  assert.equal(summary.obstacleColumns, 1);
  assert.equal(summary.unknownCells, 7);
  assert.equal(route.waterColumns, 1);
  assert.equal(route.obstacleColumns, 1);
  assert.ok(route.risk > 30);
  assert.equal(route.confidence, "partial");
  assert.match(route.summary, /water column/);
});

test("gather planning prefers an alternative tree when the nearer direct corridor crosses observed water", () => {
  const close = block("oak_log", 10, 64, 0);
  const alternative = block("oak_log", 0, 64, 12);
  const wetState = observationAt(player, {
    nearbyBlocks: [close, alternative, block("water", 5, 64, 0), block("water", 6, 64, 0)],
  });
  const wetMemory = WorldMemory.fromObservation(wetState, 1);
  const wetDecision = new MinecraftTaskDecisionModel().decide(wetState, DEFAULT_GATHER_LOG_TASK, { ...context, memory: wetMemory });

  assert.equal(wetDecision.selected?.targetKey, "0,64,12");
  assert.match(wetDecision.selected?.rationale ?? "", /direct-corridor evidence/);

  // A changed observation is authoritative: old water is not carried into current route scoring.
  const dryState = observationAt(player, { nearbyBlocks: [close, alternative] });
  const dryMemory = WorldMemory.fromObservation(dryState, 2);
  const dryDecision = new MinecraftTaskDecisionModel().decide(dryState, DEFAULT_GATHER_LOG_TASK, { ...context, memory: dryMemory });
  assert.equal(dryDecision.selected?.targetKey, "10,64,0");
});

test("a memory-only resource is refreshed before collection and failed refresh can be excluded", () => {
  const previouslySeen = observationAt(player, { nearbyBlocks: [block("oak_log", 4, 64, 0)] });
  const memory = WorldMemory.fromObservation(previouslySeen, 1);
  const uncertain = observationAt(player, {
    nearbyBlocks: [],
    sampledRegion: {
      ...previouslySeen.sampledRegion,
      unknownCells: 1,
      truncated: true,
    },
    resourceScan: { ...previouslySeen.resourceScan, truncated: true },
  });
  const model = new MinecraftTaskDecisionModel();
  const refresh = model.decide(uncertain, DEFAULT_GATHER_LOG_TASK, { ...context, memory });
  assert.equal(refresh.selected?.goalId, "refresh:oak_log");
  assert.equal(refresh.selected?.skillId, "minecraft.inspect-block");
  assert.match(refresh.selected?.rationale ?? "", /does not confirm it/);

  const excluded = model.decide(uncertain, DEFAULT_GATHER_LOG_TASK, {
    ...context,
    memory,
    excludedTargets: new Set(["refresh:4,64,0"]),
  });
  assert.notEqual(excluded.selected?.goalId, "collect:oak_log");
});

test("exploration rejects currently unsafe destination cells but keeps unknown frontier eligible", () => {
  const memory = new WorldMemory();
  const unsafe = (x: number) => x > 0;
  const waypoint = chooseExplorationWaypoint(memory, {
    from: { x: 0.5, z: 0.5 },
    origin: { x: 0.5, z: 0.5 },
    maxRadius: 32,
    minLeg: 8,
    maxLeg: 24,
    hostileAvoidRadius: 6,
    excludedKeys: new Set<string>(),
    destinationUnsafe: (x) => unsafe(x),
    routeRisk: (x) => x === -12 ? 10 : 0,
  });

  assert.ok(waypoint);
  assert.ok(waypoint.x <= 0, `unsafe positive-x destination selected: ${waypoint.x}`);
});
