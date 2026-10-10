/**
 * The command-line flow end to end against the simulated world: a persistent run stays connected after its task until
 * it is told to stop, a one-shot run ends with its task, a refused connection is explained, the READY line a launcher
 * waits for is printed, the browser opens once, and a second copy of the app is refused. Nothing here touches a real server.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserOpener, type SpawnOpener } from "../src/app/browser.js";
import { READY_MARKER, runCommandLine, type ReadyInfo, type RunAppRequest, type SignalHub } from "../src/app/run-app.js";
import { parseArgs } from "../src/cli.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import type { MinecraftTaskResult } from "../src/games/minecraft/task-runner.js";
import { captureLogger, waitFor } from "./support/lifecycle-fixture.js";

class FakeSignals implements SignalHub {
  private handler: ((reason: string) => void) | null = null;
  registered = 0;
  unregistered = 0;
  onShutdown(handler: (reason: string) => void): () => void {
    this.handler = handler;
    this.registered += 1;
    return () => {
      this.unregistered += 1;
      this.handler = null;
    };
  }
  send(reason = "SIGINT"): void {
    this.handler?.(reason);
  }
}

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-cli-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function scenarioTask(id: string) {
  const scenario = evaluationScenarios().find((candidate) => candidate.id === id);
  assert.ok(scenario);
  return scenario.task();
}

interface Harness {
  readonly lines: string[];
  readonly reports: Array<{ result: MinecraftTaskResult; source: string }>;
  readonly signals: FakeSignals;
  readonly spawned: Array<{ command: string; args: readonly string[] }>;
  readonly request: (overrides?: Partial<RunAppRequest>) => RunAppRequest;
  readonly ready: () => ReadyInfo | null;
}

function harness(directory: string): Harness {
  const lines: string[] = [];
  const reports: Array<{ result: MinecraftTaskResult; source: string }> = [];
  const signals = new FakeSignals();
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  const spawnOpener: SpawnOpener = (command, args) => {
    spawned.push({ command, args });
    return { settled: Promise.resolve({ kind: "running" as const }) };
  };
  const logs = captureLogger("error");
  return {
    lines,
    reports,
    signals,
    spawned,
    ready: () => {
      const line = lines.find((entry) => entry.startsWith(READY_MARKER));
      return line ? (JSON.parse(line.slice(READY_MARKER.length + 1)) as ReadyInfo) : null;
    },
    request: (overrides = {}) => ({
      root: directory,
      dataDirectory: path.join(directory, "data"),
      logger: logs.logger,
      version: "0.0.0-test",
      mode: "persistent",
      controlCenter: true,
      bind: { host: "127.0.0.1", port: 0 },
      connect: { source: "simulated", scenarioId: "explore-remote-log", seed: 101, autonomy: false, startupTask: scenarioTask("explore-remote-log") },
      openBrowser: false,
      learningDirectory: path.join(directory, "learning"),
      instanceLock: false,
      report: (result, source) => reports.push({ result, source }),
      taskDescription: "explore-remote-log",
      out: (line) => lines.push(line),
      signals,
      appOptions: { browser: new BrowserOpener({ platform: { os: "linux", wsl: false, wslVersion: null, distro: null }, spawnOpener }) },
      ...overrides,
    }),
  };
}

test("regression: a persistent run stays connected after its task and ends only when told to", async () => {
  await withDirectory(async (directory) => {
    const h = harness(directory);
    const finished = runCommandLine(h.request());
    await waitFor(() => h.ready() !== null, "the READY line was printed");
    const ready = h.ready()!;
    assert.equal(ready.localOnly, true);
    assert.equal(ready.version, "0.0.0-test");
    assert.equal(ready.pid, process.pid);
    await waitFor(() => h.reports.length === 1, "the requested task finished and was reported");
    assert.equal(h.reports[0]?.result.status, "succeeded");
    assert.equal(h.reports[0]?.source, "cli");

    // The old CLI disconnected the bot here with "CLI run complete".
    await waitFor(() => h.lines.some((line) => /stays connected after its task/.test(line)), "the run says it is staying up");
    const health = (await (await fetch(`${ready.url}api/health`)).json()) as { sessionState: string };
    assert.equal(health.sessionState, "idle", "connected and idle, not shut down");
    const snapshot = (await (await fetch(`${ready.url}api/snapshot?fresh=1`)).json()) as { connection: { adapterStatus: string }; session: { mode: string; state: string } };
    assert.equal(snapshot.connection.adapterStatus, "connected");
    assert.equal(snapshot.session.mode, "persistent");
    assert.equal(h.signals.unregistered, 0, "still running");

    h.signals.send("SIGTERM");
    assert.equal(await finished, 0, "a requested stop is a clean exit");
    assert.equal(h.signals.unregistered, 1, "signal handlers are removed on the way out");
    await assert.rejects(fetch(`${ready.url}api/health`), "the Control Center is closed");
  });
});

test("a one-shot run ends with its task, reports it and exits 0 (and 1 when the task does not succeed)", async () => {
  await withDirectory(async (directory) => {
    const h = harness(directory);
    assert.equal(await runCommandLine(h.request({ mode: "one-shot", controlCenter: false })), 0);
    assert.equal(h.reports.length, 1);
    assert.equal(h.ready(), null, "no Control Center, so no READY line");

    const failing = harness(directory);
    const code = await runCommandLine(
      failing.request({
        mode: "one-shot",
        controlCenter: false,
        connect: { source: "simulated", scenarioId: "recovery-persistent-stall", seed: 101, autonomy: false, startupTask: scenarioTask("recovery-persistent-stall") },
        taskDescription: "recovery-persistent-stall",
      }),
    );
    assert.equal(code, 1, "a task that did not succeed is a failed one-shot run");
    assert.ok(failing.lines.some((line) => /task ended with status/.test(line)), "and the reason is printed");
  });
});

test("an expectation-aware failure rule keeps scenarios that only promise safety green", async () => {
  await withDirectory(async (directory) => {
    const h = harness(directory);
    const code = await runCommandLine(
      h.request({
        mode: "one-shot",
        controlCenter: false,
        connect: { source: "simulated", scenarioId: "recovery-persistent-stall", seed: 101, autonomy: false, startupTask: scenarioTask("recovery-persistent-stall") },
        isFailure: () => false,
      }),
    );
    assert.equal(code, 0);
  });
});

test("a refused connection is explained with things to check; one-shot exits 1, persistent keeps the page up", async () => {
  await withDirectory(async (directory) => {
    const oneShot = harness(directory);
    const refused = { source: "live" as const, host: "127.0.0.1", port: 9, mode: "one-shot" as const, autonomy: false };
    assert.equal(await runCommandLine(oneShot.request({ mode: "one-shot", controlCenter: true, connect: refused })), 1);
    const text = oneShot.lines.join("\n");
    assert.match(text, /Connection failed: Nothing accepted the connection at 127\.0\.0\.1:9/);
    assert.match(text, /Start the Minecraft server/);
    assert.match(text, /Error reported: connect ECONNREFUSED/);

    const persistent = harness(directory);
    const finished = runCommandLine(persistent.request({ connect: { ...refused, mode: "persistent" } }));
    await waitFor(() => persistent.lines.some((line) => /stays open/.test(line)), "the run says the page stays open", 20_000);
    const ready = persistent.ready()!;
    const snapshot = (await (await fetch(`${ready.url}api/snapshot?fresh=1`)).json()) as { session: { state: string; canConnect: boolean; error: { code: string } } };
    assert.equal(snapshot.session.state, "shutdown");
    assert.equal(snapshot.session.canConnect, true, "the operator can fix the settings and connect again");
    assert.equal(snapshot.session.error.code, "CONNECTION_REFUSED");
    persistent.signals.send("SIGINT");
    assert.equal(await finished, 0);
  });
});

test("--open-browser opens the page once and says so in the READY line; a failing opener is reported, not fatal", async () => {
  await withDirectory(async (directory) => {
    const h = harness(directory);
    const finished = runCommandLine(h.request({ openBrowser: true }));
    await waitFor(() => h.ready() !== null, "ready");
    assert.equal(h.spawned.length, 1);
    assert.deepEqual(h.spawned[0]?.args, [h.ready()!.url]);
    assert.deepEqual({ requested: h.ready()!.browser.requested, opened: h.ready()!.browser.opened, method: h.ready()!.browser.method }, { requested: true, opened: true, method: "xdg-open" });
    await waitFor(() => h.reports.length === 1, "task done");
    h.signals.send();
    await finished;
    assert.equal(h.spawned.length, 1, "no further launches during the whole run");

    const failing = harness(directory);
    const unavailable: SpawnOpener = () => ({ settled: Promise.resolve({ kind: "error" as const, message: "spawn xdg-open ENOENT", code: "ENOENT" }) });
    const second = runCommandLine(failing.request({ openBrowser: true, appOptions: { browser: new BrowserOpener({ platform: { os: "linux", wsl: false, wslVersion: null, distro: null }, spawnOpener: unavailable }) } }));
    await waitFor(() => failing.ready() !== null, "ready despite no browser");
    assert.equal(failing.ready()!.browser.opened, false);
    assert.match(failing.lines.join("\n"), /Could not open a browser automatically/);
    assert.match(failing.lines.join("\n"), new RegExp(failing.ready()!.url.replace(/[/.]/g, "\\$&")), "the address is printed so the operator can open it");
    failing.signals.send();
    assert.equal(await second, 0);
  });
});

test("a second app in the same project is refused with the first one's address", async () => {
  await withDirectory(async (directory) => {
    const first = harness(directory);
    const running = runCommandLine(first.request({ instanceLock: true }));
    await waitFor(() => first.ready() !== null, "first ready");
    const second = harness(directory);
    const code = await runCommandLine(second.request({ instanceLock: true }));
    assert.equal(code, 3);
    assert.match(second.lines.join("\n"), /already running in this project/);
    assert.match(second.lines.join("\n"), new RegExp(first.ready()!.url.replace(/[/.]/g, "\\$&")));
    first.signals.send();
    assert.equal(await running, 0);
  });
});

test("--no-connect starts only the Control Center, which waits for a connection from the page", async () => {
  await withDirectory(async (directory) => {
    const h = harness(directory);
    const finished = runCommandLine(h.request({ connect: null }));
    await waitFor(() => h.ready() !== null, "ready");
    assert.equal(h.ready()!.session, "none");
    const snapshot = (await (await fetch(`${h.ready()!.url}api/snapshot?fresh=1`)).json()) as { session: { state: string; canConnect: boolean } };
    assert.equal(snapshot.session.state, "none");
    assert.equal(snapshot.session.canConnect, true);
    h.signals.send();
    assert.equal(await finished, 0);
  });
});

test("the flag parser separates persistent from one-shot, keeps loopback by default and validates the new options", () => {
  const live = parseArgs(["--task", "gather-logs", "--host", "127.0.0.1"]);
  assert.equal(live.mode, "persistent");
  assert.equal(live.modeGiven, false);
  assert.equal(live.controlHost, "127.0.0.1");
  assert.equal(live.openBrowser, false);
  assert.equal(live.autonomy, true);
  assert.equal(live.connect, true);
  assert.equal(live.instanceLock, true);

  const scripted = parseArgs(["--task", "gather-logs", "--one-shot", "--open-browser", "--no-autonomy", "--allow-host", "GameMind.local", "--reconnect-attempts", "3", "--data-dir", "elsewhere"]);
  assert.equal(scripted.mode, "one-shot");
  assert.equal(scripted.modeGiven, true);
  assert.equal(scripted.openBrowser, true);
  assert.equal(scripted.autonomy, false);
  assert.deepEqual(scripted.allowHosts, ["gamemind.local"]);
  assert.equal(scripted.reconnectAttempts, 3);
  assert.equal(scripted.dataDirectory, "elsewhere");

  assert.equal(parseArgs(["--no-connect"]).connect, false);
  assert.throws(() => parseArgs(["--no-connect", "--task", "gather-logs"]), /--no-connect starts only the Control Center/);
  assert.throws(() => parseArgs(["--no-control-center", "--open-browser"]), /--open-browser needs the Control Center/);
  assert.throws(() => parseArgs(["--no-control-center", "--control-center"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--reconnect-attempts", "99"]), /0 through 20/);
  assert.throws(() => parseArgs(["--allow-host", "bad host!"]), /host name/);
  assert.throws(() => parseArgs(["--demo-task", "--one-shot"]), /offline fixture demos/);
});

test("--look-yaw is a one-shot probe and refuses the options that would have it keep a session or serve the page", () => {
  const probe = parseArgs(["--look-yaw", "0", "--host", "127.0.0.1"]);
  assert.equal(probe.lookYaw, 0);
  assert.equal(parseArgs(["--look-yaw", "1.5", "--one-shot", "--host", "127.0.0.1"]).lookYaw, 1.5);
  for (const flag of ["--control-center", "--open-browser", "--persistent"]) {
    assert.throws(
      () => parseArgs(["--look-yaw", "0", flag]),
      /--look-yaw is a one-shot probe.*cannot be combined with --control-center, --open-browser or --persistent/,
      `${flag} must be refused, not silently dropped`,
    );
  }
});
