/**
 * Responsiveness regressions, offline. Every test here runs the real adapter, trace and loop code against the
 * Mineflayer double in test/support/minecraft-double.ts. They prove control flow and cache correctness, not the
 * timing a live server would show; live numbers are in docs/PERFORMANCE.md and are labelled as such.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pino from "pino";
import { MemoryTraceSink, TraceRecorder, type TraceSink } from "../src/core/trace.js";
import { DEFAULT_OBSERVATION_INTERVAL_MS } from "../src/games/minecraft/agent-loop.js";
import { minecraftObservationSummary } from "../src/games/minecraft/observation-summary.js";
import { MINECRAFT_LOOK_CAPABILITY } from "../src/games/minecraft/capabilities.js";
import { createLiveMock, connectAdapter } from "./support/minecraft-double.js";

/** Counts calls to the bot's wide block search, the operation the cache exists to avoid. */
function countFindBlocks(mock: ReturnType<typeof createLiveMock>): { calls: () => number } {
  let calls = 0;
  const bot = mock.bot as unknown as { findBlocks: (search: unknown) => unknown };
  const original = bot.findBlocks;
  bot.findBlocks = (search: unknown) => {
    calls += 1;
    return original(search);
  };
  return { calls: () => calls };
}

function seedWideBlocks(mock: ReturnType<typeof createLiveMock>): void {
  mock.blocks.set("12,64,0", { name: "oak_log", type: 1, boundingBox: "block" });
  mock.blocks.set("-9,64,7", { name: "stone", type: 2, boundingBox: "block" });
  mock.blocks.set("20,64,-14", { name: "oak_log", type: 1, boundingBox: "block" });
}

test("steady-state observations reuse the wide scans; the cache is reported as cached with its age", async () => {
  const mock = createLiveMock();
  seedWideBlocks(mock);
  const adapter = await connectAdapter(mock);
  const scans = countFindBlocks(mock);

  const first = await adapter.observe();
  const firstScans = scans.calls();
  assert.equal(firstScans, 2, "a fresh observation runs the resource walk and the mineable walk once each");
  assert.equal(first.state.resourceScan.cached, false);

  const second = await adapter.observe();
  assert.equal(scans.calls(), firstScans, "the next tick at the same position runs no wide walk");
  assert.equal(second.state.resourceScan.cached, true);
  assert.ok((second.state.resourceScan.ageMs ?? -1) >= 0, "the age of the reused scan is reported");
  await adapter.disconnect("test");
});

test("a reused scan returns the same sightings as a fresh scan at the same position (accuracy is not traded away)", async () => {
  const mock = createLiveMock();
  seedWideBlocks(mock);
  const adapter = await connectAdapter(mock);
  const cached = await adapter.observe();
  const cachedAgain = await adapter.observe();
  (adapter as unknown as { invalidateWideScan(reason: string): void }).invalidateWideScan("test");
  const fresh = await adapter.observe();
  const names = (sightings: readonly { name: string; position: unknown }[]) =>
    sightings.map((sighting) => `${sighting.name}@${JSON.stringify(sighting.position)}`).sort();
  assert.deepEqual(names(cachedAgain.state.resourceSightings), names(fresh.state.resourceSightings));
  assert.deepEqual(names(cachedAgain.state.minableSightings ?? []), names(fresh.state.minableSightings ?? []));
  assert.deepEqual(names(cached.state.resourceSightings), names(fresh.state.resourceSightings));
  await adapter.disconnect("test");
});

test("a block change inside the scan radius invalidates the cache; one outside it does not", async () => {
  const mock = createLiveMock();
  seedWideBlocks(mock);
  const adapter = await connectAdapter(mock);
  const scans = countFindBlocks(mock);
  await adapter.observe();
  const afterFirst = scans.calls();

  // Far outside the 32-block scan radius around the agent: no rescan is warranted.
  (mock.bot as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
    "blockUpdate",
    { name: "stone", position: { x: 500, y: 64, z: 500 } },
    { name: "air", position: { x: 500, y: 64, z: 500 } },
  );
  await adapter.observe();
  assert.equal(scans.calls(), afterFirst, "an out-of-radius change keeps the cached scan");

  // A log broken inside the radius is exactly what the cached sighting list must stop reporting.
  (mock.bot as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
    "blockUpdate",
    { name: "oak_log", position: { x: 12, y: 64, z: 0 } },
    { name: "air", position: { x: 12, y: 64, z: 0 } },
  );
  const afterChange = await adapter.observe();
  assert.equal(scans.calls(), afterFirst + 2, "an in-radius resource change re-runs both walks");
  assert.equal(afterChange.state.resourceScan.cached, false);
  await adapter.disconnect("test");
});

test("any dispatched action invalidates the cache, so the observation that verifies it is a fresh scan", async () => {
  const mock = createLiveMock();
  seedWideBlocks(mock);
  const adapter = await connectAdapter(mock);
  const session = adapter.session;
  assert.ok(session);
  await adapter.observe();
  await adapter.executeAction(
    { actionId: randomUUID(), sessionId: session.id, capability: MINECRAFT_LOOK_CAPABILITY, input: { yaw: 0.2, pitch: 0 } },
    new AbortController().signal,
  );
  const verifying = await adapter.observe();
  assert.equal(verifying.state.resourceScan.cached, false, "post-action observation must not reuse pre-action scans");
  await adapter.disconnect("test");
});

test("the scan cache expires when the agent drifts beyond the drift limit", async () => {
  const mock = createLiveMock();
  seedWideBlocks(mock);
  const adapter = await connectAdapter(mock);
  await adapter.observe();
  mock.bot.entity.position = mock.bot.entity.position.offset(6, 0, 0);
  const moved = await adapter.observe();
  assert.equal(moved.state.resourceScan.cached, false, "six blocks of drift is more than the cache tolerates");
  await adapter.disconnect("test");
});

test("the compact trace summary is small and bounded even for a crowded observation", async () => {
  const mock = createLiveMock();
  seedWideBlocks(mock);
  for (let index = 0; index < 120; index += 1) {
    mock.blocks.set(`${index % 11},60,${Math.floor(index / 11)}`, { name: "stone", type: 2, boundingBox: "block" });
  }
  const adapter = await connectAdapter(mock);
  const observation = await adapter.observe();
  const summary = minecraftObservationSummary(observation.state);
  const bytes = Buffer.byteLength(JSON.stringify(summary));
  const full = Buffer.byteLength(JSON.stringify(observation.state));
  assert.ok(bytes < 1024, `summary is ${bytes} bytes`);
  assert.ok(bytes * 10 < full, `summary (${bytes} B) is at least 10x smaller than the full observation (${full} B)`);
  assert.ok(summary.headInWater === null || typeof summary.headInWater === "boolean", "water state is a measured boolean or unknown");
  await adapter.disconnect("test");
});

test("reflex cadence is 500 ms, so a new threat is seen within half a second instead of a full second", () => {
  assert.equal(DEFAULT_OBSERVATION_INTERVAL_MS, 500);
});

test("a non-durable trace event never blocks the caller, and a failed write does not poison later writes", async () => {
  const written: string[] = [];
  let failNext = false;
  const sink: TraceSink = {
    async write(event) {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      written.push(event.eventType);
    },
  };
  const recorder = new TraceRecorder(sink, pino({ level: "silent" }));

  // A non-durable event resolves without waiting for its write to reach the sink.
  const quick = recorder.record({ eventType: "observation.received" }, { durable: false });
  await quick;

  // Arm the failure for the next write, which is the durable one.
  failNext = true;
  // The write that failed rejects its own durable caller, and the next durable write still succeeds.
  await recorder.record({ eventType: "after-failure" }).then(
    () => assert.fail("the failed write should have rejected its caller"),
    () => undefined,
  );
  await recorder.record({ eventType: "recovered" });
  assert.ok(written.includes("recovered"), "the queue keeps working after one failed write");
});

test("a durable trace write still fails closed when persistence fails", async () => {
  const sink: TraceSink = {
    async write() {
      throw new Error("sink unavailable");
    },
  };
  const recorder = new TraceRecorder(sink, pino({ level: "silent" }));
  await assert.rejects(recorder.record({ eventType: "action.started" }), /sink unavailable/);
});

test("the in-memory sink still records every durable event in order", async () => {
  const sink = new MemoryTraceSink();
  const recorder = new TraceRecorder(sink, pino({ level: "silent" }));
  await recorder.record({ eventType: "a" }, { durable: false });
  await recorder.record({ eventType: "b" });
  await recorder.close?.();
  assert.deepEqual(sink.events.map((event) => event.eventType), ["a", "b"]);
});
