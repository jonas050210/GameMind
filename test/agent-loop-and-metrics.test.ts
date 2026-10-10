import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { FastObservationLoop, type ObservationTick } from "../src/games/minecraft/agent-loop.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { RuntimeMetrics, SampleWindow } from "../src/games/minecraft/runtime-metrics.js";

const silent = pino({ level: "silent" });

function observationState(overrides: Partial<MinecraftObservation["player"]> = {}): MinecraftObservation {
  return {
    player: {
      username: "TestAgent",
      position: { x: 0, y: 64, z: 0 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 300,
      onGround: true,
      alive: true,
      ...overrides,
    },
    inventory: [],
    equipment: { hand: null, offhand: null, head: null, torso: null, legs: null, feet: null },
    entities: [],
    nearbyBlocks: [],
    resourceSightings: [],
    resourceScan: { radius: 24, limit: 64, center: { x: 0, y: 64, z: 0 }, truncated: false },
    itemDrops: [],
    sampledRegion: { radius: 5, verticalRadius: 3, center: { x: 0, y: 64, z: 0 }, sampledCells: 100, unknownCells: 0, truncated: false },
    time: { dayTicks: 6000, day: 1, isNight: false },
  } as MinecraftObservation;
}

/** A clock and timer pair the test advances by hand, so cadence is measured without real waiting. */
function manualClock() {
  let now = 1_000_000;
  const timers: Array<{ callback: () => void; ms: number }> = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    setTimer(callback: () => void, ms: number) {
      const handle = { callback, ms };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle: unknown) {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    pending: () => timers.length,
    fireNext() {
      const next = timers.shift();
      next?.callback();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function stubRuntime(options: { status?: string; observe?: () => Promise<unknown>; state?: MinecraftObservation; observedAt?: () => string }) {
  let sequence = 0;
  const runtime = {
    adapter: { status: options.status ?? "connected" },
    session: options.status === "disconnected" ? null : {},
    observe: options.observe ?? (async () => ({
      state: options.state ?? observationState(),
      sequence: ++sequence,
      observedAt: options.observedAt ? options.observedAt() : new Date().toISOString(),
    })),
  };
  return runtime as never;
}

test("the fast loop observes about once per interval and never stacks timers", async () => {
  const clock = manualClock();
  const metrics = new RuntimeMetrics(clock.now);
  const loop = new FastObservationLoop({
    runtime: stubRuntime({}),
    metrics,
    logger: silent,
    intervalMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  loop.start();
  await flush();
  for (let cycle = 0; cycle < 5; cycle += 1) {
    clock.advance(1_000);
    assert.equal(clock.pending(), 1, "exactly one next tick is scheduled");
    clock.fireNext();
    await flush();
  }
  loop.stop();
  const summary = metrics.summary();
  assert.equal(summary.observation.total, 6, "one start tick plus five timed ticks");
  assert.equal(summary.observation.errors, 0);
  assert.equal(clock.pending(), 0, "stopping clears the schedule");
});

test("observations never overlap, and nudges received during one collapse into a single follow-up", async () => {
  const clock = manualClock();
  const metrics = new RuntimeMetrics(clock.now);
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const observe = () =>
    new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active -= 1;
        resolve({ state: observationState(), sequence: releases.length, observedAt: new Date(clock.now()).toISOString() });
      });
    });
  const loop = new FastObservationLoop({
    runtime: stubRuntime({ observe }),
    metrics,
    logger: silent,
    intervalMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  loop.start();
  await flush();
  assert.equal(releases.length, 1, "the first observation is in flight");
  loop.nudge();
  loop.nudge();
  loop.nudge();
  assert.equal(releases.length, 1, "nudges during a running observation do not start another one");
  assert.equal(loop.state.nudgePending, true);
  releases.shift()!();
  await flush();
  assert.equal(releases.length, 1, "one coalesced follow-up runs after the first finishes");
  assert.equal(maxActive, 1, "never more than one observation in flight");
  releases.shift()!();
  await flush();
  loop.stop();
  assert.equal(metrics.summary().observation.total, 2);
});

test("a disconnected session is counted as a skipped tick and does not observe", async () => {
  const clock = manualClock();
  const metrics = new RuntimeMetrics(clock.now);
  let observed = 0;
  const runtime = stubRuntime({
    status: "disconnected",
    observe: async () => {
      observed += 1;
      throw new Error("must not observe while disconnected");
    },
  });
  const loop = new FastObservationLoop({
    runtime,
    metrics,
    logger: silent,
    intervalMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  loop.start();
  await flush();
  clock.advance(1_000);
  clock.fireNext();
  await flush();
  loop.stop();
  assert.equal(observed, 0);
  assert.ok(metrics.summary().observation.skippedTicks >= 2, "each skipped tick is counted");
});

test("observation age reports staleness when the newest observation is old", async () => {
  const clock = manualClock();
  const metrics = new RuntimeMetrics(clock.now);
  const loop = new FastObservationLoop({
    runtime: stubRuntime({}),
    metrics,
    logger: silent,
    intervalMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  loop.start();
  await flush();
  loop.stop();
  clock.advance(5_000);
  const summary = metrics.summary();
  assert.ok(summary.observation.ageMs !== null && summary.observation.ageMs >= 5_000, "age grows while no new observation arrives");
  assert.equal(summary.observation.stale, true, "an observation older than the freshness bound is reported stale");
});

test("onIdle still fires for an urgent observation, so a reactive task can start", async () => {
  const clock = manualClock();
  const metrics = new RuntimeMetrics(clock.now);
  const ticks: ObservationTick[] = [];
  const loop = new FastObservationLoop({
    runtime: stubRuntime({ state: observationState({ health: 4 }) }),
    metrics,
    logger: silent,
    intervalMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onIdle: (tick) => {
      ticks.push(tick);
    },
  });
  loop.start();
  await flush();
  loop.stop();
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0]!.assessment.urgent, true, "the observation was urgent and the host still received it as idle");
  assert.deepEqual(ticks[0]!.newlyUrgent, ["CRITICAL_HEALTH"]);
});

test("a throwing observation handler is contained and the loop keeps running", async () => {
  const clock = manualClock();
  const metrics = new RuntimeMetrics(clock.now);
  const loop = new FastObservationLoop({
    runtime: stubRuntime({}),
    metrics,
    logger: silent,
    intervalMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onObservation: () => {
      throw new Error("handler bug");
    },
  });
  loop.start();
  await flush();
  clock.advance(1_000);
  clock.fireNext();
  await flush();
  loop.stop();
  assert.equal(metrics.summary().observation.total, 2, "the loop observed again after the handler threw");
});

test("SampleWindow is bounded and reports nearest-rank percentiles over what it still holds", () => {
  const window = new SampleWindow(4);
  for (const value of [100, 1, 2, 3, 4]) window.add(value);
  const summary = window.summary();
  assert.equal(window.lifetimeCount, 5, "lifetime count keeps every sample");
  assert.equal(summary.count, 5);
  assert.equal(summary.maxMs, 4, "the oldest sample (100) has been dropped from the window");
  assert.equal(summary.p50Ms, 2, "nearest rank of the median over [1, 2, 3, 4]");
  assert.equal(summary.p95Ms, 4);
  window.add(Number.NaN);
  window.add(-5);
  assert.equal(window.lifetimeCount, 5, "invalid samples are ignored, not queued");
});

test("RuntimeMetrics reports a reaction only once it is dispatched, and counts protected interrupts", () => {
  let now = 0;
  const metrics = new RuntimeMetrics(() => now);
  metrics.recordUrgent({ codes: ["CRITICAL_HEALTH"], detectedMs: 1_000 });
  now = 1_400;
  metrics.recordInterrupt({ detectedMs: 1_000, dispatchedMs: 1_400, interrupted: true });
  metrics.recordInterrupt({ detectedMs: null, dispatchedMs: 1_500, interrupted: false, protectedCapability: true });
  const summary = metrics.summary();
  assert.equal(summary.urgent.events, 1);
  assert.equal(summary.urgent.interruptsDispatched, 1);
  assert.equal(summary.urgent.interruptsSkippedProtected, 1);
  assert.equal(summary.reactionMs.count, 1);
  assert.equal(summary.reactionMs.p95Ms, 400);
});
