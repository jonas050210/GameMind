import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ExperienceStore, InMemoryExperienceStore } from "../src/core/learning/experience-store.js";
import {
  distanceBandOf,
  goalClassOf,
  threatBandOf,
  timeOfDayBandOf,
  vitalityBandOf,
  type Episode,
} from "../src/core/learning/episode.js";
import {
  DEFAULT_POLICY_GATE_THRESHOLDS,
  comparePolicyMetrics,
  type PolicyGateMetricSet,
} from "../src/core/learning/policy-gate.js";
import { ExperienceLearner } from "../src/core/learning/learner.js";
import { FailureMemory } from "../src/core/learning/failure-memory.js";
import { BASELINE_ADVISOR, ExperiencePolicyAdvisor } from "../src/core/learning/policy-advisor.js";
import {
  BASELINE_POLICY_WEIGHTS,
  derivePolicyWeights,
  parsePolicyWeights,
  policyWeightsEqual,
} from "../src/core/learning/policy-weights.js";
import {
  conservativeSuccessRate,
  contextKeyFor,
  foldEpisodes,
  smoothedSuccessRate,
  summariseStats,
} from "../src/core/learning/skill-statistics.js";

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    schemaVersion: 1,
    episodeId: `ep-${Math.random().toString(36).slice(2, 10)}`,
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    sequence: 1,
    timestamp: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    policyVersion: null,
    worldKey: "world-a",
    targetKey: "1,64,0",
    features: {
      goalClass: "gather",
      skillId: "minecraft.collect-log",
      band: 2,
      distance: 5,
      distanceBand: "medium",
      health: 20,
      hunger: 18,
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKind: "oak_log",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "succeeded",
      confirmed: true,
      verified: true,
      progress: true,
      failureCode: null,
      itemsGained: 1,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 400,
      distanceAfter: 0,
      safetyDenied: false,
    },
    ...overrides,
  };
}

test("episode bands compress raw numbers into comparable contexts", () => {
  assert.equal(distanceBandOf(1), "adjacent");
  assert.equal(distanceBandOf(300), "far");
  assert.equal(distanceBandOf(null), "unknown");
  assert.equal(vitalityBandOf(2, 2), "critical");
  assert.equal(vitalityBandOf(20, 20), "full");
  assert.equal(threatBandOf(0, false), "none");
  assert.equal(threatBandOf(1, true), "approaching");
  assert.equal(timeOfDayBandOf(true), "night");
  assert.equal(timeOfDayBandOf(undefined), "unknown");
  assert.equal(goalClassOf("collect:oak_log"), "collect");
  assert.equal(goalClassOf("avoid-nearby-hostile"), "avoid-nearby-hostile");
  const key = contextKeyFor(episode().features);
  assert.equal(key, contextKeyFor({ ...episode().features, distance: 900, health: 3 }));
  assert.notEqual(key, contextKeyFor({ ...episode().features, skillId: "minecraft.mine-block" }));
});

test("statistics are smoothed so one lucky run cannot redefine the policy", () => {
  const stats = foldEpisodes([
    episode(),
    episode({ outcome: { ...episode().outcome, status: "failed", confirmed: false, verified: false, progress: false, failureCode: "PATH_NOT_FOUND" } }),
    episode({
      runId: "run-2",
      features: { ...episode().features, threat: "approaching" },
      outcome: { ...episode().outcome, status: "rejected", safetyDenied: true, verified: null, progress: false },
    }),
  ]);
  const summary = summariseStats(stats);
  assert.equal(summary.length, 2, "a different threat level is a different context");
  const gather = summary.find((entry) => entry.key.includes("collect"));
  assert.ok(gather);
  assert.equal(gather.attempts, 2, "the two episodes with the same threat share one context");
  assert.equal(gather.successes, 1);
  assert.equal(gather.topFailureCode, "PATH_NOT_FOUND");
  const rejected = summary.find((entry) => entry.key.includes("approaching"));
  assert.ok(rejected);
  assert.equal(rejected.safetyDenials, 1);
  assert.equal(rejected.attempts, 1);

  const one = { attempts: 1, successes: 1, progressCount: 1, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: {}, ewmaDurationMs: 1, ewmaGain: 1, totalDistance: 1, distanceSamples: 1, lastSequence: 1 };
  assert.ok(smoothedSuccessRate(one) < 1, "a single success must not read as a certainty");
  assert.equal(smoothedSuccessRate({ ...one, attempts: 0, successes: 0 }), 0.5, "no data means no opinion");
  assert.ok(conservativeSuccessRate(one) < smoothedSuccessRate(one));
});

test("weights stay bounded, need evidence, and punish contradicted confirmations", () => {
  const base = {
    attempts: 30,
    successes: 0,
    progressCount: 0,
    contradictedConfirmations: 0,
    safetyDenials: 0,
    failureCodes: { PATH_NOT_FOUND: 30 },
    ewmaDurationMs: 900,
    ewmaGain: 0,
    totalDistance: 150,
    distanceSamples: 30,
    lastSequence: 30,
  };
  const stats = { [contextKeyFor(episode().features)]: base };
  const weights = derivePolicyWeights(stats, { episodes: 30, runs: 3 });
  const entry = weights.entries[contextKeyFor(episode().features)];
  assert.ok(entry, "30 attempts is enough evidence to hold an opinion");
  assert.ok(entry.weight >= 0.75 && entry.weight <= 1.25, `weight ${entry.weight} out of bounds`);
  assert.ok(entry.weight < 1, "a context that always fails must be down-weighted, never boosted");
  assert.equal(weights.source, "experience");
  assert.equal(weights.provenance.contexts, 1);

  const tooFew = derivePolicyWeights({ [contextKeyFor(episode().features)]: { ...base, attempts: 4, successes: 0 } }, { episodes: 4, runs: 1 });
  assert.deepEqual(tooFew.entries, {}, "below minSamples the policy must stay neutral");
  assert.equal(
    policyWeightsEqual(tooFew, BASELINE_POLICY_WEIGHTS),
    true,
    "a policy with no opinion at all has to be indistinguishable from the baseline",
  );

  const contradicted = derivePolicyWeights(
    { [contextKeyFor(episode().features)]: { ...base, successes: 30, progressCount: 30, failureCodes: {}, contradictedConfirmations: 12 } },
    { episodes: 30, runs: 3 },
  );
  const contradiction = contradicted.entries[contextKeyFor(episode().features)];
  const clean = derivePolicyWeights(
    { [contextKeyFor(episode().features)]: { ...base, successes: 30, progressCount: 30, failureCodes: {} } },
    { episodes: 30, runs: 3 },
  ).entries[contextKeyFor(episode().features)];
  assert.ok(contradiction && clean && contradiction.weight < clean.weight, "confirmations the world denied must cost the policy");

  assert.equal(derivePolicyWeights({}, { episodes: 0, runs: 0 }).entries["{}"], undefined);
  assert.equal(parsePolicyWeights({ nonsense: true }), null);
  assert.equal(parsePolicyWeights(null), null);
  assert.equal(
    parsePolicyWeights(JSON.parse(JSON.stringify(weights)))?.entries[contextKeyFor(episode().features)]?.weight,
    entry.weight,
    "weights must survive a JSON round trip",
  );
});

test("failure memory blocks a target only after repeated failure, forgets it after success or age", () => {
  const memory = new FailureMemory();
  for (let index = 0; index < 3; index += 1) {
    const entry = memory.recordFailure({
      worldKey: "world-a",
      targetKey: "1,64,0",
      goalClass: "mine",
      failureCode: "NAVIGATION_STUCK",
      runIndex: 0,
    });
    assert.ok(entry);
    assert.equal(entry.blocked, index >= 2);
  }
  assert.equal(memory.isBlocked("world-a", "1,64,0", 0), true);
  assert.equal(memory.isBlocked("world-b", "1,64,0", 0), false, "a lesson about one world must not bind another");
  assert.ok((memory.penaltyFor("world-a", "1,64,0", 0)?.penalty ?? 0) > 0);
  assert.equal(memory.penaltyFor("world-a", "9,9,9", 0), null);

  memory.recordSuccess({ worldKey: "world-a", targetKey: "1,64,0", runIndex: 1 });
  assert.equal(memory.isBlocked("world-a", "1,64,0", 1), false, "one observed success must weaken the ban");
  memory.recordSuccess({ worldKey: "world-a", targetKey: "1,64,0", runIndex: 1 });
  memory.recordSuccess({ worldKey: "world-a", targetKey: "1,64,0", runIndex: 1 });
  assert.equal(memory.size, 0, "the lesson is gone once the evidence is even");

  // Decayed lessons stop costing anything and are then dropped.
  const aged = new FailureMemory();
  for (let index = 0; index < 3; index += 1) {
    aged.recordFailure({ worldKey: "w", targetKey: "t", goalClass: "gather", failureCode: "X", runIndex: 0 });
  }
  const freshPenalty = aged.penaltyFor("w", "t", 0)?.penalty ?? 0;
  const oldPenalty = aged.penaltyFor("w", "t", 12)?.penalty ?? 0;
  assert.ok(oldPenalty < freshPenalty, "an old failure must weigh less than a recent one");
  assert.equal(aged.isBlocked("w", "t", 200), false, "past the forget horizon the block is lifted");
  assert.ok(aged.prune(200) >= 1);
  assert.equal(aged.size, 0);

  // The cap keeps a pathological world from growing the memory without bound.
  const capped = new FailureMemory({ maxEntries: 5 });
  for (let index = 0; index < 40; index += 1) {
    capped.recordFailure({ worldKey: "w", targetKey: `t-${index}`, goalClass: "gather", failureCode: "X", runIndex: index });
  }
  assert.equal(capped.size, 5);

  const snapshot = aged.snapshot(0);
  const restored = new FailureMemory();
  restored.restore(snapshot);
  assert.equal(restored.size, aged.size);
  restored.restore({ version: "wrong", entries: [] });
  assert.equal(restored.size, 0);
});

test("the advisor turns weights and failure memory into a score, and baseline advises nothing", () => {
  assert.deepEqual(
    BASELINE_ADVISOR.assess({
      skillId: "minecraft.collect-log",
      goalClass: "gather",
      distanceBand: "near",
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKey: "1,64,0",
    }),
    { multiplier: 1, penalty: 0, blocked: null, contextKey: "baseline", notes: [] },
  );

  const query = {
    skillId: "minecraft.collect-log",
    goalClass: "gather",
    distanceBand: "near" as const,
    vitality: "ok" as const,
    threat: "none" as const,
    timeOfDay: "day" as const,
    targetKey: "1,64,0",
  };
  const neutral = new ExperiencePolicyAdvisor().assess(query);
  assert.equal(neutral.multiplier, 1);
  assert.equal(neutral.notes.length, 0);

  const contextKey = contextKeyFor({ ...episode().features, distanceBand: "near" });
  const downWeighted = new ExperiencePolicyAdvisor({
    weights: {
      ...BASELINE_POLICY_WEIGHTS,
      id: "test-v1",
      source: "experience",
      entries: { [contextKey]: { weight: 0.8, samples: 20, evidence: 0.3, successRate: 0.2 } },
    },
  });
  const assessed = downWeighted.assess(query);
  assert.equal(assessed.multiplier, 0.8);
  assert.match(assessed.notes.join(" "), /learned weight/);

  const memory = new FailureMemory();
  for (let index = 0; index < 3; index += 1) {
    memory.recordFailure({ worldKey: "world-a", targetKey: "1,64,0", goalClass: "gather", failureCode: "X", runIndex: 0 });
  }
  const withMemory = new ExperiencePolicyAdvisor({ failureMemory: memory, worldKey: "world-a", runIndex: 0 });
  const blocked = withMemory.assess(query);
  assert.ok(blocked.blocked, "a thrice-failed cell in the same world is known unreachable");
  assert.ok(blocked.penalty > 0);
  const otherWorld = new ExperiencePolicyAdvisor({ failureMemory: memory, worldKey: "world-b", runIndex: 0 }).assess(query);
  assert.equal(otherWorld.blocked, null);
  const disabled = new ExperiencePolicyAdvisor({ failureMemory: memory, worldKey: "world-a", useTargetMemory: false }).assess(query);
  assert.equal(disabled.blocked, null, "target memory can be switched off without touching the weights");
});

test("the learner folds a run into persisted state and can rebuild after the state file is lost", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-learning-"));
  const learner = ExperienceLearner.forDirectory(directory);
  await learner.load();
  learner.beginRun({ runId: "run-a", taskId: "task", worldKey: "world-a" });
  const accepted = learner.recordEpisode(episode({ runId: "run-a" }));
  assert.ok(accepted, "a valid draft is kept");
  const rejected = learner.recordEpisode({
    runId: "run-a",
    taskId: "task",
    sessionId: null,
    sequence: -1,
    worldKey: null,
    policyVersion: null,
    targetKey: null,
    features: { ...episode().features, band: 99 },
    outcome: episode().outcome,
  });
  assert.equal(rejected, null, "an invalid draft is dropped instead of breaking the run");
  const report = await learner.finishRun({ note: "test run" });
  assert.equal(report.episodes, 1);
  assert.equal(report.runs, 1);
  assert.equal(report.successes, 1);

  const stateFile = path.join(directory, "state.json");
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.runs, 1);
  assert.equal(persisted.episodes, 1);
  assert.match(persisted.history[0].note, /test run/);
  const lines = (await readFile(path.join(directory, "episodes.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);

  // A fresh process must recover the same numbers from disk.
  const reopened = ExperienceLearner.forDirectory(directory);
  await reopened.load();
  assert.equal(reopened.snapshot().episodes, 1);
  assert.equal(reopened.snapshot().runs, 1);

  // Delete the derived state: the append-only log is the source of truth and rebuilds it.
  await writeFile(stateFile, "{ this is not json", "utf8");
  const rebuilt = ExperienceLearner.forDirectory(directory);
  const state = await rebuilt.load();
  assert.equal(state.episodes, 1);
  assert.equal(state.runs, 1);
  rebuilt.beginRun({ runId: "run-b", taskId: "task", worldKey: "world-a" });
  for (let index = 0; index < 3; index += 1) {
    rebuilt.recordEpisode(
      episode({
        runId: "run-b",
        sequence: index,
        outcome: { ...episode().outcome, status: "failed", confirmed: false, verified: null, progress: false, failureCode: "PATH_NOT_FOUND" },
      }),
    );
  }
  const second = await rebuilt.finishRun();
  assert.equal(second.failures, 3);
  assert.equal(second.blockedTargets, 1, "three failures on one target make it a known dead end");

  // Promotion is explicit and reversible, and only a promoted policy influences decisions.
  const strongStats = {
    [contextKeyFor(episode().features)]: {
      attempts: 30,
      successes: 30,
      progressCount: 30,
      contradictedConfirmations: 0,
      safetyDenials: 0,
      failureCodes: {},
      ewmaDurationMs: 120,
      ewmaGain: 1,
      totalDistance: 0,
      distanceSamples: 30,
      lastSequence: 5,
    },
  };
  const weights = derivePolicyWeights(strongStats, { episodes: 30, runs: 3 });
  assert.ok(Object.keys(weights.entries).length > 0, "the fabricated statistics must be strong enough to hold a weight");
  assert.equal(rebuilt.advisor().id, BASELINE_POLICY_WEIGHTS.id, "candidate weights must not steer yet");
  await rebuilt.promote(weights, "gate passed");
  const promoted = await ExperienceLearner.forDirectory(directory).load();
  assert.equal(promoted.activeWeights?.id, weights.id);
  await rebuilt.rollback();
  assert.equal(rebuilt.snapshot().activePolicy, null);
  assert.match(rebuilt.snapshot().history[0]?.note ?? "", /rolled back/);

  // A disabled learner records nothing at all.
  const disabled = new ExperienceLearner({ enabled: false });
  disabled.beginRun({ runId: "x", taskId: "y", worldKey: null });
  assert.equal(disabled.recordEpisode(episode()), null);
  assert.equal((await disabled.finishRun()).episodes, 0);
});

test("the episode store appends, tolerates damaged lines and compacts past its cap", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-store-"));
  const store = new ExperienceStore({ directory, maxEpisodes: 12 });
  await store.appendMany(Array.from({ length: 10 }, (_unused, index) => episode({ sequence: index })));
  await writeFile(store.filePath, `${await readFile(store.filePath, "utf8")}not json at all\n`, "utf8");
  const loaded = await store.load();
  assert.equal(loaded.episodes.length, 10);
  assert.equal(loaded.skippedLines, 1, "a torn line is counted, not fatal");
  assert.ok(loaded.episodes.every((entry) => entry.runId === "run-1"));
  const stats = await store.stats();
  assert.equal(stats.episodes, 10, "the damaged line is not counted as experience");
  assert.equal(stats.skippedLines, 1);
  assert.equal(stats.runs, 1);
  assert.equal(stats.firstRunId, "run-1");

  await store.appendMany(Array.from({ length: 8 }, (_unused, index) => episode({ runId: `run-${index}` })));
  const compacted = await store.load();
  assert.ok(compacted.episodes.length <= 12, `compaction failed: ${compacted.episodes.length} episodes kept`);
  assert.equal(compacted.episodes.at(-1)?.runId, "run-7", "the most recent experience survives");

  const memory = new InMemoryExperienceStore();
  await memory.appendMany([episode(), episode({ episodeId: "b" })]);
  assert.equal((await memory.load()).episodes.length, 2);
  assert.equal((await memory.stats()).episodes, 2);
});

function metricSet(overrides: Partial<PolicyGateMetricSet> & { scenarios: PolicyGateMetricSet["scenarios"] }): PolicyGateMetricSet {
  return {
    label: "set",
    runs: 20,
    successRate: 0.5,
    unsafeActions: 0,
    deaths: 0,
    unverifiedConfirmations: 0,
    medianActions: 10,
    ...overrides,
  };
}

test("the policy gate promotes only provable improvements and never a safety regression", () => {
  const baseline = metricSet({
    label: "baseline",
    successRate: 0.6,
    scenarios: [
      { scenarioId: "a", successRate: 0.6, unsafeActions: 0, deaths: 0, unverifiedConfirmations: 0, medianActions: 10 },
    ],
  });

  const better = metricSet({
    label: "candidate",
    successRate: 0.7,
    medianActions: 9,
    scenarios: [
      { scenarioId: "a", successRate: 0.7, unsafeActions: 0, deaths: 0, unverifiedConfirmations: 0, medianActions: 9 },
    ],
  });
  const promoted = comparePolicyMetrics(baseline, better);
  assert.equal(promoted.promote, true);
  assert.ok(promoted.improvements.length > 0);
  assert.deepEqual(promoted.blocking, []);

  const equal = comparePolicyMetrics(baseline, { ...baseline, label: "same" });
  assert.equal(equal.promote, false, "a policy that changes nothing must not be promoted");
  assert.match(equal.reasons.join(" "), /no measurable improvement/);

  const unsafe = comparePolicyMetrics(baseline, metricSet({
    label: "unsafe",
    successRate: 0.9,
    unsafeActions: 1,
    scenarios: [
      { scenarioId: "a", successRate: 0.9, unsafeActions: 1, deaths: 0, unverifiedConfirmations: 0, medianActions: 5 },
    ],
  }));
  assert.equal(unsafe.promote, false, "one unsafe action blocks promotion no matter how much better it scores");
  assert.match(unsafe.blocking.join(" "), /unsafe action/);

  const scenarioRegression = comparePolicyMetrics(
    metricSet({
      successRate: 0.8,
      scenarios: [
        { scenarioId: "a", successRate: 1, unsafeActions: 0, deaths: 0, unverifiedConfirmations: 0, medianActions: 5 },
        { scenarioId: "b", successRate: 0.6, unsafeActions: 0, deaths: 0, unverifiedConfirmations: 0, medianActions: 5 },
      ],
    }),
    metricSet({
      label: "candidate",
      successRate: 0.85,
      scenarios: [
        { scenarioId: "a", successRate: 0.4, unsafeActions: 0, deaths: 0, unverifiedConfirmations: 0, medianActions: 5 },
        { scenarioId: "b", successRate: 1, unsafeActions: 0, deaths: 0, unverifiedConfirmations: 0, medianActions: 5 },
      ],
    }),
  );
  assert.equal(scenarioRegression.promote, false, "a net win that breaks one scenario is still a regression");
  assert.match(scenarioRegression.blocking.join(" "), /'a' regressed/);

  const missing = comparePolicyMetrics(baseline, metricSet({ scenarios: [] }));
  assert.equal(missing.promote, false);
  assert.match(missing.blocking.join(" "), /did not evaluate scenario 'a'/);

  assert.equal(DEFAULT_POLICY_GATE_THRESHOLDS.allowSafetyIncidents, false);
  const tolerant = comparePolicyMetrics(baseline, metricSet({
    label: "candidate",
    successRate: 0.7,
    medianActions: 9,
    unsafeActions: 1,
    scenarios: [
      { scenarioId: "a", successRate: 0.7, unsafeActions: 1, deaths: 0, unverifiedConfirmations: 0, medianActions: 9 },
    ],
  }), { allowSafetyIncidents: true });
  assert.equal(tolerant.blocking.length, 0, "an explicit threshold change can downgrade the incident to a note");
});
