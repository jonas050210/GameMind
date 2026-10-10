import { z } from "zod";

/**
 * One episode = one decision, the action it produced, and what the world did afterwards. Episodes
 * are the only learning input; everything derived from them is recomputable from the raw log.
 */

export const distanceBands = ["adjacent", "near", "medium", "far", "unknown"] as const;
export const vitalityBands = ["critical", "low", "ok", "full", "unknown"] as const;
export const threatBands = ["none", "visible", "approaching"] as const;
export const timeOfDayBands = ["day", "night", "unknown"] as const;

export type DistanceBand = (typeof distanceBands)[number];
export type VitalityBand = (typeof vitalityBands)[number];
export type ThreatBand = (typeof threatBands)[number];
export type TimeOfDayBand = (typeof timeOfDayBands)[number];

export const episodeFeaturesSchema = z.object({
  goalClass: z.string().min(1).max(64),
  skillId: z.string().min(1).max(96),
  band: z.number().int().min(0).max(8),
  distance: z.number().finite().min(0).max(1e6),
  distanceBand: z.enum(distanceBands),
  health: z.number().finite().min(-1).max(40).nullable(),
  hunger: z.number().finite().min(-1).max(40).nullable(),
  vitality: z.enum(vitalityBands),
  threat: z.enum(threatBands),
  timeOfDay: z.enum(timeOfDayBands),
  targetKind: z.string().min(1).max(96),
  /** In-run index of this action; lets the learner see whether later steps of a task fail more. */
  actionIndex: z.number().int().min(0),
  attemptsOnTarget: z.number().int().min(0),
});

export const episodeOutcomeSchema = z.object({
  status: z.enum(["succeeded", "rejected", "failed", "timed_out", "disconnected", "aborted"]),
  confirmed: z.boolean(),
  /** `null` when the postcondition contract had no observation to check against. */
  verified: z.boolean().nullable(),
  progress: z.boolean(),
  failureCode: z.string().max(96).nullable(),
  itemsGained: z.number().int().min(-1024).max(1024),
  itemsConsumed: z.number().int().min(-1024).max(1024),
  healthDelta: z.number().finite().min(-40).max(40),
  foodDelta: z.number().finite().min(-40).max(40),
  durationMs: z.number().int().min(0),
  distanceAfter: z.number().finite().min(0).max(1e6).nullable(),
  safetyDenied: z.boolean(),
});

/**
 * Where an episode came from. New rows carry it explicitly. Rows written before the field existed are
 * classified by `episodeProvenanceOf` from their identifiers, and report themselves as inferred.
 */
export const EPISODE_PROVENANCE = [
  "simulator-demo",
  "simulator-eval",
  "training",
  "live",
  "simulator-unlabelled",
  "unlabelled",
] as const;
export type EpisodeProvenance = (typeof EPISODE_PROVENANCE)[number];

export const episodeSchema = z.object({
  schemaVersion: z.literal(1),
  episodeId: z.string().min(1).max(96),
  runId: z.string().min(1).max(96),
  taskId: z.string().min(1).max(96),
  sessionId: z.string().max(96).nullable(),
  sequence: z.number().int().min(0),
  timestamp: z.string(),
  policyVersion: z.string().max(64).nullable(),
  features: episodeFeaturesSchema,
  outcome: episodeOutcomeSchema,
  /** Compact target identity (`oak_log@12,64,-3` style). Used for in-run target memory. */
  targetKey: z.string().max(160).nullable(),
  /**
   * Identifies the world the episode was recorded in (scenario id + seed, or server host + world
   * name). Absolute targets are only ever reused inside the same world, so this is what makes
   * cross-run "I already tried that exact rock" memory sound rather than superstitious.
   */
  worldKey: z.string().max(120).nullable(),
  /** Explicit provenance; absent on rows written before it existed. */
  provenance: z.enum(EPISODE_PROVENANCE).optional(),
});

export type EpisodeFeatures = z.infer<typeof episodeFeaturesSchema>;
export type EpisodeOutcome = z.infer<typeof episodeOutcomeSchema>;
export type Episode = z.infer<typeof episodeSchema>;

/**
 * Aggregation key for statistics. Kept deliberately coarse: an agent may only try a given kind of
 * action a handful of times per run, so narrower keys would never gather enough evidence to move.
 */
export function episodeContextKey(features: EpisodeFeatures): string {
  return `${features.skillId}|${features.goalClass}|${features.distanceBand}|${features.threat}|${features.vitality}`;
}

/** Failure attribution key: which class of failure happened where. */
export function episodeFailureKey(features: EpisodeFeatures, outcome: EpisodeOutcome): string {
  return `${features.skillId}|${features.goalClass}|${outcome.failureCode ?? "no-progress"}`;
}

export function distanceBandOf(distance: number | null): DistanceBand {
  if (distance === null || !Number.isFinite(distance)) return "unknown";
  if (distance <= 2) return "adjacent";
  if (distance <= 8) return "near";
  if (distance <= 24) return "medium";
  return "far";
}

export function vitalityBandOf(health: number | null, food: number | null): VitalityBand {
  if (health === null || food === null) return "unknown";
  if (health <= 6 || food <= 3) return "critical";
  if (health <= 12 || food <= 10) return "low";
  if (health >= 20 && food >= 18) return "full";
  return "ok";
}

export function threatBandOf(visibleHostiles: number, approaching: boolean): ThreatBand {
  if (approaching) return "approaching";
  return visibleHostiles > 0 ? "visible" : "none";
}

export function timeOfDayBandOf(isNight: boolean | null | undefined): TimeOfDayBand {
  if (isNight === true) return "night";
  if (isNight === false) return "day";
  return "unknown";
}

/**
 * Goal families the learner aggregates over. Derived from the goal id prefix so that a new skill
 * automatically lands in a sensible bucket instead of needing a registration step.
 */
export function goalClassOf(goalId: string): string {
  const prefix = goalId.split(":")[0] ?? goalId;
  const known = new Set([
    "collect",
    "mine",
    "craft",
    "eat",
    "restore-hunger",
    "harvest",
    "pickup",
    "explore",
    "approach",
    "avoid-nearby-hostile",
    "recover",
    "rest",
    "reach-crafting-table",
    "place-crafting-table",
    "place-block",
    "build-shelter",
    "defend",
    "equip",
    "free-inventory",
    "avoid-hazard",
  ]);
  return known.has(prefix) ? prefix : prefix;
}

export function isEpisode(value: unknown): value is Episode {
  return episodeSchema.safeParse(value).success;
}

/**
 * Provenance of any episode. An explicit field wins. Legacy rows are inferred from identifiers only:
 * training rows carry the `train-` run prefix or the `train:` world key; other simulator rows (sim- session)
 * cannot be told apart between the CLI demo and the learning comparison, so they stay "simulator-unlabelled".
 */
export function episodeProvenanceOf(episode: Pick<Episode, "provenance" | "runId" | "worldKey" | "sessionId">): {
  readonly provenance: EpisodeProvenance;
  readonly inferred: boolean;
} {
  if (episode.provenance) return { provenance: episode.provenance, inferred: false };
  if (episode.runId.startsWith("train-") || (episode.worldKey ?? "").startsWith("train:")) {
    return { provenance: "training", inferred: true };
  }
  if ((episode.sessionId ?? "").startsWith("sim-")) return { provenance: "simulator-unlabelled", inferred: true };
  return { provenance: "unlabelled", inferred: true };
}
