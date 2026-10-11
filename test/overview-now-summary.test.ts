/** The one-line status at the top of the Session card: it must say what the agent does now, or why it does nothing. */
import assert from "node:assert/strict";
import test from "node:test";

const { nowSummary } = (await import(
  new URL("../src/control-center/public/lib/model.js", import.meta.url).href
)) as { nowSummary: (state: Record<string, unknown>) => string };

test("not connected, connecting and idle each say what the operator should do", () => {
  assert.match(nowSummary({ session: { state: "none" } }), /Not connected.*connect/);
  assert.match(nowSummary({ session: { state: "connecting" } }), /Connecting/);
  assert.match(nowSummary({ session: { state: "idle" }, autonomyEnabled: false }), /Start a task, or turn autonomy on/);
  assert.match(nowSummary({ session: { state: "idle" }, autonomyEnabled: true }), /Autonomy is on/);
});

test("a running task names the task and the reason the planner gave", () => {
  const text = nowSummary({
    session: { state: "running" },
    scheduler: { active: { label: "Gather 2 oak_log" } },
    goal: { rationale: "Health is 20/20; moving toward the nearest log." },
  });
  assert.equal(text, "Working on: Gather 2 oak_log. Health is 20/20; moving toward the nearest log.");
});

test("a safety trip or pause overrides the session state, because it decides what runs", () => {
  assert.match(nowSummary({ session: { state: "running" }, safety: { tripped: true, paused: true } }), /Safety stop raised/);
  assert.match(nowSummary({ session: { state: "idle" }, safety: { paused: true, pauseReason: "operator pause" } }), /Paused: operator pause/);
});

test("missing data never produces an invented state", () => {
  assert.equal(nowSummary({}), "Not connected. Enter a host and port on the Bots tab and connect.");
  assert.equal(nowSummary({ session: { state: "weird" } }), "Session state: weird.");
});
