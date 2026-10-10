import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskAdmissionError,
  TaskCancelledError,
  TaskScheduler,
  describeTask,
  taskSignature,
  type SchedulerEvent,
  type SchedulerRunContext,
  type TaskSchedulerOptions,
} from "../src/games/minecraft/task-scheduler.js";
import {
  DEFAULT_CRAFT_PICKAXE_TASK,
  DEFAULT_GATHER_LOG_TASK,
  DEFAULT_MINE_COBBLESTONE_TASK,
  DEFAULT_SECURE_FOOD_TASK,
  type MinecraftTask,
} from "../src/games/minecraft/task.js";
import type { MinecraftTaskResult } from "../src/games/minecraft/task-runner.js";

function result(task: MinecraftTask, status: MinecraftTaskResult["status"] = "succeeded"): MinecraftTaskResult {
  return {
    taskId: task.id,
    status,
    failure: status === "succeeded" ? null : { code: "TEST_FAILURE", message: "failed on purpose" },
    metrics: { actions: 3, elapsedMs: 40, progressRatio: status === "succeeded" ? 1 : 0.25 } as MinecraftTaskResult["metrics"],
    actions: [],
    finalObservation: null,
  };
}

interface Gate {
  readonly task: MinecraftTask;
  readonly context: SchedulerRunContext;
  finish(status?: MinecraftTaskResult["status"]): void;
  fail(error: Error): void;
}

/** A runner whose tasks finish only when the test says so, and which records what the scheduler asked of it. */
function fixture(overrides: Partial<TaskSchedulerOptions> = {}) {
  const started: Gate[] = [];
  const stops: string[] = [];
  const events: SchedulerEvent[] = [];
  let clock = 1_000_000;
  const scheduler = new TaskScheduler({
    run: (task, context) =>
      new Promise<MinecraftTaskResult>((resolve, reject) => {
        started.push({
          task,
          context,
          finish: (status = "succeeded") => resolve(result(task, status)),
          fail: (error) => reject(error),
        });
      }),
    requestStop: (reason) => stops.push(reason),
    onEvent: (event) => events.push(event),
    now: () => (clock += 10),
    ...overrides,
  });
  return { scheduler, started, stops, events, advance: (ms: number) => (clock += ms) };
}

const gather = (id: string, count = 1): MinecraftTask => ({ ...DEFAULT_GATHER_LOG_TASK, id, targetCount: count });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a free scheduler starts the task before submit returns, so callers see the slot taken at once", () => {
  const { scheduler, started } = fixture();
  const submission = scheduler.submit({ task: gather("a"), origin: "cli" });
  assert.equal(submission.accepted, true);
  assert.equal(started.length, 1, "the runner's synchronous prefix ran inside submit");
  assert.equal(scheduler.busy, true);
  assert.equal(scheduler.activeTask?.id, "a");
  assert.equal(scheduler.snapshot().state, "running");
});

test("a finished task frees the slot, is remembered with its outcome, and resolves the caller", async () => {
  const { scheduler, started } = fixture();
  const submission = scheduler.submit({ task: gather("a"), origin: "cli" });
  assert.ok(submission.accepted);
  started[0]!.finish("failed");
  const finished = await submission.done;
  assert.equal(finished.status, "failed");
  assert.equal(scheduler.busy, false);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.history[0]?.status, "failed");
  assert.equal(snapshot.history[0]?.failure?.code, "TEST_FAILURE");
  assert.equal(snapshot.history[0]?.actions, 3);
  assert.equal(snapshot.counters.finished, 1);
});

test("a runner that throws releases the slot and rejects the caller instead of leaking the lock", async () => {
  // Regression: execute() used to set the lock before a call that could throw (the host TDZ), so one failed
  // start left "A task is already running" for the rest of the session.
  let calls = 0;
  const scheduler = new TaskScheduler({
    run: (task) => {
      calls += 1;
      if (calls === 1) throw new ReferenceError("Cannot access 'host' before initialization");
      return Promise.resolve(result(task));
    },
    requestStop: () => undefined,
  });
  const submission = scheduler.submit({ task: gather("a"), origin: "autonomy" });
  assert.ok(submission.accepted);
  await assert.rejects(submission.done, /before initialization/);
  assert.equal(scheduler.busy, false, "the slot is free again");
  const next = scheduler.submit({ task: gather("b"), origin: "cli" });
  assert.equal(next.accepted, true, "the next task is admitted immediately");
  if (next.accepted) await next.done;
  const errored = scheduler.snapshot().history.find((entry) => entry.state === "errored");
  assert.match(errored?.note ?? "", /before initialization/);
  assert.equal(scheduler.snapshot().counters.errored, 1);
});

test("an async runner failure also releases the slot and starts the next queued task", async () => {
  const { scheduler, started } = fixture();
  const first = scheduler.submit({ task: gather("a"), origin: "cli" });
  const second = scheduler.submit({ task: gather("b", 2), origin: "control-center", whenBusy: "queue" });
  assert.ok(first.accepted && second.accepted);
  started[0]!.fail(new Error("adapter exploded"));
  await assert.rejects(first.done, /adapter exploded/);
  await settle();
  assert.equal(started.length, 2, "the queued task started after the failure");
  assert.equal(scheduler.activeTask?.id, "b");
  started[1]!.finish();
  assert.equal((await second.done).status, "succeeded");
});

test("a second task while busy is refused with a stable code and the running task's name", () => {
  const { scheduler, started } = fixture();
  scheduler.submit({ task: gather("a", 2), origin: "cli" });
  const refused = scheduler.submit({ task: { ...DEFAULT_MINE_COBBLESTONE_TASK, id: "b" }, origin: "control-center" });
  assert.equal(refused.accepted, false);
  if (!refused.accepted) {
    assert.equal(refused.code, "TASK_ALREADY_RUNNING");
    assert.match(refused.message, /Gather 2 oak_log/);
  }
  assert.equal(started.length, 1, "no second runner was started");
  assert.equal(scheduler.snapshot().lastRefusal?.code, "TASK_ALREADY_RUNNING");
});

test("the same task cannot run twice or be queued twice, whatever its id", () => {
  const { scheduler } = fixture();
  scheduler.submit({ task: gather("first", 3), origin: "cli" });
  const duplicateOfRunning = scheduler.submit({ task: gather("second", 3), origin: "control-center", whenBusy: "queue" });
  assert.equal(duplicateOfRunning.accepted, false);
  if (!duplicateOfRunning.accepted) assert.equal(duplicateOfRunning.code, "TASK_DUPLICATE");

  const queued = scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "craft-1" }, origin: "control-center", whenBusy: "queue" });
  assert.ok(queued.accepted);
  const duplicateOfQueued = scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "craft-2" }, origin: "library", whenBusy: "queue" });
  assert.equal(duplicateOfQueued.accepted, false);
  if (!duplicateOfQueued.accepted) {
    assert.equal(duplicateOfQueued.code, "TASK_DUPLICATE");
    assert.match(duplicateOfQueued.message, /position 1/);
  }
  assert.equal(taskSignature(gather("x", 3)), taskSignature(gather("y", 3)));
  assert.notEqual(taskSignature(gather("x", 3)), taskSignature(gather("x", 4)));
});

test("queued tasks run in priority order, then arrival order, and the queue is bounded", async () => {
  const { scheduler, started } = fixture({ maxQueue: 3 });
  scheduler.submit({ task: gather("running"), origin: "cli" });
  const a = scheduler.submit({ task: { ...DEFAULT_MINE_COBBLESTONE_TASK, id: "from-companion" }, origin: "companion", whenBusy: "queue" });
  const b = scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "from-ui" }, origin: "control-center", whenBusy: "queue" });
  const c = scheduler.submit({ task: { ...DEFAULT_SECURE_FOOD_TASK, id: "from-cli" }, origin: "cli", whenBusy: "queue" });
  assert.ok(a.accepted && b.accepted && c.accepted);
  assert.deepEqual(scheduler.snapshot().queue.map((ticket) => ticket.taskId), ["from-cli", "from-ui", "from-companion"]);
  const overflow = scheduler.submit({ task: gather("overflow", 9), origin: "control-center", whenBusy: "queue" });
  assert.equal(overflow.accepted, false);
  if (!overflow.accepted) assert.equal(overflow.code, "TASK_QUEUE_FULL");

  started[0]!.finish();
  await settle();
  assert.equal(scheduler.activeTask?.id, "from-cli");
  started[1]!.finish();
  await settle();
  assert.equal(scheduler.activeTask?.id, "from-ui");
  started[2]!.finish();
  await settle();
  assert.equal(scheduler.activeTask?.id, "from-companion");
});

test("autonomy never queues, never starts behind another task, and is refused while anything waits", () => {
  const { scheduler } = fixture();
  scheduler.submit({ task: gather("operator"), origin: "control-center" });
  const refused = scheduler.submit({ task: { ...DEFAULT_SECURE_FOOD_TASK, id: "auto" }, origin: "autonomy", whenBusy: "queue" });
  assert.equal(refused.accepted, false);
  assert.equal(scheduler.snapshot().queue.length, 0, "autonomy is dropped, not queued");
});

test("an operator task pre-empts autonomy: autonomy is asked to stop and the operator task starts next", async () => {
  const { scheduler, started, stops, events } = fixture();
  scheduler.submit({ task: { ...DEFAULT_SECURE_FOOD_TASK, id: "auto" }, origin: "autonomy" });
  const operator = scheduler.submit({ task: gather("operator"), origin: "cli" });
  assert.ok(operator.accepted);
  assert.equal(operator.preempting, true);
  assert.equal(operator.position, 1);
  assert.equal(stops.length, 1);
  assert.match(stops[0] ?? "", /preempted by cli task/);
  assert.equal(started.length, 1, "the operator task waits for the autonomous action boundary");
  assert.ok(events.some((event) => event.type === "preempting"));

  started[0]!.finish("aborted");
  await settle();
  assert.equal(started.length, 2);
  assert.equal(scheduler.activeTask?.id, "operator");
  assert.match(scheduler.snapshot().history[0]?.note ?? "", /Stopped to make room for the cli task/);
  assert.equal(scheduler.snapshot().counters.preemptions, 1);
});

test("an operator task is never pre-empted by another operator task", () => {
  const { scheduler, stops } = fixture();
  scheduler.submit({ task: gather("first"), origin: "control-center" });
  const second = scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "second" }, origin: "cli" });
  assert.equal(second.accepted, false, "without whenBusy=queue it is refused, not pre-emptive");
  assert.equal(stops.length, 0, "the running operator task was left alone");
});

test("a startup reservation keeps autonomy out until the CLI task is submitted, then is consumed", async () => {
  const { scheduler, started, events } = fixture();
  const reservation = scheduler.reserve("cli", "startup task");
  assert.equal(scheduler.snapshot().state, "reserved");
  assert.equal(scheduler.canStartNow("autonomy"), false);
  const autonomy = scheduler.submit({ task: { ...DEFAULT_SECURE_FOOD_TASK, id: "auto" }, origin: "autonomy" });
  assert.equal(autonomy.accepted, false);
  if (!autonomy.accepted) assert.equal(autonomy.code, "SCHEDULER_RESERVED");
  const uiTask = scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "ui" }, origin: "companion" });
  assert.equal(uiTask.accepted, false, "equal or lower priority origins wait for the reservation owner");
  assert.equal(started.length, 0);

  const cli = scheduler.submit({ task: gather("cli-task"), origin: "cli" });
  assert.ok(cli.accepted);
  assert.equal(cli.position, 0, "the owner starts immediately");
  assert.equal(scheduler.snapshot().reservation, null, "the reservation was consumed by its owner");
  assert.ok(events.some((event) => event.type === "reservation-released" && event.reason === "consumed"));
  reservation.release();
  started[0]!.finish();
  await cli.done;
});

test("a reservation expires on its own, so a CLI that never submits cannot wedge the agent", () => {
  const { scheduler, advance, events } = fixture({ reservationTtlMs: 5_000 });
  scheduler.reserve("cli", "startup task");
  assert.equal(scheduler.canStartNow("autonomy"), false);
  advance(5_001);
  assert.equal(scheduler.canStartNow("autonomy"), true);
  assert.equal(scheduler.snapshot().reservation, null);
  assert.ok(events.some((event) => event.type === "reservation-released" && event.reason === "expired"));
  const autonomy = scheduler.submit({ task: { ...DEFAULT_SECURE_FOOD_TASK, id: "auto" }, origin: "autonomy" });
  assert.equal(autonomy.accepted, true);
});

test("releasing a reservation lets lower-priority work start again", () => {
  const { scheduler } = fixture();
  const reservation = scheduler.reserve("cli", "startup task");
  reservation.release();
  assert.equal(scheduler.canStartNow("autonomy"), true);
});

test("cancel removes a queued task and rejects its caller; cancel on the running task asks it to stop", async () => {
  const { scheduler, stops } = fixture();
  const running = scheduler.submit({ task: gather("running"), origin: "cli" });
  const queued = scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "queued" }, origin: "control-center", whenBusy: "queue" });
  assert.ok(running.accepted && queued.accepted);
  assert.equal(scheduler.cancel(queued.ticketId, "changed my mind"), "cancelled");
  await assert.rejects(queued.done, (error: unknown) => error instanceof TaskCancelledError && /changed my mind/.test(error.message));
  assert.equal(scheduler.snapshot().queue.length, 0);
  assert.equal(scheduler.snapshot().history[0]?.state, "cancelled");
  assert.equal(scheduler.cancel(running.ticketId, "operator stop"), "stop-requested");
  assert.deepEqual(stops, ["operator stop"]);
  assert.equal(scheduler.cancel("t-999"), null);
});

test("clearQueue cancels every waiting task and leaves the running one alone", () => {
  const { scheduler, stops } = fixture();
  scheduler.submit({ task: gather("running"), origin: "cli" });
  scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "q1" }, origin: "control-center", whenBusy: "queue" });
  scheduler.submit({ task: { ...DEFAULT_SECURE_FOOD_TASK, id: "q2" }, origin: "control-center", whenBusy: "queue" });
  assert.equal(scheduler.clearQueue(), 2);
  assert.equal(scheduler.busy, true);
  assert.equal(stops.length, 0);
});

test("the gate refuses a task with a readable reason before anything is queued or started", () => {
  const { scheduler, started } = fixture({ gate: (origin) => (origin === "control-center" ? "The run is paused; resume it first." : null) });
  const refused = scheduler.submit({ task: gather("a"), origin: "control-center" });
  assert.equal(refused.accepted, false);
  if (!refused.accepted) {
    assert.equal(refused.code, "TASK_REFUSED");
    assert.equal(refused.message, "The run is paused; resume it first.");
  }
  assert.equal(started.length, 0);
  assert.equal(scheduler.submit({ task: gather("b"), origin: "cli" }).accepted, true);
});

test("drain refuses new work, cancels the queue, stops the running task and waits for it to settle", async () => {
  const { scheduler, started, stops, events } = fixture();
  const running = scheduler.submit({ task: gather("running"), origin: "cli" });
  const queued = scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "queued" }, origin: "control-center", whenBusy: "queue" });
  assert.ok(running.accepted && queued.accepted);
  const draining = scheduler.drain("session stopping", 1_000);
  const lateSubmit = scheduler.submit({ task: gather("late", 5), origin: "cli" });
  assert.equal(lateSubmit.accepted, false);
  if (!lateSubmit.accepted) assert.equal(lateSubmit.code, "SCHEDULER_CLOSED");
  assert.deepEqual(stops, ["session stopping"]);
  assert.equal(started[0]!.context.signal.aborted, true, "the running task's signal fired");
  await assert.rejects(queued.done, TaskCancelledError);

  started[0]!.finish("aborted");
  const outcome = await draining;
  assert.deepEqual(outcome, { settled: true, cancelled: 1 });
  assert.equal(scheduler.busy, false);
  assert.equal(started.length, 1, "nothing started after the drain began");
  assert.ok(events.some((event) => event.type === "closed"));
  await running.done;
});

test("drain reports an unsettled task instead of hanging when a runner ignores the stop request", async () => {
  const { scheduler } = fixture();
  scheduler.submit({ task: gather("stubborn"), origin: "cli" });
  const outcome = await scheduler.drain("shutdown", 20);
  assert.equal(outcome.settled, false);
});

test("idle() resolves only after the running task and every queued task have finished", async () => {
  const { scheduler, started } = fixture();
  scheduler.submit({ task: gather("a"), origin: "cli" });
  scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "b" }, origin: "control-center", whenBusy: "queue" });
  let idle = false;
  const waiting = scheduler.idle().then(() => {
    idle = true;
  });
  started[0]!.finish();
  await settle();
  assert.equal(idle, false, "the queued task is still pending");
  started[1]!.finish();
  await waiting;
  assert.equal(idle, true);
});

test("ignored completion promises never surface as unhandled rejections", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { scheduler, started } = fixture();
    scheduler.submit({ task: gather("a"), origin: "autonomy" });
    scheduler.submit({ task: { ...DEFAULT_CRAFT_PICKAXE_TASK, id: "b" }, origin: "control-center", whenBusy: "queue" });
    scheduler.clearQueue("test");
    started[0]!.fail(new Error("nobody awaits this"));
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an observer that throws cannot break scheduling", async () => {
  const { scheduler, started } = fixture({
    onEvent: () => {
      throw new Error("observer bug");
    },
  });
  const submission = scheduler.submit({ task: gather("a"), origin: "cli" });
  assert.ok(submission.accepted);
  started[0]!.finish();
  assert.equal((await submission.done).status, "succeeded");
});

test("task descriptions are short and stable for the queue and the event log", () => {
  assert.equal(describeTask(gather("x", 4)), "Gather 4 oak_log");
  assert.equal(describeTask({ ...DEFAULT_CRAFT_PICKAXE_TASK }), "Craft 1 wooden_pickaxe");
  assert.match(describeTask({ ...DEFAULT_SECURE_FOOD_TASK }), /Secure food/);
  assert.ok(new TaskAdmissionError("TASK_DUPLICATE", "dup") instanceof Error);
});
