import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import pino from "pino";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { FakeMinecraftAdapter } from "../src/testing/fake-minecraft-adapter.js";
import { loadScenario } from "../src/testing/scenario.js";
import { ScenarioRunner } from "../src/testing/scenario-runner.js";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";

test("deterministic scenario exercises observation → skill → validated action → confirmation → post-state", async () => {
  const scenario = await loadScenario(resolve("scenarios/minecraft-look-roundtrip.json"));
  const logger = pino({ level: "silent" });
  const sink = new MemoryTraceSink();
  const trace = new TraceRecorder(sink, logger);
  const adapter = new FakeMinecraftAdapter({ seed: scenario.seed });
  const { runtime, skills } = createMinecraftAgent(adapter, trace, logger);

  const report = await new ScenarioRunner(runtime, skills).run(scenario);

  assert.equal(report.scenarioId, "minecraft-look-roundtrip");
  assert.equal(report.seed, 1337);
  assert.equal(report.stepsCompleted, 3);
  assert.equal(report.steps[1]?.status, "succeeded");
  assert.equal(report.steps[1]?.confirmed, true);
  assert.equal(adapter.status, "disconnected");
  assert.equal(
    (report.finalState as { player: { orientation: { yaw: number } } }).player.orientation.yaw,
    Math.PI / 2,
  );

  const eventTypes = sink.events.map((event) => event.eventType);
  for (const eventType of [
    "session.started",
    "observation.received",
    "scenario.started",
    "skill.started",
    "action.requested",
    "action.started",
    "action.succeeded",
    "skill.completed",
    "scenario.completed",
    "session.stopped",
  ]) {
    assert.ok(eventTypes.includes(eventType), `expected trace event '${eventType}'`);
  }
  assert.equal(eventTypes.filter((eventType) => eventType === "action.requested").length, 1);
});

test("trace data is redacted and events persist in call order", async () => {
  const logger = pino({ level: "silent" });
  const sink = new MemoryTraceSink();
  const trace = new TraceRecorder(sink, logger);
  await Promise.all([
    trace.record({ eventType: "first", data: { password: "do-not-store", safe: "visible" } }),
    trace.record({ eventType: "second" }),
  ]);
  await trace.close();

  assert.deepEqual(sink.events.map((event) => event.eventType), ["first", "second"]);
  assert.equal(sink.events[0]?.data.password, "[REDACTED]");
  assert.equal(sink.events[0]?.data.safe, "visible");
});
