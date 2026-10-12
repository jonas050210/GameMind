import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseTrainingArgs } from "../src/training/cli.js";
import { trainingSeed, type CurriculumStage } from "../src/training/curriculum.js";
import { readTrainingState, trainingPaths, writeControlCommand } from "../src/training/state.js";
import { runTraining, type EpisodeRunner } from "../src/training/trainer.js";
import type { EvaluationRun } from "../src/testing/eval/harness.js";

/**
 * Headless training is the offline simulator in its own process. These tests check what it actually does:
 * its budgets, its persisted progress, and that its code path does not load the Minecraft client, live adapter,
 * Control Center or browser view.
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
    actionFailures: [],
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
