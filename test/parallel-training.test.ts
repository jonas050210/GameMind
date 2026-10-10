/**
 * Parallel training: several episodes at once, one learner. These tests check the contract: results are replayed in
 * job order, the persisted log has exactly one run per episode, a dead worker is replaced and its job retried once,
 * and a process pool really runs jobs in other processes.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runEvaluationOnce } from "../src/testing/eval/harness.js";
import { createEpisodePool, createInProcessEpisodePool, createProcessEpisodePool, WorkerCrashed, type WorkerTransport } from "../src/training/episode-pool.js";
import { trainingSeed, type CurriculumStage } from "../src/training/curriculum.js";
import type { EpisodeJob, EpisodeJobResult, JobSync } from "../src/training/episode-job.js";
import { runTraining } from "../src/training/trainer.js";
import { probeWorkerCounts } from "../src/training/throughput-probe.js";
import { trainingPaths } from "../src/training/state.js";

const STAGES: CurriculumStage[] = [
  { id: "a", label: "a", scenarioIds: ["explore-remote-log"], minEpisodes: 2, passRate: 0.5 },
  { id: "b", label: "b", scenarioIds: ["food-remote-berries"], minEpisodes: 2, passRate: 0.5 },
];

function jobsFor(first: number, count: number, stageId = "a", scenarioId = "explore-remote-log"): EpisodeJob[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = first + offset;
    const seed = trainingSeed(index);
    return { index, stageId, scenarioId, seed, worldKey: `train:${scenarioId}:${seed}`, runId: `train-${String(index).padStart(6, "0")}`, explorationRate: 0 };
  });
}

test("in-process workers run a batch in job order and return one result per job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "par-batch-"));
  try {
    const pool = createInProcessEpisodePool({ workers: 2, context: { stages: STAGES, experienceDirectory: join(dir, "experience"), runner: runEvaluationOnce } });
    const first = await pool.runBatch(jobsFor(0, 2));
    assert.deepEqual(first.map((result) => result.index), [0, 1]);
    const second = await pool.runBatch(jobsFor(2, 2));
    assert.deepEqual(second.map((result) => result.index), [2, 3]);
    assert.equal(pool.stats().episodes, 4);
    assert.ok(second.every((result) => result.capture.finished), "each episode closes its run, as a sequential run does");
    await pool.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a batch larger than the pool is refused", async () => {
  const pool = createInProcessEpisodePool({ workers: 1, context: { stages: STAGES, experienceDirectory: "/nonexistent", runner: runEvaluationOnce } });
  await assert.rejects(() => pool.runBatch(jobsFor(0, 2)), /at most 1 jobs/);
  await pool.close();
});

test("a worker that dies is replaced and its job is retried once", async () => {
  const seen: { slot: number; bootstrap: boolean; pending: number }[] = [];
  let crashOnce = true;
  const transport: WorkerTransport = {
    size: 2,
    run: async (slot: number, job: EpisodeJob, sync: JobSync): Promise<EpisodeJobResult> => {
      seen.push({ slot, bootstrap: sync.bootstrap, pending: sync.pending.length });
      if (slot === 0 && crashOnce) {
        crashOnce = false;
        throw new WorkerCrashed("worker died");
      }
      return fakeResult(job.index);
    },
    replace: () => undefined,
    close: async () => undefined,
  };
  const pool = createEpisodePool(transport);
  const results = await pool.runBatch(jobsFor(0, 2));
  assert.deepEqual(results.map((result) => result.index), [0, 1]);
  assert.equal(pool.stats().respawns, 1);
  // The replacement starts from the episode log, so it bootstraps again.
  assert.equal(seen.filter((entry) => entry.slot === 0)[1]?.bootstrap, true);
  // The second batch sends slot 1 the first batch's captures it has not seen (slot 0's), but not its own.
  await pool.runBatch(jobsFor(2, 2));
  const slotOneSecond = seen.filter((entry) => entry.slot === 1)[1];
  assert.equal(slotOneSecond?.bootstrap, false);
  assert.equal(slotOneSecond?.pending, 1);
});

test("an episode that fails with an error is reported, not retried", async () => {
  let calls = 0;
  const transport: WorkerTransport = {
    size: 1,
    run: async () => {
      calls += 1;
      throw new Error("scenario broke");
    },
    replace: () => undefined,
    close: async () => undefined,
  };
  const pool = createEpisodePool(transport);
  await assert.rejects(() => pool.runBatch(jobsFor(0, 1)), /scenario broke/);
  assert.equal(calls, 1);
});

test("a process pool runs real episodes in separate processes and closes them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "par-proc-"));
  try {
    const pool = createProcessEpisodePool({ workers: 2, stages: STAGES, experienceDirectory: join(dir, "experience") });
    try {
      const results = await pool.runBatch(jobsFor(0, 2));
      assert.equal(results.length, 2);
      const pids = [...new Set(results.map((result) => result.telemetry.pid))];
      assert.equal(pids.length, 2, "two jobs ran in two worker processes");
      assert.ok(pids.every((pid) => pid !== process.pid), "not in the trainer process");
    } finally {
      await pool.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a parallel training run completes, keeps one experience run per episode, and reports throughput", async () => {
  const root = await mkdtemp(join(tmpdir(), "par-train-"));
  try {
    const events: number[] = [];
    const state = await runTraining({
      root,
      stages: STAGES,
      workers: 2,
      maxEpisodes: 6,
      episodesPerStage: 3,
      explorationRate: 0,
      onEpisode: (event) => events.push(event.record.index),
    });
    assert.equal(state.status, "completed");
    assert.equal(state.totalEpisodes, 6);
    assert.deepEqual(events, [0, 1, 2, 3, 4, 5], "episodes are reported in order");
    assert.ok(state.parallel, "parallel run reports its throughput");
    assert.equal(state.parallel!.workers, 2);
    assert.ok(state.parallel!.episodesPerMinute > 0);
    const log = (await readFile(trainingPaths(root).experience + "/episodes.jsonl", "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { runId: string });
    const runIds = new Set(log.map((line) => line.runId));
    assert.equal(runIds.size, 6, "one learning run per episode, none lost or duplicated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel workers cannot run a custom episode runner, and the error says so", async () => {
  const root = await mkdtemp(join(tmpdir(), "par-custom-"));
  try {
    const fake = async () => {
      throw new Error("should not be called");
    };
    await assert.rejects(
      () => runTraining({ root, stages: STAGES, workers: 2, maxEpisodes: 2, episodeRunner: fake as never }),
      /custom episode runner can only run with one worker/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the throughput probe measures each worker count over the same timed window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "par-probe-"));
  try {
    const results = await probeWorkerCounts({ workerCounts: [1, 2], seconds: 3, warmupSeconds: 1, workDir: dir, stages: STAGES });
    assert.deepEqual(results.map((result) => result.workers), [1, 2]);
    for (const result of results) {
      assert.equal(result.status, "measured", result.error ?? "");
      assert.ok(result.episodesMeasured > 0, "episodes were measured");
      assert.ok(result.episodesPerMinute > 0);
      assert.ok(result.eligible, result.reason);
    }
    assert.equal(results[1]!.respawns, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeResult(index: number): EpisodeJobResult {
  return {
    index,
    run: {
      scenarioId: "explore-remote-log",
      seed: 0,
      status: "succeeded",
      success: true,
      safe: true,
      died: false,
      simulatedMs: 1000,
      metrics: { actions: 1, wastedActions: 0 } as never,
      worldStats: { damageTaken: 0, minHealth: 20, starvationTicks: 0 },
      actionGoals: [],
      actionChoices: [],
      failureCode: null,
    } as never,
    reward: 1,
    capture: { runContext: null, drafts: [], finished: false, finishReport: null },
    telemetry: { pid: process.pid, rssMb: 1, cpuMs: 1, wallMs: 1 },
  };
}
