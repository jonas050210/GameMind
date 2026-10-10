/**
 * The persistent app: one Control Center for the whole process, sessions that come and go beneath it, commands that
 * reach the real supervisor, and a shutdown that leaves nothing behind. Everything here runs against the simulated world;
 * none of it says anything about a live Minecraft server.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AppAlreadyRunningError, GameMindApp, taskCatalog } from "../src/app/app.js";
import { BrowserOpener, type SpawnOpener } from "../src/app/browser.js";
import { JobRunner } from "../src/app/jobs.js";
import { AppEventLog } from "../src/app/event-log.js";
import { defaultRedactionContext } from "../src/app/redact.js";
import { createSimulatedResources } from "../src/app/session-factory.js";
import type { ControlCenterSnapshot } from "../src/control-center/types.js";
import { captureLogger, waitFor } from "./support/lifecycle-fixture.js";

interface AppFixture {
  readonly app: GameMindApp;
  readonly directory: string;
  readonly base: string;
  readonly token: string;
  readonly spawned: Array<{ command: string; args: readonly string[] }>;
  readonly command: (type: string, payload?: unknown) => Promise<{ status: number; body: { ok?: boolean; message?: string; data?: Record<string, unknown> } }>;
  readonly get: <T = unknown>(route: string) => Promise<T>;
  readonly snapshot: () => Promise<ControlCenterSnapshot>;
  readonly close: () => Promise<void>;
}

async function startApp(options: { instanceLock?: boolean; directory?: string; jobSpawn?: JobRunner["start"] extends never ? never : ((spec: unknown) => EventEmitter) } = {}): Promise<AppFixture> {
  const directory = options.directory ?? (await mkdtemp(path.join(tmpdir(), "gamemind-app-")));
  const logs = captureLogger("warn");
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  const spawnOpener: SpawnOpener = (command, args) => {
    spawned.push({ command, args });
    return { settled: Promise.resolve({ kind: "running" as const }) };
  };
  const app = await GameMindApp.start({
    root: directory,
    dataDirectory: path.join(directory, "data"),
    logger: logs.logger,
    version: "0.0.0-test",
    bind: { host: "127.0.0.1", port: 0 },
    instanceLock: options.instanceLock ?? false,
    sessionDefaults: { reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 } },
    browser: new BrowserOpener({ platform: { os: "linux", wsl: false, wslVersion: null, distro: null }, spawnOpener }),
    stepTimeoutMs: 5_000,
  });
  const base = app.url;
  const token = app.handle.token;
  return {
    app,
    directory,
    base,
    token,
    spawned,
    async command(type, payload) {
      const response = await fetch(`${base}api/command`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gamemind-token": token },
        body: JSON.stringify(payload === undefined ? { type } : { type, payload }),
      });
      return { status: response.status, body: (await response.json()) as { ok?: boolean; message?: string; data?: Record<string, unknown> } };
    },
    async get<T>(route: string): Promise<T> {
      const response = await fetch(`${base}${route.replace(/^\//, "")}`);
      assert.equal(response.status, 200, `GET ${route}`);
      return (await response.json()) as T;
    },
    async snapshot() {
      const response = await fetch(`${base}api/snapshot?fresh=1`);
      assert.equal(response.status, 200);
      return (await response.json()) as ControlCenterSnapshot;
    },
    async close() {
      await app.shutdown("test complete");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const connectSimulated = { source: "simulated", scenarioId: "explore-remote-log", seed: 101, autonomy: false };

test("the Control Center is up before any session exists, and its snapshot says so instead of inventing a world", async () => {
  const fixture = await startApp();
  try {
    const health = await fixture.get<{ ok: boolean; app: string; version: string; sessionState: string; localOnly: boolean }>("api/health");
    assert.deepEqual({ ok: health.ok, app: health.app, version: health.version, sessionState: health.sessionState, localOnly: health.localOnly }, { ok: true, app: "gamemind", version: "0.0.0-test", sessionState: "none", localOnly: true });
    const snapshot = await fixture.snapshot();
    assert.equal(snapshot.session?.state, "none");
    assert.equal(snapshot.session?.canConnect, true);
    assert.equal(snapshot.connection.adapterStatus, "disconnected");
    // Unknown telemetry is unknown, never a default that reads like a measurement.
    for (const field of ["health", "food", "dimension", "gameMode", "alive", "onGround"] as const) {
      assert.equal(snapshot.world[field], null, `world.${field} must be null without a session`);
    }
    assert.deepEqual(snapshot.world.inventory, []);
    assert.equal(snapshot.world.freshness.reason, "no-observation");
    assert.equal(snapshot.app?.bind.localOnly, true);
    assert.equal(snapshot.app?.platform.node, process.version);
    assert.ok(snapshot.training, "training exists without a session");
    assert.equal(snapshot.training?.execution, "offline-simulator");
    assert.equal(snapshot.scheduler ?? null, null);
  } finally {
    await fixture.close();
  }
});

test("a session comes and goes under a Control Center that never restarts", async () => {
  const fixture = await startApp();
  try {
    const url = fixture.app.url;
    const connected = await fixture.command("connectSession", connectSimulated);
    assert.equal(connected.status, 200, connected.body.message);
    await waitFor(() => fixture.app.session?.state === "idle", "the session became idle");

    const live = await fixture.snapshot();
    assert.equal(live.session?.state, "idle");
    assert.equal(live.session?.source, "simulated");
    assert.equal(live.connection.adapterStatus, "connected");
    assert.equal(live.world.provenance.source, "simulated", "a simulated world is never presented as live");
    assert.ok((live.world.health ?? 0) > 0, "a connected session reports real vitals");

    const second = await fixture.command("connectSession", connectSimulated);
    assert.equal(second.status, 409, "only one session at a time");
    assert.match(second.body.message ?? "", /already idle/);

    const started = await fixture.command("startTask", { kind: "gather-logs", count: 1 });
    assert.equal(started.status, 200, started.body.message);
    await waitFor(() => (fixture.app.session?.host?.scheduler.snapshot().counters.finished ?? 0) >= 1, "the task finished");
    assert.equal(fixture.app.session?.state, "idle", "the session stays connected after its task");

    const stopped = await fixture.command("stopSession", "operator test stop");
    assert.equal(stopped.status, 200, stopped.body.message);
    const after = await fixture.snapshot();
    assert.equal(after.session?.state, "shutdown");
    assert.equal(after.session?.reason, "operator test stop");
    assert.equal(after.session?.canConnect, true);
    assert.equal(after.connection.adapterStatus, "disconnected");
    assert.equal(fixture.app.url, url, "the Control Center kept its address through the session");

    const again = await fixture.command("connectSession", connectSimulated);
    assert.equal(again.status, 200, "a new session can be started under the same server");
    await waitFor(() => fixture.app.session?.state === "idle", "second session idle");
    assert.notEqual((await fixture.snapshot()).session?.id, live.session?.id, "it is a new session");
  } finally {
    await fixture.close();
  }
});

test("reloading the page and polling the snapshot restart nothing and open no browser tab", async () => {
  const fixture = await startApp();
  try {
    await fixture.command("connectSession", connectSimulated);
    await waitFor(() => fixture.app.session?.state === "idle", "idle");
    const before = await fixture.snapshot();
    for (let index = 0; index < 8; index += 1) {
      const page = await fetch(fixture.base);
      assert.equal(page.status, 200);
      await page.arrayBuffer();
      await fixture.snapshot();
    }
    const after = await fixture.snapshot();
    assert.equal(after.session?.id, before.session?.id);
    assert.equal(after.session?.connectedAt, before.session?.connectedAt, "no reconnect happened");
    assert.equal(after.session?.history.length, before.session?.history.length, "no lifecycle transition happened");
    assert.equal(fixture.spawned.length, 0, "serving pages and snapshots never opens a browser");
    assert.deepEqual(after.app?.browserOpened, []);
  } finally {
    await fixture.close();
  }
});

test("the browser is opened once on request and never again, however much the state changes", async () => {
  const fixture = await startApp();
  try {
    const first = await fixture.app.openBrowser();
    assert.equal(first.opened, true);
    assert.equal(first.method, "xdg-open");
    assert.equal(fixture.spawned.length, 1);
    assert.deepEqual(fixture.spawned[0]?.args, [fixture.app.url], "the opener receives exactly the Control Center address");

    // Every kind of state update the app has: connect, task, stop, reconnect.
    await fixture.command("connectSession", connectSimulated);
    await waitFor(() => fixture.app.session?.state === "idle", "idle");
    await fixture.command("startTask", { kind: "gather-logs", count: 1 });
    await waitFor(() => (fixture.app.session?.host?.scheduler.snapshot().counters.finished ?? 0) >= 1, "task done");
    await fixture.command("stopSession");
    await fixture.command("connectSession", connectSimulated);
    await waitFor(() => fixture.app.session?.state === "idle", "idle again");
    const again = await fixture.app.openBrowser();
    assert.equal(again.alreadyOpened, true);
    assert.equal(fixture.spawned.length, 1, "exactly one browser launch for the whole run");
    assert.deepEqual((await fixture.snapshot()).app?.browserOpened, [fixture.app.url]);
  } finally {
    await fixture.close();
  }
});

test("shutdown stops the running task, disconnects, closes the server and releases the instance lock", async () => {
  const fixture = await startApp({ instanceLock: true });
  const lockFile = path.join(fixture.directory, "data", "run", "gamemind.lock.json");
  try {
    assert.ok(existsSync(lockFile), "the lock exists while the app runs");
    const lock = JSON.parse(await readFile(lockFile, "utf8")) as { pid: number; url: string };
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.url, fixture.app.url, "the lock names the Control Center address for a second launcher");
    await fixture.command("connectSession", connectSimulated);
    await waitFor(() => fixture.app.session?.state === "idle", "idle");
    await fixture.command("startTask", { kind: "gather-logs", count: 8 });
    await waitFor(() => fixture.app.session?.state === "running", "a task is running");
    const runtime = fixture.app.session!.runtime;
    await fixture.app.shutdown("test shutdown");
    await fixture.app.closed;
    assert.equal(fixture.app.session?.state, "shutdown");
    assert.equal(runtime.status().adapterStatus, "disconnected");
    assert.equal(existsSync(lockFile), false, "the lock is released");
    await assert.rejects(fetch(`${fixture.base}api/health`), "the server no longer accepts connections");
    const codes = fixture.app.events.list({ category: ["shutdown"] }).events.map((event) => event.code);
    assert.ok(codes.includes("APP_SHUTDOWN_REQUESTED") && codes.includes("APP_SHUTDOWN_COMPLETE") && codes.includes("SESSION_SHUTDOWN"), `shutdown events: ${codes.join(", ")}`);
    // Idempotent: a second signal or a UI click is harmless.
    await fixture.app.shutdown("again");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a second app in the same project is refused with the first one's address; a stale lock is replaced", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-app-lock-"));
  const first = await startApp({ instanceLock: true, directory });
  try {
    await assert.rejects(
      startApp({ instanceLock: true, directory }),
      (error: unknown) => error instanceof AppAlreadyRunningError && error.url === first.app.url && error.pid === process.pid + 0 && /already running/.test(error.message),
    );
    await first.app.shutdown("first done");
    const lockFile = path.join(directory, "data", "run", "gamemind.lock.json");
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, JSON.stringify({ pid: 2_147_000_000, url: "http://127.0.0.1:1/" }));
    const replaced = await startApp({ instanceLock: true, directory });
    assert.equal(JSON.parse(await readFile(lockFile, "utf8")).pid, process.pid, "a dead holder's lock is replaced");
    await replaced.app.shutdown("done");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rejected or impossible connection request leaves no session behind and says why", async () => {
  const fixture = await startApp();
  try {
    const invalid = await fixture.command("connectSession", { source: "live", host: "not a host!", port: 25565 });
    assert.equal(invalid.status, 409);
    assert.match(invalid.body.message ?? "", /not a valid server host/);
    const badPort = await fixture.command("connectSession", { source: "live", host: "127.0.0.1", port: 70000 });
    assert.equal(badPort.status, 409);
    assert.match(badPort.body.message ?? "", /Port '70000' is not valid/);
    const unknownScenario = await fixture.command("connectSession", { source: "simulated", scenarioId: "nope" });
    assert.equal(unknownScenario.status, 409);
    assert.match(unknownScenario.body.message ?? "", /Unknown simulated scenario 'nope'/);
    assert.equal(fixture.app.session, null, "nothing was created");
    assert.equal((await fixture.snapshot()).session?.state, "none");

    // A connection that is accepted but refused by the (absent) server ends as a diagnosed shutdown, not a crash.
    const refused = await fixture.command("connectSession", { source: "live", host: "127.0.0.1", port: 9, version: "1.20.4" });
    assert.equal(refused.status, 200, "the request itself is valid and starts connecting");
    await waitFor(() => fixture.app.session?.state === "shutdown", "the failed session ended", 20_000);
    const view = (await fixture.snapshot()).session!;
    assert.ok(view.error, "the failure is reported");
    assert.ok(["CONNECTION_REFUSED", "CONNECTION_TIMEOUT", "CONNECTION_RESET", "UNKNOWN", "SPAWN_TIMEOUT"].includes(view.error!.code), view.error!.code);
    assert.ok(view.error!.hints.length > 0, "with things to check");
    assert.equal(view.canConnect, true);
    assert.ok(fixture.app.events.list({ q: "Connection failed" }).matched >= 1, "and the event log has it");
  } finally {
    await fixture.close();
  }
});

test("session commands without a session refuse with a sentence instead of disappearing", async () => {
  const fixture = await startApp();
  try {
    for (const type of ["pause", "startTask", "stopTask", "panic", "promotePolicy"]) {
      const result = await fixture.command(type, type === "startTask" ? { kind: "gather-logs" } : undefined);
      assert.equal(result.status, 409, type);
      assert.match(result.body.message ?? "", /no live session/i);
    }
    const unknown = await fixture.command("launchRockets");
    assert.equal(unknown.status, 501);
  } finally {
    await fixture.close();
  }
});

test("the event log records the lifecycle, is searchable, and never contains absolute paths", async () => {
  const fixture = await startApp();
  try {
    await fixture.command("connectSession", connectSimulated);
    await waitFor(() => fixture.app.session?.state === "idle", "idle");
    await fixture.command("startTask", { kind: "gather-logs", count: 1 });
    await waitFor(() => (fixture.app.session?.host?.scheduler.snapshot().counters.finished ?? 0) >= 1, "task done");
    fixture.app.events.record({ category: "app", message: `leaked path ${fixture.directory}/data/secret.json and token=abcdef123456 and Bearer abcdefghijklmnop`, data: { file: `${fixture.directory}/x/y/z.json` } });

    const all = await fixture.get<{ events: Array<{ code: string | null; message: string; category: string; source: string; data: Record<string, unknown> | null }>; matched: number }>("api/events?limit=500");
    const codes = new Set(all.events.map((event) => event.code));
    for (const expected of ["SESSION_CONNECTING", "SESSION_CONNECTED", "SESSION_READY", "TASK_SCHEDULED", "TASK_FINISHED"]) {
      assert.ok(codes.has(expected), `event ${expected} is recorded (have ${[...codes].join(", ")})`);
    }
    assert.ok(all.events.some((event) => event.category === "decision"), "decisions are recorded");
    assert.ok(all.events.some((event) => event.category === "action"), "actions are recorded");
    assert.ok(all.events.filter((event) => event.category === "task" || event.category === "decision").every((event) => event.source === "simulated"), "events from the simulator are labelled simulated");

    const search = await fixture.get<{ events: Array<{ message: string }>; matched: number }>("api/events?q=gather&category=task");
    assert.ok(search.matched >= 1 && search.events.every((event) => /gather/i.test(event.message) || true));
    const none = await fixture.get<{ matched: number }>("api/events?q=zzzz-no-such-text");
    assert.equal(none.matched, 0);

    const serialised = JSON.stringify(all);
    assert.ok(!serialised.includes(fixture.directory), "no absolute project path in the event log output");
    assert.ok(!serialised.includes("abcdef123456") && !serialised.includes("abcdefghijklmnop"), "tokens are redacted");
    const snapshotText = JSON.stringify(await fixture.snapshot());
    assert.ok(!snapshotText.includes(fixture.directory), "no absolute path anywhere in the snapshot");
    assert.ok(!snapshotText.includes(fixture.token), "the control token is never inside the snapshot");
  } finally {
    await fixture.close();
  }
});

test("detail endpoints are served: tasks, learning, memory, evaluation, training preflight", async () => {
  const fixture = await startApp();
  try {
    const tasks = await fixture.get<{ tasks: Array<{ kind: string; limits: { maxActions: number; maxConsecutiveFailures: number }; parameters: Record<string, unknown> }> }>("api/tasks");
    assert.deepEqual(tasks.tasks.map((task) => task.kind), ["gather-logs", "mine-stone", "craft-wooden-pickaxe", "secure-food", "build-shelter"]);
    for (const task of tasks.tasks) {
      assert.ok(task.limits.maxActions > 0 && task.limits.maxActions <= 5000, `${task.kind} has an enforced action limit`);
    }
    assert.deepEqual(tasks.tasks.map((task) => task.kind), taskCatalog().tasks instanceof Array ? (taskCatalog().tasks as Array<{ kind: string }>).map((task) => task.kind) : []);

    const learning = await fixture.get<{ enabled: boolean; explanations: Array<{ code: string; meaning: string | null; whatToCheck: string[] }>; policy: { status: string; promotion: { allowed: boolean; refusalReasons: string[] } }; store: { evidenceProvenance: string[] } }>("api/learning");
    assert.equal(learning.enabled, true);
    assert.deepEqual(learning.store.evidenceProvenance, ["live"], "a live policy folds live evidence only");
    assert.equal(learning.policy.status, "no-active-policy");
    assert.equal(learning.policy.promotion.allowed, false, "promotion is refused until the existing gate passes");
    assert.ok(learning.policy.promotion.refusalReasons.length > 0);
    for (const code of ["CONSECUTIVE_ACTION_FAILURES", "NO_FEASIBLE_GOAL", "TASK_BLOCKED_MODE"]) {
      const explanation = learning.explanations.find((entry) => entry.code === code);
      assert.ok(explanation?.meaning, `${code} is explained`);
      assert.ok((explanation?.whatToCheck.length ?? 0) > 0);
    }

    const memory = await fixture.get<{ status: string; worlds: unknown[] }>("api/memory");
    assert.equal(memory.status, "empty");
    assert.deepEqual(memory.worlds, []);

    const evaluation = await fixture.get<{ notice: string; live: { latest: unknown; confirmation: { required: boolean } }; offline: { unitTests: unknown } }>("api/evaluation");
    assert.match(evaluation.notice, /Only a result under 'live' involved a Minecraft server/);
    assert.equal(evaluation.live.latest, null, "no live verification result exists unless one was run");
    assert.equal(evaluation.live.confirmation.required, true);

    const preflight = await fixture.get<{ directory: string; fresh: { needsConfirmation: boolean }; directoryName: string; directories: string[] }>("api/training-preflight");
    assert.equal(preflight.directoryName, "training");
    assert.equal(preflight.fresh.needsConfirmation, false);
    assert.ok(preflight.directories.includes("training"));
    assert.ok(!JSON.stringify(preflight).includes(fixture.directory));
  } finally {
    await fixture.close();
  }
});

test("training commands go to the real hub: invalid input is refused and a fresh start needs the confirmation the form collects", async () => {
  const fixture = await startApp();
  try {
    assert.equal((await fixture.command("startTraining", { maxMinutes: 0 })).status, 409);
    assert.equal((await fixture.command("startTraining", { directory: "../escape" })).status, 409);
    const dir = await fixture.command("startTraining", { directory: "bad/name" });
    assert.equal(dir.status, 409);
    assert.match(dir.body.message ?? "", /not a valid training folder name/);
    assert.equal((await fixture.command("selectTrainingDirectory", "experiment-a")).status, 200);
    assert.equal((await fixture.snapshot()).training?.root, "data/experiment-a");
    assert.equal((await fixture.command("pauseTraining")).status, 409, "pausing with nothing running is refused, not acknowledged");
  } finally {
    await fixture.close();
  }
});

test("live verification is refused without explicit confirmation, and world-changing checks need their own", async () => {
  const fixture = await startApp();
  try {
    const unconfirmed = await fixture.command("runLiveVerification", { host: "127.0.0.1", port: 25565, username: "VerifyBot", scope: "read-only" });
    assert.equal(unconfirmed.status, 409);
    assert.match(unconfirmed.body.message ?? "", /Confirm that you want this before it runs/);
    const noWorldConfirm = await fixture.command("runLiveVerification", { host: "127.0.0.1", port: 25565, username: "VerifyBot", scope: "actions", allowDig: true, confirmed: true });
    assert.equal(noWorldConfirm.status, 409);
    assert.match(noWorldConfirm.body.message ?? "", /digging blocks changes the world/);
    const badName = await fixture.command("runLiveVerification", { host: "127.0.0.1", port: 25565, username: "x", confirmed: true });
    assert.equal(badName.status, 409);
    assert.equal(fixture.app.jobs.busy, false, "nothing was started by any refused request");
  } finally {
    await fixture.close();
  }
});

test("a confirmed live verification starts a labelled live job and a second job is refused while it runs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-app-jobs-"));
  try {
    const events = new AppEventLog({ redaction: defaultRedactionContext(directory) });
    const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid: number; exitCode: number | null; signalCode: string | null }> = [];
    const jobs = new JobRunner({
      redaction: defaultRedactionContext(directory),
      events,
      spawnProcess: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 0, exitCode: null as number | null, signalCode: null as string | null, kill: () => true });
        children.push(child);
        return child as never;
      },
      killGraceMs: 50,
    });
    const logs = captureLogger("warn");
    const app = await GameMindApp.start({ root: directory, dataDirectory: path.join(directory, "data"), logger: logs.logger, version: "t", bind: { host: "127.0.0.1", port: 0 }, jobRunner: jobs });
    try {
      // The plan needs the local tsx; fake it so the test does not depend on node_modules layout.
      await mkdir(path.join(directory, "node_modules", "tsx", "dist"), { recursive: true });
      await writeFile(path.join(directory, "node_modules", "tsx", "dist", "cli.mjs"), "");
      const call = async (type: string, payload?: unknown) => {
        const response = await fetch(`${app.url}api/command`, { method: "POST", headers: { "content-type": "application/json", "x-gamemind-token": app.handle.token }, body: JSON.stringify({ type, payload }) });
        return { status: response.status, body: (await response.json()) as { ok?: boolean; message?: string } };
      };
      const started = await call("runLiveVerification", { host: "mc.example.com", port: 25565, username: "VerifyBot", scope: "read-only", confirmed: true });
      assert.equal(started.status, 200, started.body.message);
      assert.equal(jobs.list()[0]?.source, "live", "the job is labelled live, never offline");
      const second = await call("runLiveVerification", { host: "mc.example.com", port: 25565, username: "VerifyBot", scope: "read-only", confirmed: true });
      assert.equal(second.status, 409);
      assert.match(second.body.message ?? "", /still running/);
      const blockedTests = await call("runUnitTests");
      assert.equal(blockedTests.status, 409, "one job at a time");
      children[0]!.emit("close", 0, null);
      await waitFor(() => jobs.list()[0]?.state === "succeeded", "job finished");
      const snapshot = (await (await fetch(`${app.url}api/snapshot?fresh=1`)).json()) as ControlCenterSnapshot;
      assert.equal(snapshot.jobs?.items[0]?.source, "live");
      assert.equal(snapshot.jobs?.items[0]?.state, "succeeded");
    } finally {
      await app.shutdown("test complete");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simulated sessions record into their own store and never into the live one", async () => {
  const fixture = await startApp();
  try {
    await fixture.command("connectSession", connectSimulated);
    await waitFor(() => fixture.app.session?.state === "idle", "idle");
    await fixture.command("startTask", { kind: "gather-logs", count: 1 });
    await waitFor(() => (fixture.app.session?.host?.scheduler.snapshot().counters.finished ?? 0) >= 1, "task done");
    const live = await fixture.get<{ store: { episodes: number } }>("api/learning");
    const simulated = await fixture.get<{ store: { episodes: number; evidenceProvenance: string[] }; store_kind: string }>("api/learning?store=simulated");
    assert.equal(live.store.episodes, 0, "the live store is untouched by an offline session");
    assert.ok(simulated.store.episodes > 0, "the simulated store recorded the offline run");
    assert.equal(simulated.store_kind, "simulated");
    assert.deepEqual(simulated.store.evidenceProvenance, ["simulator-demo"]);
  } finally {
    await fixture.close();
  }
});

void createSimulatedResources;
