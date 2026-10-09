import { episodeContextKey, type Episode, type EpisodeFeatures } from "./episode.js";

/**
 * Incremental statistics over experience, keyed by a coarse context key. Everything here is a pure
 * fold over episodes: the same log always produces the same numbers, which is what makes a learned
 * policy reproducible and reviewable instead of opaque.
 */

export const SKILL_STAT_VERSION = "gamemind-skill-stats-v1" as const;

export interface SkillStat {
  attempts: number;
  successes: number;
  progressCount: number;
  contradictedConfirmations: number;
  safetyDenials: number;
  failureCodes: Record<string, number>;
  /** Exponentially weighted mean action duration in ms. */
  ewmaDurationMs: number;
  /** Exponentially weighted mean of the mean observed gain (items + hunger + health). */
  ewmaGain: number;
  totalDistance: number;
  distanceSamples: number;
  lastSequence: number;
}

export type SkillStatistics = Readonly<Record<string, SkillStat>>;

const DURATION_EWMA_ALPHA = 0.25;
const GAIN_EWMA_ALPHA = 0.25;

function emptyStat(): SkillStat {
  return {
    attempts: 0,
    successes: 0,
    progressCount: 0,
    contradictedConfirmations: 0,
    safetyDenials: 0,
    failureCodes: {},
    ewmaDurationMs: 0,
    ewmaGain: 0,
    totalDistance: 0,
    distanceSamples: 0,
    lastSequence: 0,
  };
}

export function episodeGain(episode: Episode): number {
  return (
    Math.max(0, episode.outcome.itemsGained) +
    Math.max(0, episode.outcome.foodDelta) +
    Math.max(0, episode.outcome.healthDelta)
  );
}

function updateStat(stat: SkillStat, episode: Episode): SkillStat {
  const { outcome, features } = episode;
  const success = outcome.status === "succeeded" && outcome.confirmed;
  const gain = episodeGain(episode);
  const failureCodes = { ...stat.failureCodes };
  if (!success && outcome.failureCode) {
    failureCodes[outcome.failureCode] = (failureCodes[outcome.failureCode] ?? 0) + 1;
  }
  const attempts = stat.attempts + 1;
  return {
    attempts,
    successes: stat.successes + (success ? 1 : 0),
    progressCount: stat.progressCount + (outcome.progress ? 1 : 0),
    contradictedConfirmations:
      stat.contradictedConfirmations + (outcome.verified === false ? 1 : 0),
    safetyDenials: stat.safetyDenials + (outcome.safetyDenied ? 1 : 0),
    failureCodes,
    ewmaDurationMs:
      stat.attempts === 0
        ? outcome.durationMs
        : DURATION_EWMA_ALPHA * outcome.durationMs + (1 - DURATION_EWMA_ALPHA) * stat.ewmaDurationMs,
    ewmaGain: stat.attempts === 0 ? gain : GAIN_EWMA_ALPHA * gain + (1 - GAIN_EWMA_ALPHA) * stat.ewmaGain,
    totalDistance: stat.totalDistance + (Number.isFinite(features.distance) ? features.distance : 0),
    distanceSamples: stat.distanceSamples + (Number.isFinite(features.distance) ? 1 : 0),
    lastSequence: Math.max(stat.lastSequence, episode.sequence),
  };
}

export function foldEpisodes(episodes: readonly Episode[]): SkillStatistics {
  const stats: Record<string, SkillStat> = {};
  for (const episode of episodes) {
    const key = episodeContextKey(episode.features);
    stats[key] = updateStat(stats[key] ?? emptyStat(), episode);
  }
  return stats;
}

export interface StatSummary {
  readonly key: string;
  readonly attempts: number;
  readonly successes: number;
  readonly successRate: number;
  readonly progressRate: number;
  readonly contradictedConfirmations: number;
  readonly safetyDenials: number;
  readonly meanDurationMs: number;
  readonly meanGain: number;
  readonly meanDistance: number | null;
  readonly topFailureCode: string | null;
}

export function summariseStats(stats: SkillStatistics): StatSummary[] {
  return Object.entries(stats)
    .map(([key, stat]) => {
      const failureEntries = Object.entries(stat.failureCodes).sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      );
      return {
        key,
        attempts: stat.attempts,
        successes: stat.successes,
        successRate: smoothedSuccessRate(stat),
        progressRate: stat.attempts === 0 ? 0 : stat.progressCount / stat.attempts,
        contradictedConfirmations: stat.contradictedConfirmations,
        safetyDenials: stat.safetyDenials,
        meanDurationMs: Math.round(stat.ewmaDurationMs),
        meanGain: Math.round(stat.ewmaGain * 100) / 100,
        meanDistance:
          stat.distanceSamples === 0 ? null : Math.round((stat.totalDistance / stat.distanceSamples) * 10) / 10,
        topFailureCode: failureEntries[0]?.[0] ?? null,
      };
    })
    .sort((left, right) => right.attempts - left.attempts || left.key.localeCompare(right.key));
}

/** Laplace-smoothed success rate, so a single lucky attempt never looks like certainty. */
export function smoothedSuccessRate(stat: SkillStat, prior = 0.5): number {
  const pseudo = 2;
  return (stat.successes + prior * pseudo) / (stat.attempts + pseudo);
}

/** Wilson score interval lower bound at ~68% confidence; conservative estimate of true success rate. */
export function conservativeSuccessRate(stat: SkillStat): number {
  const n = stat.attempts;
  if (n === 0) return 0.5;
  const p = stat.successes / n;
  const z = 1;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denominator);
}

export function contextKeyFor(features: EpisodeFeatures): string {
  return episodeContextKey(features);
}

export function emptySkillStatistics(): SkillStatistics {
  return {};
}

export function parseSkillStatistics(value: unknown): SkillStatistics {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, SkillStat> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const stat = raw as Partial<SkillStat>;
    if (typeof stat.attempts !== "number" || typeof stat.successes !== "number") continue;
    result[key] = {
      attempts: stat.attempts,
      successes: stat.successes,
      progressCount: numberOr(stat.progressCount, 0),
      contradictedConfirmations: numberOr(stat.contradictedConfirmations, 0),
      safetyDenials: numberOr(stat.safetyDenials, 0),
      failureCodes: toStringCounts(stat.failureCodes),
      ewmaDurationMs: numberOr(stat.ewmaDurationMs, 0),
      ewmaGain: numberOr(stat.ewmaGain, 0),
      totalDistance: numberOr(stat.totalDistance, 0),
      distanceSamples: numberOr(stat.distanceSamples, 0),
      lastSequence: numberOr(stat.lastSequence, 0),
    };
  }
  return result;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringCounts(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count)) out[key] = count;
  }
  return out;
}
