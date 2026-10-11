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

test("a trace event recorded after the recorder was closed never reaches the sink", async () => {
  // Shutdown closes the recorder (and with it the JSONL log). A late observation used to be handed to the closed
  // sink anyway; the event is dropped now, with a warning, instead of resurrecting the log or failing a shutdown step.
  const logs = captureLogger("info");
  const sink = new RingBufferTraceSink(50);
  const recorder = new TraceRecorder(sink, logs.logger);
  await recorder.record({ eventType: "session.started", sessionId: "session-1" });
  await recorder.close();
  await recorder.close(); // idempotent: the runtime calls it from its shutdown path
  await recorder.record({ eventType: "observation.received", sessionId: "session-1" });

  assert.deepEqual(sink.recent.map((event) => event.eventType), ["session.started"], "the sink stays closed");
  assert.ok(logs.lines.some((line) => /after the recorder was closed/.test(line)), "the drop is reported");
});

test("a sink that cannot close does not keep the other sinks open", async () => {
  const logs = captureLogger("info");
  const closed: string[] = [];
  const stubborn = {
    write: async () => undefined,
    close: async () => {
      throw new Error("sink refused to close");
    },
  };
  const cooperating = {
    write: async () => undefined,
    close: async () => {
      closed.push("cooperating");
    },
  };
  const { FanOutTraceSink } = await import("../src/core/trace.js");
  const recorder = new TraceRecorder(new FanOutTraceSink([stubborn, cooperating], logs.logger), logs.logger);
  await recorder.record({ eventType: "session.started" });
  await recorder.close();
  assert.deepEqual(closed, ["cooperating"], "every sink is closed even when an earlier one throws");
});
