/**
 * What a finished task prints on stdout. The report is read by scripts and by the operator who started the run, so its
 * shape is a contract: the offline simulator's clock and world statistics stay where the original CLI put them, a live
 * report never carries simulated fields, and a detail that is not known is left out instead of being invented.
 * Everything here runs against the simulated world; none of it says anything about a live Minecraft server.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GameMindApp } from "../src/app/app.js";
import { runCommandLine, type RunAppRequest } from "../src/app/run-app.js";
import { liveTaskReport, simulatedTaskReport, type ReportDetails, type ReportSource, type SimulatedReportScenario } from "../src/app/task-report.js";
import type { MinecraftTaskResult } from "../src/games/minecraft/task-runner.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { captureLogger, fakeTaskResult, waitFor } from "./support/lifecycle-fixture.js";
import { createSessionFixture } from "./support/session-fixture.js";

const SCENARIO: SimulatedReportScenario = {
  id: "explore-remote-log",
  seed: 101,
  description: "The only oak tree lies outside the scan; the agent must explore to find it.",
  expectation: "success",
  demo: false,
};
const DETAILS: ReportDetails = { simulatedElapsedMs: 9_600, worldStats: { damageTaken: 0, minHealth: 20, starvationTicks: 0 } };

function scenarioTask(id: string) {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === id);
  assert.ok(scenario, `scenario ${id}`);
  return scenario.task();
}

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-report-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("regression: the simulated report keeps the clock and the world statistics, in the place the original CLI printed them", () => {
  const result = fakeTaskResult(scenarioTask("explore-remote-log"));
  const report = simulatedTaskReport(SCENARIO, result, "cli", DETAILS);
  assert.deepEqual(Object.keys(report), [
    "type", "simulatedWorld", "startedBy", "scenarioId", "seed", "description", "expectation",
    "simulatedElapsedMs", "worldStats",
    "taskId", "status", "failure", "metrics", "actions", "finalObservation", "learning",
  ]);
  assert.equal(report.type, "sim-task-report");
  assert.equal(report.simulatedWorld, true, "an offline report always says it is offline");
  assert.equal(report.simulatedElapsedMs, 9_600);
  assert.deepEqual(report.worldStats, { damageTaken: 0, minHealth: 20, starvationTicks: 0 });

  const demo = simulatedTaskReport({ ...SCENARIO, demo: true }, result, "cli", DETAILS);
  assert.deepEqual(Object.keys(demo).slice(6, 10), ["expectation", "offlineDemo", "simulatedElapsedMs", "worldStats"]);
  assert.equal(demo.offlineDemo, true);
  assert.equal("offlineDemo" in report, false, "a plain scenario run is not labelled a demo");
});

test("a detail that is not known is left out of the report, never replaced by a default that reads like a measurement", () => {
  const report = simulatedTaskReport(SCENARIO, fakeTaskResult(scenarioTask("explore-remote-log")), "control-center");
  assert.equal("simulatedElapsedMs" in report, false);
  assert.equal("worldStats" in report, false);
  assert.equal(report.simulatedWorld, true, "it is still labelled as an offline run");
  assert.equal(report.startedBy, "control-center");
});

test("a live report carries no simulated fields, and a failed task carries the classification the dashboard shows", () => {
  const task = scenarioTask("explore-remote-log");
  const live = liveTaskReport(fakeTaskResult(task), "cli");
  assert.equal(live.type, "task-report");
  assert.equal(live.startedBy, "cli");
  for (const field of ["simulatedWorld", "simulatedElapsedMs", "worldStats", "offlineDemo", "classification"]) {
    assert.equal(field in live, false, `a successful live report has no ${field}`);
  }
  const failed = liveTaskReport(fakeTaskResult(task, "failed"), "control-center") as { classification?: { status: string; kind: string; label: string } };
  assert.equal(failed.classification?.status, "failed");
  assert.equal(typeof failed.classification?.kind, "string");
  assert.equal(typeof failed.classification?.label, "string");
});

test("a session hands out its world's report details, none for a world without any, and never throws", async () => {
  const withDetails = await createSessionFixture();
  try {
    const details = withDetails.session.reportDetails();
    assert.equal(typeof details.simulatedElapsedMs, "number", "the simulator reports its clock");
    assert.deepEqual(Object.keys(details.worldStats as object), ["damageTaken", "minHealth", "starvationTicks"]);
  } finally {
    await withDetails.close();
  }

  const without = await createSessionFixture({ tweakResources: ({ reportDetails: _dropped, ...rest }) => rest });
  try {
    assert.deepEqual(without.session.reportDetails(), {}, "a world with no details gives none, not invented ones");
  } finally {
    await without.close();
  }

  const failing = await createSessionFixture({
    tweakResources: (resources) => ({
      ...resources,
      reportDetails: () => {
        throw new Error("statistics unavailable");
      },
    }),
  });
  try {
    assert.deepEqual(failing.session.reportDetails(), {}, "a provider that fails costs the report its extras, not the report");
    assert.match(failing.logs.text(), /could not gather the world's details/);
  } finally {
    await failing.close();
  }
});

interface Captured {
  readonly result: MinecraftTaskResult;
  readonly source: ReportSource;
  readonly details: ReportDetails | undefined;
}

/** The run `python3 main.py --simulated` performs, with the report captured instead of printed. */
function simulatedRun(directory: string, reports: Captured[], overrides: Partial<RunAppRequest> = {}): RunAppRequest {
  return {
    root: directory,
    dataDirectory: path.join(directory, "data"),
    logger: captureLogger("error").logger,
    version: "0.0.0-test",
    mode: "one-shot",
    controlCenter: false,
    bind: { host: "127.0.0.1", port: 0 },
    connect: { source: "simulated", scenarioId: "explore-remote-log", seed: 101, autonomy: false, startupTask: scenarioTask("explore-remote-log") },
    openBrowser: false,
    learningDirectory: null,
    instanceLock: false,
    report: (result, source, details) => reports.push({ result, source, details }),
    taskDescription: "explore-remote-log",
    out: () => undefined,
    signals: { onShutdown: () => () => undefined },
    ...overrides,
  };
}

function assertSimulatorDetails(captured: Captured): ReportDetails {
  const details = captured.details;
  assert.ok(details, "the simulated session supplies report details");
  // The simulator's clock covers the task, so it can never read less than the time the task itself measured.
  assert.equal(typeof details.simulatedElapsedMs, "number");
  assert.ok((details.simulatedElapsedMs as number) >= captured.result.metrics.elapsedMs, "the simulated clock covers the task");
  assert.ok((details.simulatedElapsedMs as number) > 0, "the task took simulated time");
  const stats = details.worldStats as { damageTaken: number; minHealth: number; starvationTicks: number };
  assert.ok(Number.isFinite(stats.damageTaken) && stats.damageTaken >= 0);
  assert.ok(Number.isFinite(stats.minHealth) && stats.minHealth > 0 && stats.minHealth <= 20, "a surviving run's lowest health is a real, positive value");
  assert.ok(Number.isFinite(stats.starvationTicks) && stats.starvationTicks >= 0);
  return details;
}

test("a one-shot simulated run reports the simulated clock and statistics the simulator measured", async () => {
  await withDirectory(async (directory) => {
    const reports: Captured[] = [];
    assert.equal(await runCommandLine(simulatedRun(directory, reports)), 0);

    assert.equal(reports.length, 1);
    const [captured] = reports as [Captured];
    assert.equal(captured.source, "cli");
    assert.equal(captured.result.status, "succeeded");
    const details = assertSimulatorDetails(captured);

    // What the command line prints is this object serialised, so the fields survive to stdout.
    const printed = JSON.parse(JSON.stringify(simulatedTaskReport({ ...SCENARIO }, captured.result, captured.source, details))) as Record<string, unknown>;
    assert.equal(printed.simulatedElapsedMs, details.simulatedElapsedMs);
    assert.deepEqual(printed.worldStats, details.worldStats);
  });
});

test("the default run (persistent, with the Control Center) reports its startup task with the same details and then stays up", async () => {
  await withDirectory(async (directory) => {
    const reports: Captured[] = [];
    const shutdown: { request: ((reason: string) => void) | null } = { request: null };
    const finished = runCommandLine(
      simulatedRun(directory, reports, {
        mode: "persistent",
        controlCenter: true,
        signals: {
          onShutdown: (handler) => {
            shutdown.request = handler;
            return () => undefined;
          },
        },
      }),
    );
    let exitCode: number;
    try {
      await waitFor(() => reports.length === 1, "the startup task finished and was reported");
      const [captured] = reports as [Captured];
      assert.equal(captured.source, "cli");
      assert.equal(captured.result.status, "succeeded");
      assertSimulatorDetails(captured);
      assert.ok(shutdown.request, "the run is waiting for a shutdown request, so the session is still up");
    } finally {
      // Always ask the run to end: a failed assertion above must read as a failure, not leave a live session and a
      // listening Control Center behind that keep the whole test process from exiting.
      shutdown.request?.("SIGINT");
      exitCode = await finished;
    }
    assert.equal(exitCode, 0, "a requested stop is a clean exit");
    assert.equal(reports.length, 1, "the startup task is reported exactly once");
  });
});

test("a task started from the dashboard in a simulated session reports the same details, labelled as started there", async () => {
  await withDirectory(async (directory) => {
    const reports: Captured[] = [];
    const logs = captureLogger("error");
    const app = await GameMindApp.start({
      root: directory,
      dataDirectory: path.join(directory, "data"),
      logger: logs.logger,
      version: "0.0.0-test",
      bind: { host: "127.0.0.1", port: 0 },
      instanceLock: false,
      report: (result, source, details) => reports.push({ result, source, details }),
      stepTimeoutMs: 5_000,
    });
    const command = async (type: string, payload?: unknown) => {
      const response = await fetch(`${app.url}api/command`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gamemind-token": app.handle.token },
        body: JSON.stringify(payload === undefined ? { type } : { type, payload }),
      });
      return (await response.json()) as { ok?: boolean; message?: string };
    };
    try {
      const connected = await command("connectSession", { source: "simulated", scenarioId: "explore-remote-log", seed: 101, autonomy: false });
      assert.equal(connected.ok, true, connected.message);
      await waitFor(() => app.session?.state === "idle", "the simulated session became idle");
      assert.equal(reports.length, 0, "nothing was reported before a task ran");

      const started = await command("startTask", { kind: "gather-logs", count: 1 });
      assert.equal(started.ok, true, started.message);
      await waitFor(() => reports.length === 1, "the dashboard task finished and was reported");
      const [captured] = reports as [Captured];
      assert.equal(captured.source, "control-center");
      assert.equal(typeof captured.details?.simulatedElapsedMs, "number");
      assert.ok(captured.details?.worldStats && typeof captured.details.worldStats === "object");
    } finally {
      await app.shutdown("test complete");
    }
  });
});
