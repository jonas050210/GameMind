import assert from "node:assert/strict";
import test from "node:test";
import { assessRLReadiness, RL_STEPS_PER_SECOND_TARGET } from "../src/core/learning/rl-readiness.js";

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

test("assessRLReadiness: evidence decides the criteria that cannot be probed, and nothing is assumed", () => {
  const unmeasured = assessRLReadiness();
  assert.ok(
    unmeasured.blockers.some((entry) => entry.includes("Fast training environment")),
    "without a measured throughput the environment is a blocker, not a given",
  );
  assert.ok(unmeasured.blockers.some((entry) => entry.includes("Action parameterisation")));

  const measured = assessRLReadiness({
    simulatorStepsPerSecond: RL_STEPS_PER_SECOND_TARGET,
    learnedAdvisorRegistered: true,
    rewardValidated: true,
    transferEvidence: true,
    liveVerificationRuns: 1,
  });
  assert.deepEqual(measured.blockers, []);
  assert.equal(measured.score, measured.maxScore);

  const tooSlow = assessRLReadiness({ simulatorStepsPerSecond: RL_STEPS_PER_SECOND_TARGET - 1 });
  assert.ok(tooSlow.blockers.some((entry) => entry.includes("Fast training environment")));
});
