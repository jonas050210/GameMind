/**
 * Lifecycle regressions for the run host: the "Cannot access 'host' before initialization" crash in the
 * autonomous subgoal path, the autonomy-versus-CLI race ("A task is already running in this agent"), and the
 * guarantees the single task scheduler adds (no duplicates, operator priority, orderly shutdown).
 *
 * Every test here drives the real `attachMinecraftRunHost` against the simulated world. They do not prove
 * anything about a live Minecraft server; see docs/LIVE_VERIFICATION.md for what still needs one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CRAFT_PICKAXE_TASK,
  DEFAULT_GATHER_LOG_TASK,
  type MinecraftTask,
} from "../src/games/minecraft/task.js";
import { TaskAdmissionError } from "../src/games/minecraft/task-scheduler.js";
import { startHostFixture, tick, waitFor } from "./support/lifecycle-fixture.js";

const cliTask: MinecraftTask = { ...DEFAULT_GATHER_LOG_TASK, id: "cli-gather-oak" };

test("regression: the first autonomous subgoal does not hit the host TDZ while the server is still starting", async () => {
  // The fast loop used to start before `const host` was initialised. Its first idle tick (which completes in
  // microtasks against the simulated adapter, long before the HTTP server finishes listening) reached
  // execute() -> createRunner(host.runnerOptions) and threw ReferenceError, leaking the task lock.
  const fixture = await startHostFixture({ fakeRunner: true });
  try {
    await waitFor(() => fixture.ran.length > 0, "autonomy launched a subgoal through the runner factory");
    assert.doesNotMatch(fixture.logs.text(), /before initialization|ReferenceError/, "no TDZ error was logged");
    await waitFor(() => fixture.host.control.task === null, "the task slot is released after the autonomous subgoal");
    assert.equal(fixture.host.scheduler.snapshot().counters.errored, 0, "no run ended in a scheduler error");
  } finally {
    await fixture.close();
  }
});

test("regression: a failed start can never leak the task lock (the next task is still accepted)", async () => {
  const fixture = await startHostFixture({ autonomous: false, fakeRunner: true, failFirstRunnerCreation: true });
  try {
    // The runner factory throws once, exactly as it did through the TDZ. execute() used to set the lock first
    // and only release it in a `finally` that the throwing call sat outside of.
    await assert.rejects(fixture.host.runTask(cliTask), /runner factory failed on purpose/);
    assert.equal(fixture.host.control.task, null, "the task slot is free again");
    assert.equal(fixture.host.scheduler.busy, false);
    const again = await fixture.host.runTask({ ...DEFAULT_CRAFT_PICKAXE_TASK, id: "second" });
    assert.equal(again.status, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("regression: autonomy cannot take the idle window from the CLI's startup task", async () => {
  const fixture = await startHostFixture({ startupTask: cliTask, fakeRunner: { hold: true } });
  try {
    // The loop is already ticking with autonomy enabled; give it many chances to start something.
    await tick(80);
    for (let i = 0; i < 5; i += 1) {
      fixture.host.loop.nudge();
      await tick(10);
    }
    assert.equal(fixture.ran.length, 0, "no autonomous task started while the CLI task was reserved");
    assert.equal(fixture.host.scheduler.snapshot().reservation?.owner, "cli");

    const run = fixture.host.runTask(cliTask);
    await waitFor(() => fixture.ran.length === 1, "the CLI task reached the runner");
    assert.equal(fixture.ran[0]?.id, cliTask.id, "the CLI task is the first thing that ran");
    assert.equal(fixture.host.scheduler.snapshot().reservation, null, "the reservation was consumed");
    fixture.releaseHeld();
    assert.equal((await run).status, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("the CLI task runs first against the real runner even with autonomy enabled, and the session stays connected after it", async () => {
  const fixture = await startHostFixture({ startupTask: cliTask });
  try {
    const result = await fixture.host.runTask(cliTask);
    assert.equal(result.status, "succeeded", `CLI task result: ${result.failure?.message ?? "ok"}`);
    assert.equal(fixture.ran[0]?.id, cliTask.id, "autonomy did not run before the requested task");
    assert.equal(fixture.runtime.status().adapterStatus, "connected", "finishing a task does not disconnect the session");
    assert.equal(fixture.host.loop.state.running, true, "the observation loop keeps running after the task");
    // The agent is usable for the next request straight away.
    const next = await fixture.host.runTask({ ...DEFAULT_CRAFT_PICKAXE_TASK, id: "second-task" });
    assert.ok(["succeeded", "failed", "blocked", "max_actions"].includes(next.status));
    assert.equal(fixture.runtime.status().adapterStatus, "connected");
  } finally {
    await fixture.close();
  }
});

test("a duplicate of the running task is refused with TASK_DUPLICATE and nothing starts twice", async () => {
  const fixture = await startHostFixture({ autonomous: false, fakeRunner: { hold: true } });
  try {
    const first = fixture.host.runTask(cliTask);
    await waitFor(() => fixture.ran.length === 1, "first task running");
    await assert.rejects(
      fixture.host.runTask({ ...cliTask, id: "same-task-other-id" }),
      (error: unknown) => error instanceof TaskAdmissionError && error.code === "TASK_DUPLICATE",
    );
    assert.equal(fixture.ran.length, 1);
    fixture.releaseHeld();
    await first;
  } finally {
    await fixture.close();
  }
});

test("a different task while one is running is refused with a message that names the running task", async () => {
  const fixture = await startHostFixture({ autonomous: false, fakeRunner: { hold: true } });
  try {
    const first = fixture.host.runTask(cliTask);
    await waitFor(() => fixture.ran.length === 1, "first task running");
    await assert.rejects(
      fixture.host.runTask({ ...DEFAULT_CRAFT_PICKAXE_TASK, id: "craft" }),
      (error: unknown) => error instanceof TaskAdmissionError && error.code === "TASK_ALREADY_RUNNING" && /Gather 1 oak_log/.test(error.message),
    );
    fixture.releaseHeld();
    await first;
  } finally {
    await fixture.close();
  }
});

test("an operator task pre-empts a running autonomous subgoal instead of racing it", async () => {
  const fixture = await startHostFixture({ fakeRunner: { hold: true } });
  try {
    await waitFor(() => fixture.ran.length === 1, "autonomy started a subgoal");
    const autonomousTask = fixture.ran[0]!;
    assert.notEqual(autonomousTask.id, cliTask.id);
    assert.equal(fixture.host.scheduler.snapshot().active?.origin, "autonomy");

    const operator = fixture.host.runTask(cliTask);
    await tick(5);
    assert.equal(fixture.host.control.stopRequested !== null, true, "autonomy was asked to stop at its next action boundary");
    assert.match(fixture.host.control.stopRequested ?? "", /preempted by cli task/);
    assert.equal(fixture.ran.length, 1, "the operator task waits for the autonomous action boundary");

    fixture.releaseHeld("aborted");
    await waitFor(() => fixture.ran.length === 2, "operator task started after autonomy stopped");
    assert.equal(fixture.ran[1]?.id, cliTask.id);
    fixture.releaseHeld();
    assert.equal((await operator).status, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("close() drains the scheduler: the running task is stopped, queued tasks are cancelled and nothing starts afterwards", async () => {
  const fixture = await startHostFixture({ autonomous: false, fakeRunner: { hold: true } });
  const running = fixture.host.runTask(cliTask);
  await waitFor(() => fixture.ran.length === 1, "task running");
  const queued = fixture.host.scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "queued" }, origin: "control-center", whenBusy: "queue" });
  assert.ok(queued.accepted);
  const closing = fixture.host.close();
  await tick(5);
  assert.match(fixture.host.control.stopRequested ?? "", /run host closing/);
  fixture.releaseHeld("aborted");
  await closing;
  await running;
  await assert.rejects(queued.done, /cancelled before it started/);
  assert.equal(fixture.ran.length, 1, "the queued task never started");
  assert.equal(fixture.host.scheduler.snapshot().state, "closed");
  const late = fixture.host.scheduler.submit({ task: { ...DEFAULT_GATHER_LOG_TASK, id: "late", targetCount: 9 }, origin: "cli" });
  assert.equal(late.accepted, false);
  await fixture.runtime.shutdown("test complete");
});

test("the host reports autonomous work under its own origin, not as a CLI task", async () => {
  const fixture = await startHostFixture({ fakeRunner: true });
  try {
    await waitFor(() => fixture.host.scheduler.snapshot().counters.finished > 0, "an autonomous subgoal finished");
    const origins = new Set(fixture.host.scheduler.snapshot().history.map((entry) => entry.origin));
    assert.deepEqual([...origins], ["autonomy"]);
  } finally {
    await fixture.close();
  }
});

test("without a server the host serves nothing but still schedules, so a supervisor can own one shared server", async () => {
  const fixture = await startHostFixture({ autonomous: false, fakeRunner: true, startServer: false });
  try {
    assert.equal(fixture.host.handle, null, "no Control Center was started by the host");
    const result = await fixture.host.runTask(cliTask);
    assert.equal(result.status, "succeeded");
    assert.ok(fixture.host.source.commands.pause, "the host still exposes the command surface for a supervisor");
    const snapshot = await fixture.host.source.snapshot();
    assert.equal(snapshot.connection.adapterStatus, "connected");
  } finally {
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Session lifecycle: persistent versus one-shot, explicit states, reconnect, orderly shutdown.
// ---------------------------------------------------------------------------------------------------------------
import { SessionStartError } from "../src/app/session.js";
import { createSessionFixture } from "./support/session-fixture.js";

test("a persistent session walks connecting → initializing → idle and stays connected after its task finishes", async () => {
  const fixture = await createSessionFixture({ request: { startupTask: cliTask, autonomy: false } });
  try {
    await fixture.session.start();
    assert.equal(fixture.session.state === "idle" || fixture.session.state === "running", true);
    const outcome = await fixture.session.startup;
    assert.equal(outcome?.result?.status, "succeeded", outcome?.error?.message ?? outcome?.result?.failure?.message ?? "startup task failed");

    // The old CLI disconnected the bot right here, with "CLI run complete".
    assert.equal(fixture.session.isActive, true, "the session did not end with its task");
    assert.equal(fixture.session.runtime.status().adapterStatus, "connected");
    assert.equal(fixture.session.state, "idle");
    assert.equal(fixture.session.view().canStop, true);
    assert.equal(fixture.session.view().mode, "persistent");

    const states = fixture.session.view().history.map((entry) => entry.state);
    assert.deepEqual(states.slice(0, 3), ["connecting", "initializing", "idle"]);
    assert.ok(states.includes("running"), "the timeline records that work happened");
    assert.equal(states.at(-1), "idle");

    // A second request is accepted by the same live session.
    const second = await fixture.session.host!.runTask({ ...DEFAULT_CRAFT_PICKAXE_TASK, id: "second-task" });
    assert.ok(["succeeded", "failed", "blocked", "max_actions"].includes(second.status));
    assert.equal(fixture.session.runtime.status().adapterStatus, "connected");
  } finally {
    await fixture.close();
  }
});

test("a one-shot session ends with its task, and says why", async () => {
  const fixture = await createSessionFixture({ request: { startupTask: cliTask, autonomy: false, mode: "one-shot" } });
  try {
    await fixture.session.start();
    const outcome = await fixture.session.startup;
    assert.equal(outcome?.result?.status, "succeeded");
    const end = await fixture.session.ended;
    assert.equal(end.reason, "one-shot task finished");
    assert.equal(fixture.session.state, "shutdown");
    assert.equal(fixture.session.runtime.status().adapterStatus, "disconnected");
  } finally {
    await fixture.close();
  }
});

test("stop() while a task is running stops it, disconnects once, and is safe to call again", async () => {
  const fixture = await createSessionFixture({ request: { autonomy: false } });
  try {
    await fixture.session.start();
    const running = fixture.session.host!.runTask({ ...DEFAULT_GATHER_LOG_TASK, id: "long-task", targetCount: 12, maxActions: 200 });
    await waitFor(() => fixture.session.state === "running", "the task started");
    const first = fixture.session.stop("operator pressed stop");
    const second = fixture.session.stop("a second caller");
    assert.strictEqual(first, second, "stop is idempotent: both callers get the same shutdown");
    await first;
    const result = await running.catch((error: Error) => error);
    assert.ok(result instanceof Error || ["aborted", "disconnected", "succeeded", "failed"].includes((result as { status: string }).status), "the running task settled instead of being orphaned");
    assert.equal(fixture.session.state, "shutdown");
    assert.equal(fixture.session.runtime.status().adapterStatus, "disconnected");
    assert.equal(fixture.session.view().reason, "operator pressed stop");
    const codes = fixture.events.list({ category: ["shutdown"] }).events.map((event) => event.code);
    assert.ok(codes.includes("SESSION_STOPPING") && codes.includes("SESSION_SHUTDOWN"), `shutdown events: ${codes.join(", ")}`);
    assert.equal(fixture.session.host?.scheduler.snapshot().state, "closed");
  } finally {
    await fixture.close();
  }
});

test("a connection that is refused fails the start with a diagnosis, shuts the session down cleanly, and keeps the app usable", async () => {
  const fixture = await createSessionFixture({ failConnects: 1 });
  try {
    await assert.rejects(fixture.session.start(), (error: unknown) => {
      assert.ok(error instanceof SessionStartError);
      assert.equal(error.diagnosis.code, "CONNECTION_REFUSED");
      assert.ok(error.diagnosis.hints.length > 0, "the diagnosis carries things to check");
      return true;
    });
    const view = fixture.session.view();
    assert.equal(view.state, "shutdown");
    assert.equal(view.error?.code, "CONNECTION_REFUSED");
    assert.equal(view.canConnect, true, "a new connection can be requested");
    assert.ok(fixture.events.list({ q: "CONNECTION_REFUSED" }).matched >= 1);
  } finally {
    await fixture.close();
  }
});

test("a dropped connection is retried with backoff and the session comes back without losing its state", async () => {
  const delays: number[] = [];
  const fixture = await createSessionFixture({
    request: { autonomy: false },
    reconnect: { enabled: true, maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 8_000 },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  try {
    await fixture.session.start();
    fixture.adapter.failConnects = 2;
    await fixture.adapter.disconnect("server restarting");
    await waitFor(() => fixture.session.state === "idle" && delays.length >= 3, "the session reconnected");
    assert.deepEqual(delays.slice(0, 3), [1_000, 2_000, 4_000], "exponential backoff between attempts");
    assert.equal(fixture.adapter.connectAttempts, 4, "the first connect plus three retries");
    assert.equal(fixture.session.runtime.status().adapterStatus, "connected");
    assert.equal(fixture.session.view().reconnect, null);
    const states = fixture.session.view().history.map((entry) => entry.state);
    assert.ok(states.includes("reconnecting"));
    assert.ok(fixture.events.list({ q: "Reconnected" }).matched >= 1);
    // The agent is usable again.
    const result = await fixture.session.host!.runTask(cliTask);
    assert.equal(result.status, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("when every reconnect attempt fails the session shuts down with RECONNECT_EXHAUSTED instead of retrying forever", async () => {
  const fixture = await createSessionFixture({
    request: { autonomy: false },
    reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
  });
  try {
    await fixture.session.start();
    fixture.adapter.failConnects = 99;
    await fixture.adapter.disconnect("server gone");
    const end = await fixture.session.ended;
    assert.equal(end.reason, "reconnect attempts exhausted");
    assert.equal(end.error?.code, "RECONNECT_EXHAUSTED");
    assert.equal(fixture.adapter.connectAttempts, 3, "the first connect plus exactly two retries");
  } finally {
    await fixture.close();
  }
});

test("stopping during a reconnect cancels the pending retry and leaves no timer behind", async () => {
  let release: (() => void) | null = null;
  const fixture = await createSessionFixture({
    request: { autonomy: false },
    reconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  try {
    await fixture.session.start();
    await fixture.adapter.disconnect("network blip");
    await waitFor(() => fixture.session.state === "reconnecting", "reconnecting");
    assert.ok(release, "a retry is waiting");
    assert.ok(fixture.session.view().reconnect?.nextAttemptAt, "the UI can show when the next attempt happens");
    await fixture.session.stop("operator stop during reconnect");
    assert.equal(fixture.session.state, "shutdown");
    assert.equal(fixture.adapter.connectAttempts, 1, "no further connection attempt was made after the stop");
  } finally {
    await fixture.close();
  }
});

test("one-shot sessions and disabled reconnect end on a lost connection instead of retrying", async () => {
  const fixture = await createSessionFixture({ request: { autonomy: false, mode: "one-shot" } });
  try {
    await fixture.session.start();
    await fixture.adapter.disconnect("link dropped");
    const end = await fixture.session.ended;
    assert.match(end.reason, /connection lost: link dropped/);
  } finally {
    await fixture.close();
  }
});

test("a server-side ban is not retried: reconnecting could never fix it", async () => {
  const fixture = await createSessionFixture({ request: { autonomy: false } });
  try {
    await fixture.session.start();
    await fixture.adapter.disconnect("Minecraft server kicked the bot: You are banned from this server");
    const end = await fixture.session.ended;
    assert.equal(end.error?.code, "NOT_RETRYABLE");
    assert.equal(fixture.adapter.connectAttempts, 1);
  } finally {
    await fixture.close();
  }
});

test("shutdown steps are bounded: a hung step is reported and the remaining steps still run", async () => {
  const fixture = await createSessionFixture({ request: { autonomy: false }, stepTimeoutMs: 60 });
  try {
    await fixture.session.start();
    const host = fixture.session.host!;
    const realClose = host.close.bind(host);
    // A host that never finishes closing, the way a wedged task would.
    (host as { close: () => Promise<void> }).close = () => new Promise<void>(() => undefined);
    let runtimeShutdowns = 0;
    const runtime = fixture.session.runtime;
    const original = runtime.shutdown.bind(runtime);
    (runtime as { shutdown: typeof runtime.shutdown }).shutdown = async (reason) => {
      runtimeShutdowns += 1;
      await original(reason);
    };
    await fixture.session.stop("normal stop");
    assert.equal(runtimeShutdowns, 1, "the bot was still disconnected, exactly once");
    assert.equal(fixture.session.state, "shutdown");
    assert.equal(fixture.session.runtime.status().adapterStatus, "disconnected");
    const timeouts = fixture.events.list({ q: "SHUTDOWN_STEP_TIMEOUT" });
    assert.equal(timeouts.matched, 1, "the hung step is reported in the event log");
    assert.match(timeouts.events[0]?.message ?? "", /task scheduler and run host/);
    await realClose();
  } finally {
    await fixture.close();
  }
});
