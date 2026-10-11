/**
 * The shutdown signal hub: one SIGINT starts the clean shutdown; a duplicate that arrives right after it (the tsx wrapper
 * relays the same signal the process group already delivered) must not force-exit the agent; a deliberate second signal
 * later still does.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "pino";
import { DUPLICATE_SIGNAL_WINDOW_MS, processSignalHub } from "../src/app/run-app.js";

function fakeTarget() {
  const listeners = new Map<NodeJS.Signals, Array<(name: NodeJS.Signals) => void>>();
  return {
    on(name: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    off(name: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) {
      listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener));
    },
    emit(name: NodeJS.Signals) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(name);
    },
    count(name: NodeJS.Signals) {
      return (listeners.get(name) ?? []).length;
    },
  };
}

function quietLogger(): Logger {
  const noop = () => undefined;
  return { warn: noop, error: noop, info: noop, debug: noop } as unknown as Logger;
}

function harness() {
  let clock = 1_000_000;
  const exits: number[] = [];
  const target = fakeTarget();
  const hub = processSignalHub(quietLogger(), { now: () => clock, exit: (code) => exits.push(code), target, platform: "linux" });
  return {
    target,
    exits,
    advance(ms: number) {
      clock += ms;
    },
    hub,
  };
}

test("the first SIGINT starts the clean shutdown exactly once", () => {
  const h = harness();
  const reasons: string[] = [];
  h.hub.onShutdown((reason) => reasons.push(reason));
  h.target.emit("SIGINT");
  assert.deepEqual(reasons, ["SIGINT"]);
  assert.deepEqual(h.exits, []);
});

test("a duplicate SIGINT relayed right after the first one does not force-exit the agent", () => {
  const h = harness();
  const reasons: string[] = [];
  h.hub.onShutdown((reason) => reasons.push(reason));
  h.target.emit("SIGINT");
  h.advance(3);
  h.target.emit("SIGINT");
  h.advance(DUPLICATE_SIGNAL_WINDOW_MS - 10);
  h.target.emit("SIGTERM");
  assert.deepEqual(h.exits, [], "duplicates inside the window never exit");
  assert.deepEqual(reasons, ["SIGINT"], "and they do not start a second shutdown");
});

test("a deliberate second signal after the window still forces an immediate exit with code 130", () => {
  const h = harness();
  h.hub.onShutdown(() => undefined);
  h.target.emit("SIGINT");
  h.advance(DUPLICATE_SIGNAL_WINDOW_MS + 1);
  h.target.emit("SIGINT");
  assert.deepEqual(h.exits, [130]);
});

test("unregistering removes every listener it added", () => {
  const h = harness();
  const stop = h.hub.onShutdown(() => undefined);
  assert.equal(h.target.count("SIGINT"), 1);
  assert.equal(h.target.count("SIGTERM"), 1);
  assert.equal(h.target.count("SIGHUP"), 1);
  stop();
  assert.equal(h.target.count("SIGINT"), 0);
  assert.equal(h.target.count("SIGTERM"), 0);
  assert.equal(h.target.count("SIGHUP"), 0);
});
