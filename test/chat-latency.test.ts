import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_TARGETS, ChatLatencyMetrics, chatLatencyBreaches, type ChatLatencySample } from "../src/games/minecraft/chat-latency.js";

/** A clock the test moves by hand, so a latency assertion never depends on how fast the machine is. */
function fakeClock(startMs = 1_000): { readonly now: () => number; readonly advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

function sampleOf(metrics: ChatLatencyMetrics, timedOut = false): ChatLatencySample | null {
  const timing = metrics.messageReceived();
  metrics.handlingStarted(timing);
  return metrics.handlingFinished(timing, { timedOut });
}

test("a handled message reports its queue wait, handling time and first reply", () => {
  const clock = fakeClock();
  const metrics = new ChatLatencyMetrics(clock.now);
  const timing = metrics.messageReceived();
  clock.advance(120); // waiting behind an earlier message
  metrics.handlingStarted(timing);
  clock.advance(40);
  metrics.replySent(timing); // the first chat line goes out
  clock.advance(10);
  metrics.replySent(timing); // a second line of the same answer is not a second reply
  clock.advance(30);
  const sample = metrics.handlingFinished(timing);

  assert.deepEqual(sample, { queueWaitMs: 120, handleMs: 80, firstReplyMs: 160, responderMs: null, timedOut: false });
  assert.deepEqual(metrics.summary().messages, { received: 1, ignored: 0, handled: 1, timedOut: 0, answered: 1 });
  assert.equal(metrics.summary().firstReplyMs.count, 1, "one answer counts once however many lines it needs");
  assert.equal(metrics.summary().last, sample);
});

test("a dropped message costs nothing and is counted separately from a slow answer", () => {
  const metrics = new ChatLatencyMetrics(fakeClock().now);
  metrics.messageIgnored();
  metrics.messageIgnored();

  assert.deepEqual(metrics.summary().messages, { received: 0, ignored: 2, handled: 0, timedOut: 0, answered: 0 });
  assert.equal(metrics.summary().queueWaitMs.count, 0);
  assert.equal(metrics.summary().last, null);
});

test("an abandoned message is counted as a timeout, never as handled", () => {
  const clock = fakeClock();
  const metrics = new ChatLatencyMetrics(clock.now);
  const timing = metrics.messageReceived();
  metrics.handlingStarted(timing);
  clock.advance(CHAT_TARGETS.handleP95Ms + 1);
  const sample = metrics.handlingFinished(timing, { timedOut: true });

  assert.ok(sample);
  assert.equal(sample.timedOut, true);
  assert.equal(sample.handleMs, CHAT_TARGETS.handleP95Ms + 1);
  assert.deepEqual(metrics.summary().messages, { received: 1, ignored: 0, handled: 0, timedOut: 1, answered: 0 });
  const breaches = chatLatencyBreaches(sample);
  assert.equal(breaches.length, 2, "the abandonment and the handling time it took are both named");
  assert.ok(breaches.some((breach) => /abandoned/.test(breach)));
  assert.ok(breaches.some((breach) => breach.includes(`handling ${CHAT_TARGETS.handleP95Ms + 1} ms`)));
});

test("handling that never started yields no duration but still counts the message", () => {
  const metrics = new ChatLatencyMetrics(fakeClock().now);
  const timing = metrics.messageReceived();

  assert.equal(metrics.handlingFinished(timing), null);
  assert.equal(metrics.summary().messages.handled, 1);
  assert.equal(metrics.summary().handleMs.count, 0);
  assert.equal(metrics.summary().queueWaitMs.count, 0);
});

test("the optional local model is measured in its own window", () => {
  const clock = fakeClock();
  const metrics = new ChatLatencyMetrics(clock.now);
  const timing = metrics.messageReceived();
  metrics.handlingStarted(timing);
  metrics.recordResponder(timing, 2_500);
  metrics.replySent(timing);
  const sample = metrics.handlingFinished(timing);

  assert.equal(sample?.responderMs, 2_500);
  assert.equal(metrics.summary().responderMs.p50Ms, 2_500);
  assert.equal(metrics.summary().responderMs.count, 1);
});

test("a message answered without the queue still reports a wait of zero", () => {
  const clock = fakeClock();
  const metrics = new ChatLatencyMetrics(clock.now);
  const timing = metrics.messageReceived();
  metrics.handlingStarted(timing);
  metrics.replySent(timing);
  const sample = metrics.handlingFinished(timing);

  assert.equal(sample?.queueWaitMs, 0);
  assert.deepEqual(chatLatencyBreaches(sample ?? { queueWaitMs: null, handleMs: null, firstReplyMs: null, responderMs: null, timedOut: false }), []);
});

test("targets are unknown before the first sample and compare p95 against the documented budget", () => {
  const clock = fakeClock();
  const empty = new ChatLatencyMetrics(clock.now);
  assert.deepEqual(empty.summary().targets.map((target) => target.met), [null, null, null, null]);

  const slow = new ChatLatencyMetrics(clock.now);
  const timing = slow.messageReceived();
  clock.advance(CHAT_TARGETS.queueWaitP95Ms + 1);
  slow.handlingStarted(timing);
  clock.advance(CHAT_TARGETS.firstReplyP95Ms);
  slow.replySent(timing);
  slow.handlingFinished(timing);

  const [queueWait, handle, firstReply, responder] = slow.summary().targets;
  assert.equal(queueWait?.met, false, "a wait over the target is reported as missed");
  assert.equal(handle?.met, true, "handling stayed inside its budget");
  assert.equal(firstReply?.met, false);
  assert.equal(responder?.met, null, "no model answer happened, so nothing is claimed about it");
  assert.deepEqual(
    slow.summary().targets.map((target) => target.targetMs),
    [CHAT_TARGETS.queueWaitP95Ms, CHAT_TARGETS.handleP95Ms, CHAT_TARGETS.firstReplyP95Ms, CHAT_TARGETS.responderP95Ms],
  );
  assert.ok(slow.summary().targets.every((target) => target.label.length > 0));
});

test("the sample windows stay bounded and keep percentiles over many messages", () => {
  const clock = fakeClock();
  const metrics = new ChatLatencyMetrics(clock.now);
  for (let index = 0; index < 400; index += 1) {
    const timing = metrics.messageReceived();
    metrics.handlingStarted(timing);
    clock.advance(index % 10 === 0 ? 500 : 10);
    metrics.replySent(timing);
    metrics.handlingFinished(timing);
  }
  const summary = metrics.summary();
  assert.equal(summary.messages.received, 400);
  assert.equal(summary.messages.handled, 400);
  assert.equal(summary.handleMs.count, 400, "the lifetime count survives the fixed-capacity window");
  assert.ok((summary.handleMs.p95Ms ?? 0) >= (summary.handleMs.p50Ms ?? 0));
});

test("a negative clock step cannot produce a negative duration", () => {
  const clock = fakeClock();
  const metrics = new ChatLatencyMetrics(clock.now);
  const timing = metrics.messageReceived();
  clock.advance(-500); // a clock adjustment backwards must not invent negative latency
  metrics.handlingStarted(timing);
  metrics.replySent(timing);
  const sample = metrics.handlingFinished(timing);

  assert.equal(sample?.queueWaitMs, 0);
  assert.equal(sample?.firstReplyMs, 0);
  assert.equal(sampleOf(metrics)?.handleMs, 0);
});
