/**
 * What counts as evidence. These tests pin the rule the whole learning chain now shares: an action is a success only
 * when the adapter confirmed it and the world did not contradict the confirmation; a failure only counts against a
 * choice when it says something about that choice; and experience from the simulator never shapes a live policy.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Episode, EpisodeOutcome } from "../src/core/learning/episode.js";
import { ExperienceLearner } from "../src/core/learning/learner.js";
import { classifyOutcome } from "../src/core/learning/outcome.js";
import { applyEpisode, emptySkillStat, foldEpisodes } from "../src/core/learning/skill-statistics.js";
import { derivePolicyWeights } from "../src/core/learning/policy-weights.js";

function outcome(overrides: Partial<EpisodeOutcome> = {}): EpisodeOutcome {
  return {
    status: "succeeded",
    confirmed: true,
    verified: true,
    progress: true,
    failureCode: null,
    itemsGained: 1,
    itemsConsumed: 0,
    healthDelta: 0,
    foodDelta: 0,
    durationMs: 1_000,
    distanceAfter: 0,
    safetyDenied: false,
    ...overrides,
  };
}

let counter = 0;
function episode(overrides: Partial<Omit<Episode, "outcome">> & { outcome?: Partial<EpisodeOutcome> } = {}): Episode {
  counter += 1;
  const { outcome: outcomeOverrides, ...rest } = overrides;
  return {
    schemaVersion: 1,
    episodeId: `ep-${counter}`,
    runId: "run-1",
    taskId: "task-1",
    sessionId: "live-session",
    sequence: counter,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(),
    policyVersion: null,
    worldKey: "world-a",
    targetKey: `t${counter}`,
    features: {
      goalClass: "collect",
      skillId: "minecraft.collect-log",
      band: 2,
      distance: 5,
      distanceBand: "near",
      health: 20,
      hunger: 18,
      vitality: "full",
      threat: "none",
      timeOfDay: "day",
      targetKind: "collect",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: outcome(outcomeOverrides),
    provenance: "live",
    ...rest,
  };
}

test("an action is a success only if it was confirmed and the world did not contradict the confirmation", () => {
  assert.equal(classifyOutcome(outcome()).verdict, "success");
  assert.equal(classifyOutcome(outcome({ verified: null })).verdict, "success", "no observation to check against is not a contradiction");
  // Regression: the learner used to count these as successes while the task runner counted them as failures.
  const contradicted = classifyOutcome(outcome({ verified: false }));
  assert.equal(contradicted.verdict, "failure");
  assert.equal(contradicted.reason, "UNVERIFIED_POSTCONDITION");
  assert.equal(classifyOutcome(outcome({ confirmed: false })).verdict, "failure");
  assert.equal(classifyOutcome(outcome({ confirmed: false })).reason, "ACTION_NOT_CONFIRMED");
});

test("failures that are about the environment or the session are excluded, not charged to the skill", () => {
  const environment: Array<[Partial<EpisodeOutcome>, RegExp]> = [
    [{ status: "failed", confirmed: false, failureCode: "GAME_MODE_BLOCKS_MINING" }, /environment/],
    [{ status: "failed", confirmed: false, failureCode: "UNSUPPORTED_DIMENSION" }, /environment/],
    [{ status: "failed", confirmed: false, failureCode: "REFLEX_INTERRUPT" }, /environment/],
    [{ status: "failed", confirmed: false, failureCode: "ADAPTER_DISCONNECTED" }, /environment/],
    [{ status: "failed", confirmed: false, failureCode: "STALE_OBSERVATION" }, /environment/],
    [{ status: "failed", confirmed: false, failureCode: "CAPABILITY_NOT_AVAILABLE" }, /environment/],
    [{ status: "disconnected", confirmed: false, failureCode: "ADAPTER_DISCONNECTED" }, /session was lost/],
    [{ status: "aborted", confirmed: false, failureCode: "OPERATOR_STOP" }, /interrupted/],
    [{ status: "rejected", confirmed: false, safetyDenied: true, failureCode: "SAFETY_HAZARD_NEARBY" }, /safety policy/],
  ];
  for (const [overrides, reason] of environment) {
    const result = classifyOutcome(outcome(overrides));
    assert.equal(result.verdict, "excluded", JSON.stringify(overrides));
    assert.match(result.reason ?? "", reason);
  }
  // Failures about the attempt itself still count.
  for (const code of ["NAVIGATION_STUCK", "PATH_NOT_FOUND", "DIG_TIMEOUT", "BLOCK_NOT_DIGGABLE", "TOOL_REQUIRED", "INVENTORY_FULL"]) {
    assert.equal(classifyOutcome(outcome({ status: "failed", confirmed: false, failureCode: code })).verdict, "failure", code);
  }
});

test("excluded outcomes never move a success rate, an attempt count or a weight", () => {
  // Ten attempts that failed only because the game mode forbade the action: the old rule made this look like a
  // skill that never works (weight floor, success rate 0). Now it is ten excluded outcomes and no evidence at all.
  const blocked = Array.from({ length: 10 }, () => episode({ outcome: { status: "failed", confirmed: false, verified: null, progress: false, failureCode: "GAME_MODE_BLOCKS_COLLECTION" } }));
  const stats = foldEpisodes(blocked);
  const stat = Object.values(stats)[0]!;
  assert.equal(stat.attempts, 0);
  assert.equal(stat.excluded, 10);
  assert.equal(Object.values(stat.excludedReasons ?? {}).reduce((sum, value) => sum + value, 0), 10);
  assert.deepEqual(derivePolicyWeights(stats).entries, {}, "no weight is derived from non-evidence");

  // Ten genuine failures of the action itself are evidence, and do pull the weight down.
  const genuine = Array.from({ length: 10 }, () => episode({ outcome: { status: "failed", confirmed: false, verified: null, progress: false, failureCode: "NAVIGATION_STUCK" } }));
  const weights = derivePolicyWeights(foldEpisodes(genuine));
  assert.equal(Object.values(weights.entries)[0]?.weight, 0.75);
  assert.equal(Object.values(weights.entries)[0]?.successRate, 0);
});

test("a confirmed-but-contradicted action counts as a failure and as a contradiction, in one place", () => {
  const stat = applyEpisode(emptySkillStat(), episode({ outcome: { verified: false } }));
  assert.equal(stat.attempts, 1);
  assert.equal(stat.successes, 0);
  assert.equal(stat.contradictedConfirmations, 1);
  assert.equal(stat.failureCodes.UNVERIFIED_POSTCONDITION, 1);
});

test("folding can be restricted to the provenances an agent trusts", () => {
  const mixed = [
    ...Array.from({ length: 4 }, () => episode({ provenance: "live" })),
    ...Array.from({ length: 6 }, () => episode({ provenance: "simulator-demo", outcome: { status: "failed", confirmed: false, verified: null, progress: false, failureCode: "NAVIGATION_STUCK" } })),
  ];
  assert.equal(Object.values(foldEpisodes(mixed))[0]?.attempts, 10, "unfiltered: everything counts");
  const live = foldEpisodes(mixed, { provenance: ["live"] });
  assert.equal(Object.values(live)[0]?.attempts, 4);
  assert.equal(Object.values(live)[0]?.successes, 4, "the unsolvable simulator demos cannot drag a live context down");
});

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-evidence-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function recordRun(learner: ExperienceLearner, runId: string, episodes: Episode[]): Promise<void> {
  await learner.load();
  learner.beginRun({ runId, taskId: "t", worldKey: "world-a" });
  for (const entry of episodes) {
    learner.recordEpisode({
      runId,
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      sequence: entry.sequence,
      worldKey: entry.worldKey,
      policyVersion: null,
      targetKey: entry.targetKey,
      features: entry.features,
      provenance: entry.provenance,
      outcome: entry.outcome,
    });
  }
  await learner.finishRun();
}

test("a live learner keeps simulator episodes in the log but does not learn from them, and says so", async () => {
  await withDirectory(async (directory) => {
    const learner = ExperienceLearner.forDirectory(directory, { evidenceProvenance: ["live"] });
    const failing = { status: "failed" as const, confirmed: false, verified: null, progress: false, failureCode: "NAVIGATION_STUCK" };
    await recordRun(learner, "demo-1", Array.from({ length: 10 }, () => episode({ provenance: "simulator-demo", outcome: failing })));
    await recordRun(learner, "live-1", Array.from({ length: 3 }, () => episode({ provenance: "live" })));
    const detail = await learner.detail();
    assert.equal(detail.totals.episodes, 13, "every episode is logged");
    assert.equal(detail.totals.byProvenance["simulator-demo"]?.episodes, 10);
    assert.equal(detail.totals.byProvenance["simulator-demo"]?.usedAsEvidence, false);
    assert.equal(detail.totals.byProvenance.live?.usedAsEvidence, true);
    assert.equal(detail.contexts.reduce((sum, context) => sum + context.attempts, 0), 3, "only the live episodes are evidence");
    assert.equal(learner.candidateWeights.source, "baseline", "three live attempts are below the sample threshold; no weight was invented from the simulator");
    assert.deepEqual(detail.evidenceProvenance, ["live"]);
  });
});

test("a version 1 learning state is migrated by recomputing from the episode log, keeping the policy, history and a backup", async () => {
  await withDirectory(async (directory) => {
    const episodesFile = path.join(directory, "episodes.jsonl");
    const old = [
      // Eight attempts that failed only because of the game mode: version 1 counted them against the skill.
      ...Array.from({ length: 8 }, () => episode({ outcome: { status: "failed", confirmed: false, verified: null, progress: false, failureCode: "GAME_MODE_BLOCKS_COLLECTION" } })),
      episode(),
    ];
    await mkdir(directory, { recursive: true });
    await writeFile(episodesFile, `${old.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const legacyKey = "minecraft.collect-log|collect|near|none|full";
    const legacyState = {
      schemaVersion: 1,
      runs: 2,
      episodes: 9,
      lastRunId: "run-1",
      stats: { [legacyKey]: { attempts: 9, successes: 1, progressCount: 1, contradictedConfirmations: 0, safetyDenials: 0, failureCodes: { GAME_MODE_BLOCKS_COLLECTION: 8 }, ewmaDurationMs: 1, ewmaGain: 1, totalDistance: 1, distanceSamples: 1, lastSequence: 9 } },
      failureMemory: { version: "gamemind-failure-memory-v1", config: {}, entries: [] },
      candidateWeights: { version: "gamemind-policy-weights-v1", id: "learned-1-old", source: "experience", generatedAt: "1970-01-01T00:00:00.000Z", config: {}, entries: { [legacyKey]: { weight: 0.75, samples: 9, evidence: 0, successRate: 0.111 } }, provenance: { episodes: 9, runs: 2, contexts: 1, contradictedConfirmations: 0 } },
      activeWeights: null,
      history: [{ runId: "run-0", at: "2026-01-01T00:00:00.000Z", episodes: 3, promoted: false, note: "an earlier run" }],
    };
    const stateFile = path.join(directory, "state.json");
    await writeFile(stateFile, JSON.stringify(legacyState));

    const learner = ExperienceLearner.forDirectory(directory);
    const state = await learner.load();
    assert.equal(state.schemaVersion, 2);
    const stat = state.stats[legacyKey]!;
    assert.equal(stat.attempts, 1, "the eight mode-blocked outcomes are no longer attempts");
    assert.equal(stat.excluded, 8);
    assert.equal(learner.candidateWeights.source, "baseline", "the 0.75 weight that version 1 derived is gone: it measured the game mode, not the skill");
    assert.equal(state.history[0]?.note, "an earlier run", "history survives the migration");
    assert.equal(state.episodes, 9, "the log still holds every episode");
    const files = await readdir(directory);
    assert.ok(files.includes("state.json.v1.bak"), `the old state is kept as a backup (${files.join(", ")})`);
    assert.equal(JSON.parse(await readFile(path.join(directory, "state.json.v1.bak"), "utf8")).schemaVersion, 1);
    assert.equal((await readFile(episodesFile, "utf8")).trim().split("\n").length, 9, "the episode log was not touched");
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).schemaVersion, 2, "the migrated state is persisted");
  });
});

test("a promoted policy in a version 1 state survives the migration", async () => {
  await withDirectory(async (directory) => {
    const active = { version: "gamemind-policy-weights-v1", id: "learned-promoted", source: "experience", generatedAt: "2026-01-01T00:00:00.000Z", config: {}, entries: { "k|a|b|c|d": { weight: 1.2, samples: 12, evidence: 0.8, successRate: 1 } }, provenance: { episodes: 12, runs: 3, contexts: 1, contradictedConfirmations: 0 } };
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ schemaVersion: 1, runs: 0, episodes: 0, lastRunId: null, stats: {}, failureMemory: { entries: [] }, candidateWeights: active, activeWeights: active, history: [] }));
    const learner = ExperienceLearner.forDirectory(directory);
    await learner.load();
    assert.equal(learner.activeWeights?.id, "learned-promoted");
  });
});

test("state folded from a different set of provenances is rebuilt rather than trusted", async () => {
  await withDirectory(async (directory) => {
    const everything = ExperienceLearner.forDirectory(directory);
    const failing = { status: "failed" as const, confirmed: false, verified: null, progress: false, failureCode: "NAVIGATION_STUCK" };
    await recordRun(everything, "demo-1", Array.from({ length: 9 }, () => episode({ provenance: "simulator-demo", outcome: failing })));
    assert.ok(Object.keys(everything.candidateWeights.entries).length > 0, "the unfiltered learner did weight the simulator failures");

    const live = ExperienceLearner.forDirectory(directory, { evidenceProvenance: ["live"] });
    await live.load();
    assert.deepEqual(Object.keys(live.candidateWeights.entries), [], "the live learner does not inherit statistics folded from the simulator");
    assert.ok((await readdir(directory)).includes("state.json.evidence-filter.bak"));
  });
});

test("an excluded outcome does not make a target a bad target", async () => {
  await withDirectory(async (directory) => {
    const learner = ExperienceLearner.forDirectory(directory);
    const lost = { status: "disconnected" as const, confirmed: false, verified: null, progress: false, failureCode: "ADAPTER_DISCONNECTED" };
    await recordRun(learner, "run-a", [episode({ targetKey: "oak_log@1,64,1", outcome: lost })]);
    assert.equal(learner.snapshot().failureMemory.length, 0, "a dropped connection must not blacklist the tree it happened at");
    const real = { status: "failed" as const, confirmed: false, verified: null, progress: false, failureCode: "NAVIGATION_STUCK" };
    await recordRun(learner, "run-b", [episode({ targetKey: "oak_log@2,64,2", outcome: real })]);
    assert.equal(learner.snapshot().failureMemory.length, 1, "a genuine failure at the target is remembered");
  });
});

test("detail() explains every number the Learning panel shows", async () => {
  await withDirectory(async (directory) => {
    const learner = ExperienceLearner.forDirectory(directory);
    const stuck = { status: "failed" as const, confirmed: false, verified: null, progress: false, failureCode: "NAVIGATION_STUCK" };
    const mode = { status: "failed" as const, confirmed: false, verified: null, progress: false, failureCode: "GAME_MODE_BLOCKS_MINING" };
    await recordRun(learner, "run-1", [
      ...Array.from({ length: 9 }, () => episode({ outcome: stuck })),
      ...Array.from({ length: 4 }, () => episode({ outcome: mode, features: { ...episode().features, skillId: "minecraft.mine-block", goalClass: "mine" } })),
      episode({ outcome: { verified: false } }),
    ]);
    const detail = await learner.detail();
    const collect = detail.contexts.find((context) => context.skillId === "minecraft.collect-log")!;
    assert.equal(collect.attempts, 10);
    assert.equal(collect.successes, 0);
    assert.equal(collect.weightStatus, "learned");
    assert.equal(collect.weight, 0.75);
    assert.equal(collect.contradictedConfirmations, 1);
    assert.equal(collect.topFailures[0]?.code, "NAVIGATION_STUCK");
    const mine = detail.contexts.find((context) => context.skillId === "minecraft.mine-block")!;
    assert.equal(mine.attempts, 0);
    assert.equal(mine.excluded, 4);
    assert.equal(mine.weightStatus, "insufficient-evidence");
    assert.equal(detail.excluded.total, 4);
    assert.ok(Object.keys(detail.excluded.reasons).some((reason) => /GAME_MODE_BLOCKS_MINING/.test(reason)));
    assert.equal(detail.failures[0]?.code, "NAVIGATION_STUCK");
    assert.equal(detail.failures[0]?.kind, "action");
    assert.equal(detail.contradictions.total, 1);
    assert.equal(detail.policy.influencesDecisions, "none", "an unpromoted candidate steers nothing");
    assert.equal(detail.policy.activeId, null);
    assert.equal(detail.recentRuns[0]?.runId, "run-1");
    assert.equal(detail.recentRuns[0]?.excluded, 4);
  });
});
