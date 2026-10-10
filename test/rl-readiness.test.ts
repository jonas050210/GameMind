import assert from "node:assert/strict";
import test from "node:test";
import { assessRLReadiness } from "../src/core/learning/rl-readiness.js";

test("assessRLReadiness: returns score within range", () => {
  const assessment = assessRLReadiness();
  assert.ok(assessment.score >= 0);
  assert.ok(assessment.score <= assessment.maxScore);
});

test("assessRLReadiness: identifies met prerequisites", () => {
  const assessment = assessRLReadiness();
  assert.ok(assessment.ready.length > 0);
  assert.ok(assessment.ready.includes("Continuous state representation"));
  assert.ok(assessment.ready.includes("Reward function"));
  assert.ok(assessment.ready.includes("Safety broker integration"));
});

test("assessRLReadiness: identifies unmet blockers", () => {
  const assessment = assessRLReadiness();
  assert.ok(assessment.blockers.length > 0);
  const blockerText = assessment.blockers.join(" ");
  assert.ok(blockerText.includes("Fast training environment"));
  assert.ok(blockerText.includes("Sim-to-real transfer"));
});

test("assessRLReadiness: has maxScore of 100", () => {
  const assessment = assessRLReadiness();
  assert.equal(assessment.maxScore, 100);
});
