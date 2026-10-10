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
