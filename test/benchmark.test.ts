/**
 * Headless training benchmark: the winner rule is pure and tested directly; one small end-to-end run writes its report
 * into a temporary directory, so the repository's data folder is never touched.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEnvironmentCases, chooseBenchmarkWinner, runBenchmark, scoreEnvironmentStages, ENVIRONMENT_PROBE_SEED_BASE, type BenchmarkEntry, type EnvironmentProbeCase } from "../src/training/benchmark.js";
import { evaluationSeeds } from "../src/testing/eval/harness.js";
import { TRAINING_STAGES } from "../src/training/curriculum.js";

function entry(id: string, rate: number, trained: number, baseline: number, verdict: string, status: "completed" | "failed" = "completed"): BenchmarkEntry {
  return {
    candidate: { id, explorationRate: rate },
    status,
    error: status === "failed" ? "boom" : null,
    experiment:
      status === "completed"
        ? {
            directory: `data/experiments/${id}`,
            episodes: 10,
            explorations: 0,
            wallSeconds: 1,
            baselineSuccess: baseline,
            trainedSuccess: trained,
            deltaPoints: Math.round((trained - baseline) * 1000) / 1000,
            gateVerdict: verdict,
          }
        : null,
  };
}


test("environment cases interleave selected stages and scenarios with disjoint deterministic training seed blocks", () => {
  const stages = TRAINING_STAGES.slice(0, 2);
  const cases = buildEnvironmentCases(stages, 256);
  const selectedScenarioIds = new Set(stages.flatMap((stage) => stage.scenarioIds));
  assert.equal(cases.length, 256);
  assert.ok(cases.every((item) => selectedScenarioIds.has(item.scenarioId)));
  assert.deepEqual(cases.slice(0, 2).map((item) => item.index), [1, 2]);
  assert.deepEqual(cases.slice(0, stages.length).map((item) => item.stageId), stages.map((stage) => stage.id));
  assert.ok(cases.every((item, index) => item.seedBase === ENVIRONMENT_PROBE_SEED_BASE + index * 100_001));
  const heldOut = new Set(evaluationSeeds(200));
  assert.ok(cases.every((item) => !heldOut.has(item.seedBase)), "environment probe seeds are not evaluation seeds");
});

test("environment sweep recommends the measured top stage, but falls back when no learning trend was measured", () => {
  const sample = (index: number, stageId: string, signal: number): EnvironmentProbeCase => ({
    index,
    stageId,
    scenarioId: "scenario",
    seedBase: ENVIRONMENT_PROBE_SEED_BASE + index * 100_001,
    workers: 1,
    status: "completed",
    error: null,
    episodes: 8,
    successes: 4,
    explorations: 2,
    wallSeconds: 20,
    episodesPerMinute: 24,
    rewardFirstQuartileMean: 0,
    rewardLastQuartileMean: signal * 6,
    successFirstQuartile: 0.25,
    successLastQuartile: signal + 0.25,
    learningSignal: signal,
  });
  const result = scoreEnvironmentStages([sample(1, "basics", 0.8), sample(2, "food", 0.1)], ["basics", "food"]);
  assert.deepEqual(result.recommendedStageIds, ["basics"]);
  assert.equal(result.scores[0]?.recommended, true);
  assert.equal(result.scores[1]?.recommended, false);
  const fallback = scoreEnvironmentStages([], ["basics", "food"]);
  assert.deepEqual(fallback.recommendedStageIds, ["basics", "food"]);

  const partial = scoreEnvironmentStages([sample(1, "basics", 0.8)], ["basics", "food"]);
  assert.deepEqual(partial.recommendedStageIds, ["basics", "food"], "a stage with no reliable measurement is retained");
  assert.equal(partial.scores.find((score) => score.stageId === "food")?.recommended, true);
});

test("the best promotable candidate above the margin wins", () => {
  const result = chooseBenchmarkWinner(
    [
      entry("explore-0", 0, 0.7, 0.7, "not-promotable"),
      entry("explore-0_05", 0.05, 0.8, 0.7, "promotable"),
      entry("explore-0_15", 0.15, 0.85, 0.7, "promotable"),
      entry("explore-0_3", 0.3, 0.9, 0.7, "not-promotable"),
    ],
    0.02,
  );
  assert.equal(result.winner, "explore-0_15", "0.85 is the best promotable result; the 0.9 failed the gate");
});

test("a candidate that does not beat the baseline by the margin is not promoted, even if it is the best number", () => {
  const result = chooseBenchmarkWinner([entry("a", 0, 0.715, 0.7, "promotable"), entry("b", 0.1, 0.71, 0.7, "promotable")], 0.02);
  assert.equal(result.winner, null);
  assert.match(result.decision, /baseline stays the default/);
});

test("ties go to the lower exploration rate, the simpler choice", () => {
  const result = chooseBenchmarkWinner([entry("hi", 0.3, 0.9, 0.7, "promotable"), entry("lo", 0.05, 0.9, 0.7, "promotable")], 0.02);
  assert.equal(result.winner, "lo");
});

test("failed candidates are never chosen, and do not hide the others", () => {
  const result = chooseBenchmarkWinner(
    [entry("broken", 0.1, 0.99, 0.7, "promotable", "failed"), entry("ok", 0.2, 0.8, 0.7, "promotable")],
    0.02,
  );
  assert.equal(result.winner, "ok");
});

test("a benchmark runs every candidate under one budget and writes a report, never overwriting it", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "gamemind-benchmark-"));
  try {
    const report = await runBenchmark({
      name: "smoke",
      outDir,
      candidates: [
        { id: "greedy", explorationRate: 0 },
        { id: "explore", explorationRate: 0.2 },
      ],
      episodesPerStage: 2,
      maxEpisodes: 4,
      evaluationSeeds: 2,
      margin: 0.02,
      environmentCases: 1,
      environmentSecondsPerCase: 0.1,
    });
    assert.equal(report.entries.length, 2);
    assert.equal(report.environmentProbe.length, 1);
    assert.equal(report.environmentProbe[0]?.stageId, "basics");
    assert.ok(report.recommendedStageIds.length > 0);
    assert.ok(report.entries.every((item) => item.status === "completed" || item.error !== null));
    const written = JSON.parse(await readFile(join(outDir, "benchmarks", "smoke.json"), "utf8")) as { winner: string | null };
    assert.equal(written.winner, report.winner);
    await assert.rejects(
      () => runBenchmark({ name: "smoke", outDir, candidates: [{ id: "a", explorationRate: 0 }, { id: "b", explorationRate: 0.1 }], episodesPerStage: 2, maxEpisodes: 4, evaluationSeeds: 2, margin: 0.02, environmentCases: 1, environmentSecondsPerCase: 0.1 }),
      /already exists/,
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("invalid input is refused before anything is trained", async () => {
  await assert.rejects(() => runBenchmark({ name: "x", candidates: [{ id: "only", explorationRate: 0 }], episodesPerStage: 2, maxEpisodes: 4, evaluationSeeds: 2, margin: 0.02, environmentCases: 1 }), /at least two/);
  await assert.rejects(() => runBenchmark({ name: "../escape", candidates: [{ id: "a", explorationRate: 0 }, { id: "b", explorationRate: 0 }], episodesPerStage: 2, maxEpisodes: 4, evaluationSeeds: 2, margin: 0.02, environmentCases: 1 }), /letters, digits/);
  await assert.rejects(() => runBenchmark({ name: "ok", candidates: [{ id: "a", explorationRate: 2 }, { id: "b", explorationRate: 0 }], episodesPerStage: 2, maxEpisodes: 4, evaluationSeeds: 2, margin: 0.02, environmentCases: 1 }), /between 0 and 1/);
  await assert.rejects(() => runBenchmark({ name: "too-many", candidates: [{ id: "a", explorationRate: 0 }, { id: "b", explorationRate: 0.1 }], episodesPerStage: 2, maxEpisodes: 4, evaluationSeeds: 2, margin: 0.02, environmentCases: 257 }), /1 through 256/);
});
