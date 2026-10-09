export interface PolicyPromotionReport {
  readonly generatedAt: string | null;
  readonly passed: boolean | null;
  readonly unsafeActions: number | null;
  readonly policyCandidateId: string | null;
  readonly policyPromotable: boolean | null;
  readonly policyGateReasons: readonly string[];
  readonly seedsPerScenario: number | null;
  readonly scenarioIds: readonly string[];
}

export interface PolicyPromotionEvidence {
  readonly episodes: number;
  readonly candidateContexts: number;
  readonly contradictedConfirmations: number;
  readonly candidateWeightsId: string;
}

/**
 * Shared CLI and Control Center promotion gate. A policy is only live after the exact derived table
 * has passed a current, complete, same-seed offline comparison; collecting episodes alone is never
 * sufficient evidence.
 */
export function policyPromotionRefusalReasons(
  evidence: PolicyPromotionEvidence,
  report: PolicyPromotionReport,
  expectedScenarioIds: readonly string[],
  minSeedsPerScenario = 20,
): string[] {
  const problems: string[] = [];
  if (!report.generatedAt) {
    problems.push("there is no offline evaluation report; run 'npm run eval:offline' first");
  } else if (report.passed !== true) {
    problems.push(`the last offline evaluation did not pass (unsafe actions: ${report.unsafeActions ?? "unknown"})`);
  }
  if (evidence.episodes === 0) problems.push("no episodes have been recorded, so there is no candidate to promote");
  if (evidence.candidateContexts === 0) {
    problems.push("the derived candidate is still the baseline: no context reached the sample threshold, so promotion would change nothing");
  }
  if (report.policyCandidateId !== evidence.candidateWeightsId) {
    problems.push("the offline report did not evaluate the current candidate weight table; rerun 'npm run eval:offline'");
  }
  if (report.policyPromotable !== true) {
    problems.push(`the candidate weight comparison did not pass its promotion gate${report.policyGateReasons.length ? ` (${report.policyGateReasons.join("; ")})` : ""}`);
  }
  if ((report.seedsPerScenario ?? 0) < minSeedsPerScenario) {
    problems.push(`promotion requires at least ${minSeedsPerScenario} seeds per scenario; the report used ${report.seedsPerScenario ?? 0}`);
  }
  const expected = [...expectedScenarioIds].sort();
  const actual = [...report.scenarioIds].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    problems.push(`promotion requires the complete current scenario set (${expected.length} scenarios)`);
  }
  if (evidence.contradictedConfirmations > 0) {
    problems.push(`${evidence.contradictedConfirmations} confirmation(s) were contradicted by the world`);
  }
  return problems;
}
