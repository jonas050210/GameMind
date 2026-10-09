export interface DecisionCandidate {
  readonly goalId: string;
  readonly priorityBand: number;
  readonly score: number;
  readonly skillId: string | null;
  readonly input: unknown;
  readonly targetKey: string | null;
  readonly rationale: string;
}

/** Why a candidate was considered but not selected. Recorded so traces explain rejections, not just choices. */
export interface DecisionRejection {
  readonly goalId: string;
  readonly targetKey: string | null;
  readonly priorityBand: number;
  readonly score: number | null;
  readonly reason:
    | "excluded_after_failure"
    | "no_skill"
    | "threatened"
    | "out_of_range"
    | "no_budget"
    | "lower_band"
    | "unknown_block_state"
    | "policy_penalty"
    | "not_applicable";
  readonly detail: string;
}

export interface DecisionRecord {
  readonly modelId: string;
  readonly decidedAt: string;
  readonly observationSequence: number;
  readonly selected: DecisionCandidate | null;
  readonly alternatives: readonly DecisionCandidate[];
  readonly terminalStatus: "completed" | "blocked" | null;
  readonly summary: string;
  /** Candidates that were evaluated and dropped, with the reason each one was dropped. */
  readonly rejected?: readonly DecisionRejection[];
  /** Human-readable summary of the safety broker's last verdict, when a broker is active. */
  readonly safety?: SafetyNote | null;
}

export interface SafetyNote {
  readonly allowed: boolean;
  readonly code: string;
  readonly message: string;
}

export interface DecisionContext {
  readonly excludedTargets: ReadonlySet<string>;
  readonly previousFailureCode: string | null;
}

export interface DecisionModel<TState, TTask> {
  decide(
    state: TState,
    task: TTask,
    context: DecisionContext,
  ): DecisionRecord;
}
