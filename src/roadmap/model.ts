/**
 * Improvement roadmap model. Pure functions only: the rules produce candidates from evidence, and
 * `reconcile` merges them with the operator's saved decisions. Nothing here reads files or the clock.
 *
 * Kinds keep confirmed facts apart from guesses:
 *  - defect: a failure that was measured in a recorded run (test, profile, training episode, live metric).
 *  - hypothesis: a measured symptom whose cause is not established. The explanation says so.
 *  - known-limitation: a documented gap in the architecture or verification coverage.
 *  - idea: optional future work with no measured problem behind it. Never picked as the next task.
 */

export const ROADMAP_CATEGORIES = [
  "autonomy",
  "performance",
  "observation",
  "training",
  "navigation",
  "survival",
  "world-knowledge",
  "reliability",
  "interface",
] as const;
export type RoadmapCategory = (typeof ROADMAP_CATEGORIES)[number];

export const ROADMAP_KINDS = ["defect", "hypothesis", "known-limitation", "idea"] as const;
export type RoadmapKind = (typeof ROADMAP_KINDS)[number];

export const ROADMAP_STATUSES = [
  "proposed",
  "planned",
  "in-progress",
  "implemented",
  "verified",
  "blocked",
  "dismissed",
] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const ROADMAP_ACTIONS = ["plan", "start", "implement", "block", "dismiss", "restore", "pin", "unpin", "prioritize"] as const;
export type RoadmapAction = (typeof ROADMAP_ACTIONS)[number];

export const EFFORT_LABELS = { 1: "small", 2: "medium", 3: "large" } as const;
export type RoadmapEffort = 1 | 2 | 3;

export interface RoadmapEvidence {
  /** Where the number came from, e.g. a report file or the live runtime. */
  readonly source: string;
  readonly metric: string;
  readonly value: string;
  /** When the source was measured (ISO). Null for facts that are about the code, not a measurement. */
  readonly measuredAt: string | null;
}

export interface RoadmapCandidate {
  /** Stable identity used to match a finding across refreshes. Grouped findings share one fingerprint. */
  readonly fingerprint: string;
  readonly title: string;
  readonly category: RoadmapCategory;
  readonly kind: RoadmapKind;
  readonly explanation: string;
  readonly evidence: readonly RoadmapEvidence[];
  readonly expectedBenefit: string;
  readonly effort: RoadmapEffort;
  /** 1 (little) to 5 (large) expected effect on the agent's measured behaviour. */
  readonly impact: number;
  /** 1 (can wait) to 5 (blocks other work or safety). */
  readonly urgency: number;
  /** 0 to 1. Measured defects are high; hypotheses and ideas are lower. */
  readonly confidence: number;
  readonly dependencies: readonly string[];
  /** Size of the measured problem (e.g. failed attempts). Used to decide whether a dismissed item is worth reopening. */
  readonly severity: number;
  /** Newest measurement behind this candidate, or null when it is not a measurement. */
  readonly measuredAt: string | null;
}

export interface RoadmapHistoryEntry {
  readonly at: string;
  readonly event: string;
}

/** The operator's saved state for one fingerprint. Survives restarts. */
export interface RoadmapDecision {
  status: RoadmapStatus;
  pinned: boolean;
  /** Operator priority, 1 (low) to 5 (high). Null keeps the computed score. */
  priority: number | null;
  severity: number;
  dismissedSeverity: number | null;
  implementedAt: string | null;
  /** Newest evidence timestamp that has been applied to this decision. New evidence must be newer than this. */
  lastEvidenceAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  reopenedCount: number;
  verification: string | null;
  history: RoadmapHistoryEntry[];
}

export interface RoadmapItem extends RoadmapCandidate {
  readonly status: RoadmapStatus;
  readonly pinned: boolean;
  readonly priority: number | null;
  readonly score: number;
  readonly reopenedCount: number;
  readonly verification: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string | null;
  readonly history: readonly RoadmapHistoryEntry[];
}

/**
 * Expected value per unit of effort. Impact, confidence and urgency multiply, effort divides. A measured
 * defect with high impact therefore outranks an idea with the same numbers, because confidence is lower.
 * An operator priority rescales the score (3 is neutral); a pin puts the item first.
 */
export function scoreCandidate(candidate: Pick<RoadmapCandidate, "impact" | "urgency" | "confidence" | "effort">, priority: number | null, pinned: boolean): number {
  let score = (candidate.impact * candidate.confidence * candidate.urgency) / candidate.effort;
  if (priority !== null) score *= priority / 3;
  if (pinned) score += 100;
  return Math.round(score * 100) / 100;
}

export function newerThan(candidateAt: string | null, appliedAt: string | null): boolean {
  if (candidateAt === null) return false;
  if (appliedAt === null) return true;
  return candidateAt > appliedAt;
}

function freshDecision(now: string): RoadmapDecision {
  return {
    status: "proposed",
    pinned: false,
    priority: null,
    severity: 0,
    dismissedSeverity: null,
    implementedAt: null,
    lastEvidenceAt: null,
    firstSeenAt: now,
    lastSeenAt: null,
    reopenedCount: 0,
    verification: null,
    history: [{ at: now, event: "first observed" }],
  };
}

function log(decision: RoadmapDecision, at: string, event: string): void {
  decision.history = [...decision.history, { at, event }].slice(-30);
}

/**
 * Merges this refresh's candidates into the saved decisions and returns the items to show.
 *
 * Rules:
 *  - A dismissed item comes back only when new evidence shows severity at least 1.5x what it was at dismissal.
 *  - An implemented item is only judged once evidence newer than the implementation exists. If the finding is
 *    still there, it is reopened as proposed with the reason recorded. If it is gone, it becomes verified.
 *  - A verified item comes back only on newer evidence, the same way.
 *  - A finding that disappears while still open is hidden (its decision is kept, so it reappears with history).
 */
export function reconcile(input: {
  readonly candidates: readonly RoadmapCandidate[];
  readonly decisions: Readonly<Record<string, RoadmapDecision>>;
  readonly now: string;
  /** Newest measurement across all evidence sources in this refresh. */
  readonly evidenceAt: string | null;
}): { decisions: Record<string, RoadmapDecision>; items: RoadmapItem[]; resolved: number } {
  const decisions: Record<string, RoadmapDecision> = { ...input.decisions };
  const items: RoadmapItem[] = [];
  const present = new Set<string>();

  for (const candidate of input.candidates) {
    present.add(candidate.fingerprint);
    const decision: RoadmapDecision = { ...(decisions[candidate.fingerprint] ?? freshDecision(input.now)) };
    const isNewer = newerThan(candidate.measuredAt, decision.lastEvidenceAt);

    if (decision.status === "dismissed") {
      const threshold = decision.dismissedSeverity === null ? null : decision.dismissedSeverity * 1.5;
      if (isNewer && threshold !== null && candidate.severity >= threshold) {
        decision.status = "proposed";
        decision.reopenedCount += 1;
        log(decision, input.now, `reopened: severity ${decision.dismissedSeverity} → ${candidate.severity} on newer evidence`);
      }
    } else if (decision.status === "implemented") {
      if (isNewer) {
        decision.status = "proposed";
        decision.reopenedCount += 1;
        log(decision, input.now, `still observed after implementation (measured ${candidate.measuredAt})`);
      }
    } else if (decision.status === "verified" && isNewer) {
      decision.status = "proposed";
      decision.reopenedCount += 1;
      log(decision, input.now, `reopened: observed again on newer evidence (${candidate.measuredAt})`);
    }

    if (candidate.measuredAt !== null && (decision.lastEvidenceAt === null || candidate.measuredAt > decision.lastEvidenceAt)) {
      decision.lastEvidenceAt = candidate.measuredAt;
    }
    decision.severity = candidate.severity;
    decision.lastSeenAt = input.now;
    decisions[candidate.fingerprint] = decision;

    // Dismissed and verified items stay in the list: the UI hides them by default, but they remain readable.
    items.push(toItem(candidate, decision));
  }

  let resolved = 0;
  for (const [fingerprint, decision] of Object.entries(decisions)) {
    if (present.has(fingerprint)) continue;
    if (decision.status === "implemented" && input.evidenceAt !== null && decision.implementedAt !== null && input.evidenceAt > decision.implementedAt) {
      decision.status = "verified";
      decision.verification = `not observed in evidence measured ${input.evidenceAt}, after the change was marked implemented at ${decision.implementedAt}`;
      log(decision, input.now, "verified: no longer observed in newer evidence");
    } else if (decision.status !== "dismissed" && decision.status !== "verified") {
      resolved += 1;
    }
    decisions[fingerprint] = decision;
  }

  return { decisions, items, resolved };
}

function toItem(candidate: RoadmapCandidate, decision: RoadmapDecision): RoadmapItem {
  return {
    ...candidate,
    status: decision.status,
    pinned: decision.pinned,
    priority: decision.priority,
    score: scoreCandidate(candidate, decision.priority, decision.pinned),
    reopenedCount: decision.reopenedCount,
    verification: decision.verification,
    firstSeenAt: decision.firstSeenAt,
    lastSeenAt: decision.lastSeenAt,
    history: decision.history,
  };
}

/** The highest-priority item that should be worked on next. Ideas and settled items are never suggested. */
export function nextRecommendedTask(items: readonly RoadmapItem[]): RoadmapItem | null {
  const eligible = items.filter(
    (item) => item.kind !== "idea" && (item.status === "proposed" || item.status === "planned" || item.status === "in-progress"),
  );
  eligible.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return eligible[0] ?? null;
}

/** Applies an operator action. Returns an error message instead of throwing so the UI can show it. */
export function applyAction(
  decision: RoadmapDecision,
  action: RoadmapAction,
  value: number | null,
  now: string,
  currentSeverity: number | null,
  note: string | null,
): { ok: true } | { ok: false; message: string } {
  const suffix = note ? ` — ${note}` : "";
  switch (action) {
    case "plan":
      if (decision.status === "implemented" || decision.status === "verified") return { ok: false, message: "This item is already settled." };
      decision.status = "planned";
      log(decision, now, `planned${suffix}`);
      return { ok: true };
    case "start":
      if (decision.status === "implemented" || decision.status === "verified" || decision.status === "dismissed") {
        return { ok: false, message: `Cannot start an item that is ${decision.status}.` };
      }
      decision.status = "in-progress";
      log(decision, now, `started${suffix}`);
      return { ok: true };
    case "implement":
      if (decision.status === "dismissed") return { ok: false, message: "Restore the item before marking it implemented." };
      decision.status = "implemented";
      decision.implementedAt = now;
      log(decision, now, `marked implemented; awaiting newer evidence to verify${suffix}`);
      return { ok: true };
    case "block":
      decision.status = "blocked";
      log(decision, now, `blocked${suffix}`);
      return { ok: true };
    case "dismiss":
      decision.status = "dismissed";
      decision.dismissedSeverity = currentSeverity ?? decision.severity;
      log(decision, now, `dismissed at severity ${decision.dismissedSeverity}${suffix}`);
      return { ok: true };
    case "restore":
      if (decision.status !== "dismissed" && decision.status !== "blocked") return { ok: false, message: "Only dismissed or blocked items can be restored." };
      decision.status = "proposed";
      decision.dismissedSeverity = null;
      log(decision, now, `restored${suffix}`);
      return { ok: true };
    case "pin":
      decision.pinned = true;
      log(decision, now, "pinned to the top");
      return { ok: true };
    case "unpin":
      decision.pinned = false;
      log(decision, now, "unpinned");
      return { ok: true };
    case "prioritize":
      if (value === null || !Number.isInteger(value) || value < 1 || value > 5) return { ok: false, message: "Priority must be an integer from 1 to 5." };
      decision.priority = value;
      log(decision, now, `priority set to ${value}`);
      return { ok: true };
  }
}
