/** Starting the exploration-rate benchmark from the Control Center: a fixed command, validated name, no overwrite. */
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
    assert.deepEqual(plan.args.slice(-4), ["--name", "rates-1", "--out", path.join(data, "experiments")]);
    assert.equal(plan.cwd, root);
    assert.match(plan.display, /benchmark-cli\.ts --name rates-1/);
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
