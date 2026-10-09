import { conservativeSuccessRate, type SkillStat, type SkillStatistics } from "./skill-statistics.js";

/**
 * Learned policy weights. A weight multiplies a candidate's utility score; it never creates a goal,
 * never raises a priority band, and never unlocks a capability. That keeps learning expressive
 * enough to change *which* safe option is preferred while making it impossible for a statistic to
 * authorise a dangerous action.
 */

export const POLICY_WEIGHTS_VERSION = "gamemind-policy-weights-v1" as const;

export interface PolicyWeightConfig {
  /** Contexts with fewer attempts than this keep the neutral weight of 1.0. */
  readonly minSamples: number;
  readonly minWeight: number;
  readonly maxWeight: number;
  /** Success rate treated as "neutral performance". */
  readonly prior: number;
  /** How strongly a measured deviation moves the weight once evidence is sufficient. */
  readonly gain: number;
  /** Shrinkage constant: a context needs ~this many extra attempts to reach full strength. */
  readonly shrinkToNeutral: number;
  /** Each contradicted confirmation (a confirmation the world did not support) is punished hard. */
  readonly contradictionPenalty: number;
}

export const DEFAULT_POLICY_WEIGHT_CONFIG: PolicyWeightConfig = {
  minSamples: 8,
  minWeight: 0.75,
  maxWeight: 1.25,
  prior: 0.7,
  gain: 0.9,
  shrinkToNeutral: 12,
  contradictionPenalty: 0.08,
};

export interface PolicyWeightEntry {
  readonly weight: number;
  readonly samples: number;
  readonly evidence: number;
  readonly successRate: number;
}

export interface PolicyWeights {
  readonly version: typeof POLICY_WEIGHTS_VERSION;
  readonly id: string;
  readonly source: "baseline" | "experience";
  readonly generatedAt: string;
  readonly config: PolicyWeightConfig;
  readonly entries: Readonly<Record<string, PolicyWeightEntry>>;
  readonly provenance: {
    readonly episodes: number;
    readonly runs: number;
    readonly contexts: number;
    readonly contradictedConfirmations: number;
  };
}

export const BASELINE_POLICY_WEIGHTS: PolicyWeights = {
  version: POLICY_WEIGHTS_VERSION,
  id: "baseline-v1",
  source: "baseline",
  generatedAt: "1970-01-01T00:00:00.000Z",
  config: DEFAULT_POLICY_WEIGHT_CONFIG,
  entries: {},
  provenance: { episodes: 0, runs: 0, contexts: 0, contradictedConfirmations: 0 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function weightForStat(stat: SkillStat, config: PolicyWeightConfig): PolicyWeightEntry | null {
  if (stat.attempts < config.minSamples) return null;
  const evidence = conservativeSuccessRate(stat);
  const blend = stat.attempts / (stat.attempts + config.shrinkToNeutral);
  const raw = 1 + blend * config.gain * (evidence - config.prior) / Math.max(0.05, 1 - config.prior);
  const contradictionFactor = Math.max(
    0.5,
    1 - config.contradictionPenalty * stat.contradictedConfirmations,
  );
  const weight = clamp(raw * contradictionFactor, config.minWeight, config.maxWeight);
  const rounded = Math.round(weight * 1_000) / 1_000;
  if (Math.abs(rounded - 1) < 0.01) return null;
  return {
    weight: rounded,
    samples: stat.attempts,
    evidence: Math.round(evidence * 1_000) / 1_000,
    successRate: Math.round((stat.successes / stat.attempts) * 1_000) / 1_000,
  };
}

export function derivePolicyWeights(
  stats: SkillStatistics,
  options: {
    readonly config?: Partial<PolicyWeightConfig>;
    readonly episodes?: number;
    readonly runs?: number;
    readonly generatedAt?: string;
    readonly id?: string;
  } = {},
): PolicyWeights {
  const config = { ...DEFAULT_POLICY_WEIGHT_CONFIG, ...(options.config ?? {}) };
  const entries: Record<string, PolicyWeightEntry> = {};
  let contradicted = 0;
  for (const [key, stat] of Object.entries(stats)) {
    contradicted += stat.contradictedConfirmations;
    const entry = weightForStat(stat, config);
    if (entry) entries[key] = entry;
  }
  const keys = Object.keys(entries).sort();
  const fingerprint = keys
    .map((key) => `${key}:${entries[key]?.weight ?? 1}`)
    .join(";");
  return {
    version: POLICY_WEIGHTS_VERSION,
    id:
      options.id ??
      (keys.length === 0
        ? "baseline-v1"
        : `learned-${keys.length}-${hash32(fingerprint).toString(16)}`),
    source: keys.length === 0 ? "baseline" : "experience",
    generatedAt: options.generatedAt ?? new Date(0).toISOString(),
    config,
    entries,
    provenance: {
      episodes: options.episodes ?? 0,
      runs: options.runs ?? 0,
      contexts: keys.length,
      contradictedConfirmations: contradicted,
    },
  };
}

function hash32(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_645_25) >>> 0;
  }
  return hash >>> 0;
}

export function policyWeightsEqual(left: PolicyWeights, right: PolicyWeights): boolean {
  if (left.id !== right.id) return false;
  const leftKeys = Object.keys(left.entries).sort();
  const rightKeys = Object.keys(right.entries).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] && left.entries[key]?.weight === right.entries[key]?.weight,
  );
}

export function parsePolicyWeights(value: unknown): PolicyWeights | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<PolicyWeights>;
  if (raw.version !== POLICY_WEIGHTS_VERSION || typeof raw.id !== "string") return null;
  const entries: Record<string, PolicyWeightEntry> = {};
  for (const [key, entry] of Object.entries(raw.entries ?? {})) {
    if (typeof entry?.weight !== "number" || !Number.isFinite(entry.weight)) continue;
    if (entry.weight < 0.1 || entry.weight > 4) continue;
    entries[key] = {
      weight: entry.weight,
      samples: Number.isFinite(entry.samples) ? entry.samples : 0,
      evidence: Number.isFinite(entry.evidence) ? entry.evidence : 0,
      successRate: Number.isFinite(entry.successRate) ? entry.successRate : 0,
    };
  }
  return {
    version: POLICY_WEIGHTS_VERSION,
    id: raw.id,
    source: raw.source === "experience" ? "experience" : "baseline",
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date(0).toISOString(),
    config: { ...DEFAULT_POLICY_WEIGHT_CONFIG, ...(raw.config ?? {}) },
    entries,
    provenance: {
      episodes: raw.provenance?.episodes ?? 0,
      runs: raw.provenance?.runs ?? 0,
      contexts: Object.keys(entries).length,
      contradictedConfirmations: raw.provenance?.contradictedConfirmations ?? 0,
    },
  };
}

export function describeWeights(weights: PolicyWeights): readonly string[] {
  return Object.entries(weights.entries)
    .sort((left, right) => right[1].weight - left[1].weight || left[0].localeCompare(right[0]))
    .map(
      ([key, entry]) =>
        `${key} → ×${entry.weight.toFixed(3)} (${entry.samples} attempts, evidence ${(
          entry.evidence * 100
        ).toFixed(0)}%)`,
    );
}
