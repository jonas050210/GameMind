import assert from "node:assert/strict";
import test from "node:test";
import {
  policyPromotionRefusalReasons,
  type PolicyPromotionEvidence,
  type PolicyPromotionReport,
} from "../src/games/minecraft/policy-promotion.js";

const expectedScenarioIds = ["food", "recovery"];
const evidence: PolicyPromotionEvidence = {
  episodes: 80,
  candidateContexts: 3,
  contradictedConfirmations: 0,
  candidateWeightsId: "learned-candidate-v7",
};
const report: PolicyPromotionReport = {
  generatedAt: "2026-10-09T12:00:00.000Z",
  passed: true,
  unsafeActions: 0,
  policyCandidateId: evidence.candidateWeightsId,
  policyPromotable: true,
  policyGateReasons: [],
  seedsPerScenario: 20,
  scenarioIds: expectedScenarioIds,
};

test("promotion accepts only a matching, passing full-set candidate comparison", () => {
  assert.deepEqual(policyPromotionRefusalReasons(evidence, report, expectedScenarioIds), []);

  const insufficientSeeds = policyPromotionRefusalReasons(
    evidence,
    { ...report, seedsPerScenario: 19 },
    expectedScenarioIds,
  );
  assert.ok(insufficientSeeds.some((reason) => reason.includes("at least 20 seeds")));

  const partial = policyPromotionRefusalReasons(evidence, { ...report, scenarioIds: ["food"] }, expectedScenarioIds);
  assert.ok(partial.some((reason) => reason.includes("complete current scenario set")));
});

test("promotion refuses absent episodes, ineffective or stale candidates, failed gates, and contradicted evidence", () => {
  const problems = policyPromotionRefusalReasons(
    { ...evidence, episodes: 0, candidateContexts: 0, contradictedConfirmations: 1 },
    {
      ...report,
      generatedAt: null,
      passed: false,
      policyCandidateId: "different-candidate",
      policyPromotable: false,
      policyGateReasons: ["unsafe action increased"],
    },
    expectedScenarioIds,
  );
  assert.ok(problems.some((reason) => reason.includes("no offline evaluation report")));
  assert.ok(problems.some((reason) => reason.includes("no episodes have been recorded")));
  assert.ok(problems.some((reason) => reason.includes("still the baseline")));
  assert.ok(problems.some((reason) => reason.includes("did not evaluate the current candidate")));
  assert.ok(problems.some((reason) => reason.includes("unsafe action increased")));
  assert.ok(problems.some((reason) => reason.includes("confirmation(s) were contradicted")));
});
