import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseTrainingArgs } from "../src/training/cli.js";
import { TrainingManager } from "../src/training/manager.js";
import { trainingSeed, type CurriculumStage } from "../src/training/curriculum.js";
import { readTrainingState, trainingPaths, writeControlCommand } from "../src/training/state.js";
import { runTraining, type EpisodeRunner } from "../src/training/trainer.js";
import type { EvaluationRun } from "../src/testing/eval/harness.js";

/**
 * Headless training is the offline simulator in its own process. These tests check what it actually does:
 * its budgets, its persisted progress, what the Control Center reports about it, and that its code path does
 * not load the Minecraft client, the live adapter, the Control Center, or the browser view.
 */

const STAGES: CurriculumStage[] = [
  { id: "a", label: "a", scenarioIds: ["explore-remote-log"], minEpisodes: 2, passRate: 0.5 },
  { id: "b", label: "b", scenarioIds: ["food-remote-berries"], minEpisodes: 2, passRate: 0.5 },
];

function run(success: boolean): EvaluationRun {
  return {
    scenarioId: "fake",
    seed: 0,
    status: success ? "succeeded" : "failed",
    success,
    safe: true,
    died: false,
    simulatedMs: 4_000,
    metrics: { actions: 4, wastedActions: success ? 0 : 2, unsafeActions: 0, unverifiedConfirmations: 0, progressEvents: success ? 1 : 0 } as unknown as EvaluationRun["metrics"],
    worldStats: { damageTaken: 0, minHealth: 20, starvationTicks: 0 },
    actionGoals: [],
    actionChoices: [],
    failureCode: success ? null : "CONSECUTIVE_ACTION_FAILURES",
  };
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gamemind-headless-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("time budget: training stops after the episode that crosses it, keeps its checkpoint, and says why", async () => {
  await withRoot(async (root) => {
    const slow: EpisodeRunner = async () => {
      await sleep(60);
      return run(false);
    };
    // 0.5 ms is far below one 40 ms episode, so the budget is crossed on the first episode.
    const state = await runTraining({ root, stages: STAGES, maxEpisodes: 50, maxMinutes: 0.0005, episodeRunner: slow });
    assert.equal(state.totalEpisodes, 1, "the budget is checked between episodes, so the crossing episode completes");
    assert.ok(state.activeMs >= 50, `active time counts the episode (${state.activeMs} ms)`);
    assert.equal(state.status, "completed");
    assert.match(state.stopReason ?? "", /Time budget of 0\.0005 min reached/);
    assert.ok(state.checkpoints.length >= 1, "a partial checkpoint is written when a budget ends the run");
  });
});

test("active time excludes pauses: a 300 ms pause adds almost nothing to the recorded active time", async () => {
  await withRoot(async (root) => {
    const paths = trainingPaths(root);
    let paused = false;
    const runner: EpisodeRunner = async (_scenario, seed) => {
      if (seed === trainingSeed(0) && !paused) {
        paused = true;
        await writeControlCommand(paths, "pause");
        setTimeout(() => void writeControlCommand(paths, "run"), 300);
      }
      return run(false);
    };
    const started = Date.now();
    const state = await runTraining({ root, stages: STAGES, maxEpisodes: 2, episodeRunner: runner, pollMs: 20 });
    const wall = Date.now() - started;
    assert.equal(state.totalEpisodes, 2);
    assert.ok(wall >= 300, `the run waited through the pause (${wall} ms wall clock)`);
    assert.ok(state.activeMs < 150, `active time ${state.activeMs.toFixed(1)} ms does not include the pause`);
  });
});

test("resume keeps saved progress and accumulated active time, and a time budget survives the restart", async () => {
  await withRoot(async (root) => {
    const first = await runTraining({ root, stages: STAGES, maxEpisodes: 1, maxMinutes: 60, episodeRunner: async () => run(false) });
    assert.equal(first.totalEpisodes, 1);
    const activeAfterFirst = first.activeMs;
    const second = await runTraining({ root, stages: STAGES, maxEpisodes: 3, episodeRunner: async () => run(false) });
    assert.equal(second.totalEpisodes, 3, "the second run continues the count instead of starting over");
    assert.ok(second.activeMs >= activeAfterFirst, "active time only grows across restarts");
    assert.equal(second.maxMinutes, 60, "the time budget is kept on resume unless it is changed");
    const persisted = await readTrainingState(trainingPaths(root));
    assert.equal(persisted?.totalEpisodes, 3);
    assert.equal(persisted?.stopReason, "Episode budget of 3 reached.");
  });
});

test("the Control Center view reports real state: execution, no rendering, throughput and reward trend", async () => {
  await withRoot(async (root) => {
    const rewardRunner: EpisodeRunner = async () => run(false);
    await runTraining({ root, stages: STAGES, maxEpisodes: 3, episodeRunner: rewardRunner, maxMinutes: 30 });
    const view = await new TrainingManager({ root }).snapshot();
    assert.equal(view.execution, "offline-simulator");
    assert.equal(view.render, "none");
    assert.equal(view.maxMinutes, 30);
    assert.equal(view.episodesTotal, 3);
    assert.ok(view.activeSeconds >= 0);
    assert.ok(view.episodesPerMinute === null || view.episodesPerMinute > 0);
    assert.equal(view.rewardTrend.length, 3, "one trend entry per saved episode");
    assert.ok(view.rewardTrend.every((value) => value === null), "episodes without a learner reward are gaps, not zeros");
    assert.equal(view.stopReason, "Episode budget of 3 reached.");
  });
});

test("the Control Center view is empty and honest before any training has run", async () => {
  await withRoot(async (root) => {
    const view = await new TrainingManager({ root: join(root, "none") }).snapshot();
    assert.equal(view.status, "idle");
    assert.equal(view.episodesPerMinute, null, "no active time, so no throughput");
    assert.deepEqual(view.rewardTrend, []);
    assert.equal(view.stopReason, null);
    assert.equal(view.lastError, null);
  });
});

test("start options from the browser are validated before any child process is spawned", async () => {
  await withRoot(async (root) => {
    const manager = new TrainingManager({ root, entry: "/nonexistent-entry-should-not-run.ts" });
    for (const options of [{ maxMinutes: 0 }, { maxMinutes: 1.5 }, { maxMinutes: 100_000 }, { episodesPerStage: 0 }, { maxEpisodes: 6_000 }]) {
      const result = await manager.start(options);
      assert.equal(result.ok, false, `refused ${JSON.stringify(options)}`);
      assert.match(result.message, /whole number/);
    }
    assert.equal((await readTrainingState(trainingPaths(root)).catch(() => null)), null, "nothing was written or started");
  });
});

test("CLI: --max-minutes is parsed and checked like the other budgets", () => {
  const parsed = parseTrainingArgs(["train", "--max-minutes", "15", "--max-episodes", "40"]);
  assert.equal(parsed.maxMinutes, 15);
  assert.equal(parsed.maxEpisodes, 40);
  assert.throws(() => parseTrainingArgs(["train", "--max-minutes", "0"]), /must be an integer/);
  assert.throws(() => parseTrainingArgs(["train", "--max-minutes"]), /needs a value/);
});

test("separation: the training code path never loads the Minecraft client, the live adapter, the Control Center, or the browser view", async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const seen = new Set<string>();
  const queue = [join(sourceRoot, "training", "cli.ts")];
  const importPattern = /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm;
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
        queue.push(target);
      } else {
        assert.ok(!/mineflayer|prismarine/.test(specifier), `training imports the Minecraft client library: ${specifier}`);
      }
    }
  }
  // `path.resolve`/`path.join` use backslashes on Windows; compare module names with one stable separator.
  const relative = [...seen].map((file) => file.slice(sourceRoot.length + 1).replaceAll("\\", "/"));
  for (const forbidden of [
    "control-center/",
    "minecraft-adapter",
    "run-control",
    "attach-control-center",
    "roadmap/",
    "world-view",
    "games/minecraft/minecraft",
  ]) {
    assert.equal(
      relative.find((file) => file.includes(forbidden)),
      undefined,
      `the training process must not load ${forbidden}`,
    );
  }
  assert.ok(relative.includes("training/trainer.ts"), "the walk reached the trainer");
});

async function waitFor<T>(read: () => Promise<T | null | undefined>, ms = 8000): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  return null;
}

test("a trainer that crashes at start-up is reported with its exit code and log, never shown as idle", async () => {
  await withRoot(async (root) => {
    const entry = join(root, "crash.mjs");
    await writeFile(entry, "console.error('boom: the trainer could not read its data');\nprocess.exit(3);\n");
    const manager = new TrainingManager({ root, entry });
    const started = await manager.start({});
    assert.equal(started.ok, true, "the start request is accepted; the failure comes from the process");
    const view = await waitFor(async () => {
      const current = await manager.snapshot();
      return current.lastError ? current : null;
    });
    assert.ok(view, "the failure appears in the snapshot");
    assert.match(view!.lastError ?? "", /exit code 3/);
    assert.match(view!.lastError ?? "", /boom: the trainer could not read its data/);
    assert.equal(view!.processAlive, false);
  });
});

test("a killed trainer's error excerpt holds only its own log lines, not an earlier run's", async () => {
  await withRoot(async (root) => {
    const paths = trainingPaths(root);
    await mkdir(dirname(paths.log), { recursive: true });
    await writeFile(paths.log, "OLD RUN: the previous trainer finished\n");
    const entry = join(root, "killed.mjs");
    await writeFile(entry, "console.log('NEW RUN: started');\nprocess.kill(process.pid, 'SIGKILL');\n");
    const manager = new TrainingManager({ root, entry });
    assert.equal((await manager.start({})).ok, true);
    const view = await waitFor(async () => {
      const current = await manager.snapshot();
      return current.lastError ? current : null;
    });
    assert.ok(view, "the kill appears in the snapshot");
    assert.match(view!.lastError ?? "", /signal SIGKILL/);
    assert.match(view!.lastError ?? "", /NEW RUN: started/);
    assert.doesNotMatch(view!.lastError ?? "", /OLD RUN/, "lines from an earlier run are not blamed on this one");
  });
});

test("the trainer loads its TypeScript loader from this package, so it starts from any working directory", async () => {
  await withRoot(async (root) => {
    const entry = join(root, "ok.ts");
    await writeFile(entry, "console.log('trainer entry reached');\n");
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const previous = process.cwd();
    process.chdir(elsewhere);
    try {
      const manager = new TrainingManager({ root: join(root, "data"), entry });
      await manager.start({});
      const logFile = trainingPaths(join(root, "data")).log;
      const log = await waitFor(async () => {
        const text = await readFile(logFile, "utf8").catch(() => "");
        return text.includes("trainer entry reached") || text.includes("Error") ? text : null;
      });
      assert.ok(log, "the child wrote to its log");
      assert.match(log!, /trainer entry reached/, "the TypeScript entry ran");
      assert.doesNotMatch(log!, /Cannot find package 'tsx'/, "the loader was not looked up in the working directory");
      await sleep(200);
      assert.equal((await manager.snapshot()).lastError, null, "a clean exit is not an error");
    } finally {
      process.chdir(previous);
    }
  });
});
