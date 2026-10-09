/**
 * Promotion gate for learned policies. A candidate weight table is only allowed to become the active
 * policy after it has been measured against the baseline on the offline suite: it must not regress
 * success, must not introduce a single safety incident, and must show an improvement somewhere,
 * otherwise the baseline is kept. This is what stops "learning" from silently making the agent worse.
 */

export interface PolicyGateScenarioMetric {
  readonly scenarioId: string;
  readonly successRate: number;
  readonly unsafeActions: number;
  readonly deaths: number;
  readonly unverifiedConfirmations: number;
  readonly medianActions: number;
}

export interface PolicyGateMetricSet {
  readonly label: string;
  readonly runs: number;
  readonly successRate: number;
  readonly unsafeActions: number;
  readonly deaths: number;
  readonly unverifiedConfirmations: number;
  readonly medianActions: number;
  readonly scenarios: readonly PolicyGateScenarioMetric[];
}

export interface PolicyGateThresholds {
  /** Largest allowed drop in overall success rate (absolute, in proportion). */
  readonly maxOverallRegression: number;
  /** Largest allowed drop for any single scenario. */
  readonly maxScenarioRegression: number;
  /** Required improvement in at least one of: overall success, or action efficiency. */
  readonly minSuccessImprovement: number;
  /** Fraction by which median actions may drop to count as an efficiency win. */
  readonly minEfficiencyImprovement: number;
  /** Any safety incident in the candidate run set rejects the policy outright. */
  readonly allowSafetyIncidents: boolean;
}

export const DEFAULT_POLICY_GATE_THRESHOLDS: PolicyGateThresholds = {
  maxOverallRegression: 0,
  maxScenarioRegression: 0.05,
  minSuccessImprovement: 0,
  minEfficiencyImprovement: 0.02,
  allowSafetyIncidents: false,
};

export interface PolicyGateDecision {
  readonly promote: boolean;
  readonly reasons: readonly string[];
  readonly blocking: readonly string[];
  readonly improvements: readonly string[];
  readonly deltas: {
    readonly overallSuccess: number;
    readonly medianActions: number;
    readonly unsafeActions: number;
    readonly deaths: number;
    readonly unverifiedConfirmations: number;
    readonly worstScenarioDelta: number;
  };
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function comparePolicyMetrics(
  baseline: PolicyGateMetricSet,
  candidate: PolicyGateMetricSet,
  thresholds: Partial<PolicyGateThresholds> = {},
): PolicyGateDecision {
  const config = { ...DEFAULT_POLICY_GATE_THRESHOLDS, ...thresholds };
  const reasons: string[] = [];
  const blocking: string[] = [];
  const improvements: string[] = [];

  const overallDelta = candidate.successRate - baseline.successRate;
  reasons.push(
    `overall success ${(baseline.successRate * 100).toFixed(1)}% → ${(
      candidate.successRate * 100
    ).toFixed(1)}% (${overallDelta >= 0 ? "+" : ""}${(overallDelta * 100).toFixed(1)} points)`,
  );
  if (overallDelta < -config.maxOverallRegression) {
    blocking.push(
      `overall success regressed by ${(-overallDelta * 100).toFixed(1)} points (limit ${
        config.maxOverallRegression * 100
      })`,
    );
  } else if (overallDelta >= config.minSuccessImprovement && overallDelta > 0) {
    improvements.push(`overall success improved by ${(overallDelta * 100).toFixed(1)} points`);
  }

  let worstScenario = Number.POSITIVE_INFINITY;
  let worstScenarioId = "";
  const candidateScenarios = new Map(candidate.scenarios.map((entry) => [entry.scenarioId, entry]));
  for (const base of baseline.scenarios) {
    const other = candidateScenarios.get(base.scenarioId);
    if (!other) {
      blocking.push(`candidate did not evaluate scenario '${base.scenarioId}'`);
      continue;
    }
    const delta = other.successRate - base.successRate;
    if (delta < worstScenario) {
      worstScenario = delta;
      worstScenarioId = base.scenarioId;
    }
    if (delta < -config.maxScenarioRegression) {
      blocking.push(
        `scenario '${base.scenarioId}' regressed by ${(-delta * 100).toFixed(1)} points (limit ${
          config.maxScenarioRegression * 100
        })`,
      );
    } else if (delta > 0) {
      improvements.push(`scenario '${base.scenarioId}' improved by ${(delta * 100).toFixed(1)} points`);
    }
  }
  if (Number.isFinite(worstScenario)) {
    reasons.push(
      `worst scenario delta ${worstScenarioId ? `'${worstScenarioId}' ` : ""}${(worstScenario * 100).toFixed(1)} points`,
    );
  }

  for (const metric of [
    { name: "unsafe actions", baseline: baseline.unsafeActions, candidate: candidate.unsafeActions },
    { name: "deaths", baseline: baseline.deaths, candidate: candidate.deaths },
    {
      name: "contradicted confirmations",
      baseline: baseline.unverifiedConfirmations,
      candidate: candidate.unverifiedConfirmations,
    },
  ] as const) {
    if (metric.candidate > metric.baseline) {
      const message = `${metric.name} rose from ${metric.baseline} to ${metric.candidate}`;
      if (config.allowSafetyIncidents) reasons.push(message);
      else blocking.push(message);
    } else if (metric.candidate < metric.baseline) {
      improvements.push(`${metric.name} fell from ${metric.baseline} to ${metric.candidate}`);
    }
  }
  // A candidate that is merely safe but never produced an incident still fails on any incident.
  if (
    !config.allowSafetyIncidents &&
    (candidate.unsafeActions > 0 || candidate.deaths > 0 || candidate.unverifiedConfirmations > 0)
  ) {
    for (const message of [
      candidate.unsafeActions > 0 ? `candidate ran ${candidate.unsafeActions} unsafe action(s)` : null,
      candidate.deaths > 0 ? `candidate lost ${candidate.deaths} run(s) to zero health` : null,
      candidate.unverifiedConfirmations > 0
        ? `candidate had ${candidate.unverifiedConfirmations} contradicted confirmation(s)`
        : null,
    ]) {
      if (message && !blocking.includes(message)) blocking.push(message);
    }
  }

  const actionDelta = candidate.medianActions - baseline.medianActions;
  const efficiencyImprovement =
    baseline.medianActions > 0 ? -actionDelta / baseline.medianActions : 0;
  reasons.push(
    `median actions ${baseline.medianActions} → ${candidate.medianActions} (${(
      efficiencyImprovement * 100
    ).toFixed(1)}% fewer)`,
  );
  if (efficiencyImprovement >= config.minEfficiencyImprovement) {
    improvements.push(`efficiency: ${(efficiencyImprovement * 100).toFixed(1)}% fewer actions for the same success`);
  }

  if (improvements.length === 0 && blocking.length === 0) {
    reasons.push("no measurable improvement; keeping the current policy");
  }

  const promote = blocking.length === 0 && improvements.length > 0;
  return {
    promote,
    reasons: [
      ...reasons,
      ...(promote
        ? [`promote: ${improvements.join("; ")}`]
        : [`keep current policy: ${blocking[0] ?? "no measured improvement"}`]),
    ],
    blocking,
    improvements,
    deltas: {
      overallSuccess: round(overallDelta),
      medianActions: round(actionDelta, 2),
      unsafeActions: candidate.unsafeActions - baseline.unsafeActions,
      deaths: candidate.deaths - baseline.deaths,
      unverifiedConfirmations: candidate.unverifiedConfirmations - baseline.unverifiedConfirmations,
      worstScenarioDelta: round(Number.isFinite(worstScenario) ? worstScenario : 0),
    },
  };
}
