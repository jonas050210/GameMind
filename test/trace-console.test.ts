/**
 * The trace is the record of everything the agent saw and did; the console is what an operator reads while a
 * persistent session idles for hours. An observation arrives twice a second, so printing each one at the default
 * level would bury every decision, action and error that matters. These tests pin the split: every event is traced at
 * every log level, and only the per-tick observation moves to `debug` on the console.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RingBufferTraceSink, TraceRecorder } from "../src/core/trace.js";
import { captureLogger } from "./support/lifecycle-fixture.js";

async function record(level: "info" | "debug" | "warn", events: readonly string[]) {
  const logs = captureLogger(level);
  const sink = new RingBufferTraceSink(50);
  const recorder = new TraceRecorder(sink, logs.logger);
  for (const eventType of events) await recorder.record({ eventType, sessionId: "session-1" });
  return {
    traced: sink.recent.map((event) => event.eventType),
    printed: logs.lines.map((line) => (JSON.parse(line) as { eventType?: string }).eventType),
  };
}

const EVENTS = ["observation.received", "decision.made", "observation.received", "action.failed", "observation.received"];

test("at the default level the console shows what happened, not that an observation arrived, and the trace keeps both", async () => {
  const { traced, printed } = await record("info", EVENTS);
  assert.deepEqual(traced, EVENTS, "every event is in the trace");
  assert.deepEqual(printed, ["decision.made", "action.failed"], "decisions and failures are on the console; per-tick observations are not");
});

test("debug level prints the observations as well, so the old firehose is one setting away", async () => {
  const { traced, printed } = await record("debug", EVENTS);
  assert.deepEqual(traced, EVENTS);
  assert.deepEqual(printed, EVENTS);
});

test("a quieter level hides nothing from the trace", async () => {
  const { traced, printed } = await record("warn", EVENTS);
  assert.deepEqual(traced, EVENTS, "the trace does not depend on the log level");
  assert.deepEqual(printed, [], "trace lines are informational, so a warn-level console prints none of them");
});
