import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { FakeMinecraftAdapter } from "../src/testing/fake-minecraft-adapter.js";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";

function makeAgent(options: ConstructorParameters<typeof FakeMinecraftAdapter>[0] = { seed: 17 }) {
  const logger = pino({ level: "silent" });
  const sink = new MemoryTraceSink();
  const trace = new TraceRecorder(sink, logger);
  const adapter = new FakeMinecraftAdapter(options);
  const agent = createMinecraftAgent(adapter, trace, logger);
  return { ...agent, adapter, sink };
}

test("invalid inputs and unavailable capabilities are rejected before adapter execution", async () => {
  const { runtime, skills, adapter, sink } = makeAgent();
  await runtime.connect();

  const invalid = await skills.run("minecraft.orient", { yaw: 9, pitch: 0 });
  assert.equal(invalid.action.status, "rejected");
  assert.equal(invalid.action.failure?.code, "INVALID_ACTION_INPUT");
  assert.equal(invalid.observationAfter?.state.player.orientation.yaw, 0);

  const unknown = await runtime.actionExecutor.execute({
    sessionId: runtime.session?.id ?? null,
    capability: "minecraft.teleport",
    input: { x: 100, y: 200, z: 100 },
    source: "test",
  });
  assert.equal(unknown.status, "rejected");
  assert.equal(unknown.failure?.code, "CAPABILITY_NOT_AVAILABLE");
  assert.equal(adapter.status, "connected");
  assert.ok(sink.events.some((event) => event.eventType === "action.rejected"));

  await runtime.shutdown("test complete");
});

test("timeouts cancel the in-flight action and preserve the connection when cancellation succeeds", async () => {
  const { runtime, skills, adapter } = makeAgent({ seed: 3, actionDelayMs: 100 });
  await runtime.connect();

  const result = await skills.run(
    "minecraft.orient",
    { yaw: 1, pitch: 0 },
    { timeoutMs: 10 },
  );
  assert.equal(result.action.status, "timed_out");
  assert.equal(result.action.failure?.code, "ACTION_TIMEOUT");
  assert.equal(adapter.status, "connected");
  assert.equal(result.observationAfter?.state.player.orientation.yaw, 0);

  await runtime.shutdown("test complete");
});

test("adapter failures are visible and do not turn into false success", async () => {
  const { runtime, skills, adapter } = makeAgent();
  await runtime.connect();
  adapter.failNextAction(new Error("simulated protocol failure"));

  const failed = await skills.run("minecraft.orient", { yaw: 0.5, pitch: 0 });
  assert.equal(failed.action.status, "failed");
  assert.match(failed.action.failure?.message ?? "", /simulated protocol failure/);
  assert.equal(adapter.status, "connected");

  const recovered = await skills.run("minecraft.orient", { yaw: 0.5, pitch: 0 });
  assert.equal(recovered.action.status, "succeeded");
  assert.equal(recovered.action.confirmed, true);
  await runtime.shutdown("test complete");
});

test("disconnection rejects new actions instead of attempting stale-session commands", async () => {
  const { runtime, skills, adapter, sink } = makeAgent();
  await runtime.connect();
  await adapter.disconnect("simulated network loss");

  const result = await skills.run("minecraft.orient", { yaw: 0.2, pitch: 0 });
  assert.equal(result.action.status, "disconnected");
  assert.equal(result.action.failure?.code, "NO_ACTIVE_SESSION");
  assert.ok(sink.events.some((event) => event.eventType === "adapter.disconnected"));
  await runtime.shutdown("test complete");
});

test("an in-flight action is aborted when the Minecraft session disconnects", async () => {
  const { runtime, skills, adapter } = makeAgent({ seed: 23, actionDelayMs: 1_000 });
  await runtime.connect();
  const pending = skills.run(
    "minecraft.orient",
    { yaw: 0.8, pitch: 0 },
    { timeoutMs: 5_000 },
  );
  await adapter.waitForActionStart();
  await adapter.disconnect("in-flight network loss");

  const result = await pending;
  assert.equal(result.action.status, "disconnected");
  assert.equal(result.action.failure?.code, "ADAPTER_DISCONNECTED");
  assert.equal(result.observationAfter, null);
  assert.equal(runtime.currentWorldState, null);
  await runtime.shutdown("test complete");
});

test("the action executor rejects concurrent action requests", async () => {
  const { runtime, adapter } = makeAgent({ seed: 9, actionDelayMs: 80 });
  await runtime.connect();
  const sessionId = runtime.session?.id ?? null;
  const first = runtime.actionExecutor.execute({
    sessionId,
    capability: "minecraft.look",
    input: { yaw: 0.7, pitch: 0 },
    source: "test",
  });
  const second = await runtime.actionExecutor.execute({
    sessionId,
    capability: "minecraft.look",
    input: { yaw: -0.7, pitch: 0 },
    source: "test",
  });
  assert.equal(second.status, "rejected");
  assert.equal(second.failure?.code, "ACTION_IN_PROGRESS");
  assert.equal((await first).status, "succeeded");
  assert.equal(adapter.status, "connected");
  await runtime.shutdown("test complete");
});
