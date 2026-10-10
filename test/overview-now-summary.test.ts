/** The one-line status at the top of the Session card: it must say what the agent does now, or why it does nothing. */
import assert from "node:assert/strict";
import test from "node:test";

const { nowSummary } = (await import(
  new URL("../src/control-center/public/lib/model.js", import.meta.url).href
)) as { nowSummary: (state: Record<string, unknown>) => string };

test("not connected, connecting and idle each say what the operator should do", () => {
  assert.match(nowSummary({ session: { state: "none" } }), /Nicht verbunden.*verbinde/);
  assert.match(nowSummary({ session: { state: "connecting" } }), /Verbindung zum Server/);
  assert.match(nowSummary({ session: { state: "idle" }, autonomyEnabled: false }), /Starte eine Aufgabe oder schalte die Autonomie ein/);
  assert.match(nowSummary({ session: { state: "idle" }, autonomyEnabled: true }), /Die Autonomie ist an/);
});

test("a running task names the task and the reason the planner gave", () => {
  const text = nowSummary({
    session: { state: "running" },
    scheduler: { active: { label: "Gather 2 oak_log" } },
    goal: { rationale: "Health is 20/20; moving toward the nearest log." },
  });
  assert.equal(text, "Arbeitet an: Gather 2 oak_log. Health is 20/20; moving toward the nearest log.");
});

test("a safety trip or pause overrides the session state, because it decides what runs", () => {
  assert.match(nowSummary({ session: { state: "running" }, safety: { tripped: true, paused: true } }), /Sicherheitsbremse ausgelöst/);
  assert.match(nowSummary({ session: { state: "idle" }, safety: { paused: true, pauseReason: "operator pause" } }), /Pausiert: operator pause/);
});

test("missing data never produces an invented state", () => {
  assert.equal(nowSummary({}), "Nicht verbunden. Trage im Bots-Tab Host und Port ein und verbinde dich.");
  assert.equal(nowSummary({ session: { state: "weird" } }), "Sitzungsstatus: weird.");
});
