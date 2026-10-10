import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { RingBufferTraceSink, TraceRecorder } from "../../src/core/trace.js";
import { createMinecraftAgent } from "../../src/games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../../src/games/minecraft/decision-model.js";
import { MinecraftTaskRunner, type MinecraftTaskResult } from "../../src/games/minecraft/task-runner.js";
import { attachMinecraftRunHost, type MinecraftRunHost } from "../../src/games/minecraft/attach-control-center.js";
import type { MinecraftTask } from "../../src/games/minecraft/task.js";
import { evaluationScenarios } from "../../src/testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "../../src/testing/simulated-minecraft/adapter.js";

/** A pino logger whose lines are collected in memory, so a test can assert what the host reported. */
export function captureLogger(level: pino.Level = "info"): { readonly logger: Logger; readonly lines: string[]; readonly text: () => string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString("utf8").split("\n").filter((line) => line.length > 0));
      callback();
    },
  });
  return { logger: pino({ level }, stream), lines, text: () => lines.join("\n") };
}

/** A runner result that is just large enough for the host and the scheduler; the world is never touched. */
export function fakeTaskResult(task: MinecraftTask, status: MinecraftTaskResult["status"] = "succeeded"): MinecraftTaskResult {
  return {
    taskId: task.id,
    status,
    failure: status === "succeeded" ? null : { code: "FAKE_FAILURE", message: "fake runner failure" },
    metrics: { actions: 1, elapsedMs: 5, progressRatio: status === "succeeded" ? 1 : 0, taskSucceeded: status === "succeeded" } as MinecraftTaskResult["metrics"],
    actions: [],
    finalObservation: null,
    learning: null,
  };
}

export interface HostFixtureOptions {
  readonly scenarioId?: string;
  /** Default true: the autonomy loop is exactly what the old host raced with. */
  readonly autonomous?: boolean;
  readonly startupTask?: MinecraftTask;
  readonly startFastLoop?: boolean;
  readonly startServer?: boolean;
  /** Replace the real runner with a recording fake whose tasks finish immediately (or when released). */
  readonly fakeRunner?: boolean | { readonly hold: boolean };
  readonly logLevel?: pino.Level;
  /** Makes the first call of the runner factory throw, the way the host TDZ did. */
  readonly failFirstRunnerCreation?: boolean;
}

export interface HostFixture {
  readonly directory: string;
  readonly host: MinecraftRunHost;
  readonly adapter: SimulatedMinecraftAdapter;
  readonly runtime: ReturnType<typeof createMinecraftAgent>["runtime"];
  readonly logs: { readonly lines: string[]; readonly text: () => string };
  /** Tasks that reached the runner factory, in order, with their origin as the host labelled them. */
  readonly ran: MinecraftTask[];
  /** With `fakeRunner: { hold: true }`: resolves the oldest held task. */
  readonly releaseHeld: (status?: MinecraftTaskResult["status"]) => void;
  readonly close: () => Promise<void>;
}

export async function startHostFixture(options: HostFixtureOptions = {}): Promise<HostFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-lifecycle-"));
  const captured = captureLogger(options.logLevel ?? "warn");
  const logger = captured.logger;
  const ring = new RingBufferTraceSink(300);
  const trace = new TraceRecorder(ring, logger);
  const scenario = evaluationScenarios().find((candidate) => candidate.id === (options.scenarioId ?? "explore-remote-log")) ?? evaluationScenarios()[0];
  if (!scenario) throw new Error("the evaluation suite must provide a scenario");
  const adapter = new SimulatedMinecraftAdapter({ definition: scenario.world(101) });
  const { runtime, skills, safety } = createMinecraftAgent(adapter, trace, logger);
  await runtime.connect();
  const decisionModel = new MinecraftTaskDecisionModel();
  const ran: MinecraftTask[] = [];
  const held: Array<(status: MinecraftTaskResult["status"]) => void> = [];
  const hold = typeof options.fakeRunner === "object" && options.fakeRunner.hold;
  let factoryCalls = 0;
  const host = await attachMinecraftRunHost({
    runtime,
    skills,
    safety,
    traceSink: ring,
    logger,
    worldKey: `${scenario.id}#101`,
    offlineNote: "test fixture: simulated world",
    ...(options.autonomous === undefined ? {} : { autonomous: options.autonomous }),
    ...(options.startupTask ? { startupTask: options.startupTask } : {}),
    ...(options.startFastLoop === undefined ? {} : { startFastLoop: options.startFastLoop }),
    ...(options.startServer === undefined ? {} : { startServer: options.startServer }),
    companionMemoryDirectory: path.join(directory, "companion"),
    worldConfigPath: path.join(directory, "world-config.json"),
    trainingDirectory: path.join(directory, "training"),
    dataDirectory: path.join(directory, "data"),
    evaluationReportPath: path.join(directory, "no-report.json"),
    evaluationScenarioIds: evaluationScenarios().map((candidate) => candidate.id),
    port: 0,
    bindHost: "127.0.0.1",
    createRunner: (extra) => {
      factoryCalls += 1;
      if (options.failFirstRunnerCreation && factoryCalls === 1) throw new Error("runner factory failed on purpose");
      if (options.fakeRunner) {
        return {
          run: (task) => {
            ran.push(task);
            extra.onAction?.({} as never);
            if (!hold) return Promise.resolve(fakeTaskResult(task));
            return new Promise<MinecraftTaskResult>((resolve) => {
              held.push((status) => resolve(fakeTaskResult(task, status)));
            });
          },
        };
      }
      const inner = new MinecraftTaskRunner(runtime, skills, decisionModel, logger, {
        clock: () => adapter.simulatedNowMs,
        worldKey: `${scenario.id}#101`,
        ...extra,
      });
      return {
        run: (task) => {
          ran.push(task);
          return inner.run(task);
        },
      };
    },
  });
  return {
    directory,
    host,
    adapter,
    runtime,
    logs: captured,
    ran,
    releaseHeld: (status = "succeeded") => held.shift()?.(status),
    async close() {
      await host.close();
      await runtime.shutdown("test complete");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `condition` holds; fails with the given message instead of hanging a test. */
export async function waitFor(condition: () => boolean, message: string, timeoutMs = 4_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${message}`);
    await tick(stepMs);
  }
}
