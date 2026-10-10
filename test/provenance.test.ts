import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { episodeProvenanceOf, episodeSchema, type Episode } from "../src/core/learning/episode.js";
import { ExperienceLearner } from "../src/core/learning/learner.js";

/*
 * Dataset provenance: every new episode says where it came from, and legacy rows are classified from their
 * identifiers without being rewritten. The classes must never be mixed silently in the roadmap evidence.
 */

function legacyRow(overrides: Partial<Episode> = {}): Episode {
  return episodeSchema.parse({
    schemaVersion: 1,
    episodeId: "ep-legacy-000001",
    runId: "autonomous:mine-iron-ore-74100",
    taskId: "autonomous:mine-iron-ore",
    sessionId: "sim-101-1-38df2090",
    sequence: 53,
    timestamp: "2026-10-10T08:55:09.957Z",
    policyVersion: null,
    features: {
      goalClass: "explore",
      skillId: "minecraft.navigate",
      band: 2,
      distance: 29.5,
      distanceBand: "far",
      health: 20,
      hunger: 18,
      vitality: "full",
      threat: "none",
      timeOfDay: "day",
      targetKind: "explore",
      actionIndex: 3,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "failed",
      confirmed: false,
      verified: null,
      progress: false,
      failureCode: "PATH_NOT_FOUND",
      itemsGained: 0,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 31,
      distanceAfter: 29.5,
      safetyDenied: false,
    },
    targetKey: "explore:1,8",
    worldKey: "explore-remote-log#101",
    ...overrides,
  } as never);
}

test("legacy simulator rows without a provenance field are classified, and say so", () => {
  const row = legacyRow();
  assert.equal(row.provenance, undefined, "the stored row is not rewritten");
  assert.deepEqual(episodeProvenanceOf(row), { provenance: "simulator-unlabelled", inferred: true });
});

test("training rows are recognised from the train- run prefix or the train: world key", () => {
  assert.equal(episodeProvenanceOf(legacyRow({ runId: "train-000012", sessionId: "sim-1000012-1-x", worldKey: "train:food-remote-berries:1000012" })).provenance, "training");
  assert.equal(episodeProvenanceOf(legacyRow({ runId: "train-000012" })).provenance, "training");
});

test("an explicit provenance wins over inference, in both directions", () => {
  assert.deepEqual(episodeProvenanceOf(legacyRow({ provenance: "live", sessionId: "sim-1-1-x" })), { provenance: "live", inferred: false });
  assert.deepEqual(episodeProvenanceOf(legacyRow({ provenance: "simulator-demo" })), { provenance: "simulator-demo", inferred: false });
});

test("rows with no simulator session and no explicit class are unlabelled, not live", () => {
  const row = legacyRow({ sessionId: null, worldKey: null, runId: "autonomous:x" });
  assert.deepEqual(episodeProvenanceOf(row), { provenance: "unlabelled", inferred: true });
});

test("the schema rejects an unknown provenance class", () => {
  assert.throws(() => episodeSchema.parse({ ...legacyRow(), provenance: "guess" }));
});

test("the learner writes the provenance it was given, and defaults to unlabelled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-provenance-"));
  try {
    const learner = ExperienceLearner.forDirectory(directory);
    await learner.load();
    learner.beginRun({ runId: "run-p", taskId: "task", worldKey: "world-p" });
    const base = legacyRow();
    const explicit = learner.recordEpisode({
      runId: "run-p",
      taskId: "task",
      sessionId: "session-p",
      sequence: 1,
      worldKey: "world-p",
      policyVersion: null,
      targetKey: "oak_log@1,64,1",
      features: base.features,
      outcome: base.outcome,
      provenance: "simulator-eval",
    });
    const implicit = learner.recordEpisode({
      runId: "run-p",
      taskId: "task",
      sessionId: "session-p",
      sequence: 2,
      worldKey: "world-p",
      policyVersion: null,
      targetKey: "oak_log@1,64,1",
      features: base.features,
      outcome: base.outcome,
    });
    assert.equal(explicit?.provenance, "simulator-eval");
    assert.equal(implicit?.provenance, "unlabelled");
    await learner.finishRun({ note: "provenance test" });
    const lines = (await readFile(path.join(directory, "episodes.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Episode);
    assert.deepEqual(lines.map((episode) => episode.provenance), ["simulator-eval", "unlabelled"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
