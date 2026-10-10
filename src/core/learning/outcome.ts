import { classifyFailure, type FailureKind } from "../failure-taxonomy.js";
import type { EpisodeOutcome } from "./episode.js";

/**
 * The one definition of what an action's outcome says about the choice that produced it.
 *
 * Before this existed the task runner and the learner disagreed: the runner treated "the adapter confirmed it but
 * the next observation shows nothing changed" as a failure, while the learner counted it as a success and only
 * tallied a "contradicted confirmation". And every failure counted against the chosen skill, including the ones that
 * say nothing about it (the connection dropped, the safety policy refused, the game mode forbids the action, a reflex
 * cut it short). A context that failed eight times because the world was in the wrong mode then looked like a skill
 * that never works, and was down-weighted.
 *
 *  - `success`  — the action succeeded, the adapter confirmed it, and the world did not contradict the confirmation.
 *  - `failure`  — the action ran (or was claimed to) and the world says it did not work. This is evidence.
 *  - `excluded` — the outcome is about something else (session, policy, mode, interruption). It is counted and shown,
 *                 but it never moves a success rate, a weight, or a target's failure memory.
 */
export type EvidenceVerdict = "success" | "failure" | "excluded";

export interface EvidenceClassification {
  readonly verdict: EvidenceVerdict;
  /** The failure code for a failure; why the outcome carries no evidence for an excluded one; null for a success. */
  readonly reason: string | null;
  /** Taxonomy kind of the failure code, when there is one. */
  readonly kind: FailureKind | null;
}

/** Statuses where the action did not run to a verdict: someone stopped it or the session went away. */
const NO_VERDICT_STATUSES: ReadonlySet<string> = new Set(["disconnected", "aborted"]);

/** Taxonomy kinds that describe the environment around the choice, not the choice. */
const ENVIRONMENT_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>(["safety", "capability", "connection", "perception"]);

/** Action-level codes that are still environment or plumbing: the same choice would fail for any skill. */
function isEnvironmentCode(code: string): boolean {
  return (
    code.startsWith("GAME_MODE_BLOCKS_") ||
    code === "UNSUPPORTED_DIMENSION" ||
    code === "REFLEX_INTERRUPT" ||
    code === "ACTION_ABORTED" ||
    code === "INVALID_ACTION_INPUT" ||
    code === "INVALID_ACTION_TIMEOUT"
  );
}

export function classifyOutcome(outcome: Pick<EpisodeOutcome, "status" | "confirmed" | "verified" | "failureCode" | "safetyDenied">): EvidenceClassification {
  if (outcome.status === "succeeded" && outcome.confirmed && outcome.verified !== false) {
    return { verdict: "success", reason: null, kind: null };
  }
  if (outcome.safetyDenied || outcome.status === "rejected") {
    return { verdict: "excluded", reason: outcome.failureCode ? `refused by the safety policy (${outcome.failureCode})` : "refused by the safety policy", kind: "safety" };
  }
  if (NO_VERDICT_STATUSES.has(outcome.status)) {
    return {
      verdict: "excluded",
      reason: outcome.status === "disconnected" ? "the session was lost during the action" : "the action was interrupted before a verdict",
      kind: outcome.status === "disconnected" ? "connection" : null,
    };
  }
  const code = outcome.failureCode;
  if (code) {
    const kind = classifyFailure(code).kind;
    if (ENVIRONMENT_KINDS.has(kind) || isEnvironmentCode(code)) {
      return { verdict: "excluded", reason: `${code}: the environment, not the choice`, kind };
    }
    return { verdict: "failure", reason: code, kind };
  }
  // No code: the action reported success but the confirmation or the world check did not hold.
  const reason = outcome.status === "succeeded" ? (outcome.verified === false ? "UNVERIFIED_POSTCONDITION" : "ACTION_NOT_CONFIRMED") : outcome.status;
  return { verdict: "failure", reason, kind: "action" };
}
