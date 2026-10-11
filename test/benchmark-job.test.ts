/** Starting a headless environment/worker benchmark from the Control Center: fixed args, validated settings, no overwrite. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JobPlanError, planBenchmark } from "../src/app/job-plans.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the plan runs the CLI with a fixed argument list, into the data folder the Training tab reads", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "gm-benchjob-"));
  try {
    const plan = planBenchmark({ root, dataDirectory: data }, { name: "rates-1", now: new Date("2026-10-10T10:00:00Z") });
    assert.equal(plan.kind, "benchmark");
    assert.ok(plan.args.includes("src/training/benchmark-cli.ts") || plan.args.some((arg) => arg.endsWith("benchmark-cli.ts")));
    assert.ok(plan.args.includes("--environment-cases"));
    assert.ok(plan.args.includes("--environment-seconds"));
    assert.ok(plan.args.includes("--probe-workers"));
    assert.ok(plan.args.includes("--stages"));
    assert.deepEqual(plan.args.slice(2, 8), ["--name", "rates-1", "--out", path.join(data, "experiments"), "--defaults-file", path.join(data, "training-defaults.json")]);
    assert.equal((plan.meta as { environmentCases: number }).environmentCases, 13);
    assert.ok(plan.timeoutMs >= 6 * 60 * 60_000);
    assert.equal(plan.cwd, root);
    assert.match(plan.display, /benchmark-cli\.ts --name rates-1/);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});


test("the manual plan forwards selected stages, supports the 256-case ceiling, and rejects invalid tuning settings", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "gm-benchjob-"));
  try {
    const plan = planBenchmark({ root, dataDirectory: data }, {
      name: "full-sweep",
      environmentCases: 256,
      environmentSecondsPerCase: 20,
      workerLimit: 8,
      stageIds: ["basics", "food"],
    });
    const valueAfter = (flag: string) => plan.args[plan.args.indexOf(flag) + 1];
    assert.equal(valueAfter("--environment-cases"), "256");
    assert.equal(valueAfter("--environment-seconds"), "20");
    assert.equal(valueAfter("--probe-workers"), "1,2,3,4,5,6,7,8");
    assert.equal(valueAfter("--stages"), "basics,food");
    const longSweep = planBenchmark({ root, dataDirectory: data }, { environmentCases: 256, environmentSecondsPerCase: 600 });
    assert.ok(longSweep.timeoutMs >= 256 * 600_000 + 4 * 60 * 60_000, "a valid long probe is not killed by a shorter fixed timeout");
    assert.throws(() => planBenchmark({ root, dataDirectory: data }, { environmentCases: 257 }), /1 through 256/);
    assert.throws(() => planBenchmark({ root, dataDirectory: data }, { environmentSecondsPerCase: 0 }), /1 through 600/);
    assert.throws(() => planBenchmark({ root, dataDirectory: data }, { workerLimit: 9 }), /1 through 8/);
    assert.throws(() => planBenchmark({ root, dataDirectory: data }, { stageIds: ["not-a-stage"] }), /selection is invalid/);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("without a name a timestamped one is chosen", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "gm-benchjob-"));
  try {
    const plan = planBenchmark({ root, dataDirectory: data }, { now: new Date("2026-10-10T10:20:30Z") });
    assert.equal(plan.meta && (plan.meta as { name: string }).name, "gui-20261010-102030");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a name with path characters is refused, and so is a name that already has a report", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "gm-benchjob-"));
  try {
    assert.throws(() => planBenchmark({ root, dataDirectory: data }, { name: "../escape" }), (error: unknown) => error instanceof JobPlanError && error.code === "INVALID_OPTION");
    await mkdir(path.join(data, "experiments", "benchmarks"), { recursive: true });
    await writeFile(path.join(data, "experiments", "benchmarks", "taken.json"), "{}");
    assert.throws(() => planBenchmark({ root, dataDirectory: data }, { name: "taken" }), /already exists/);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
