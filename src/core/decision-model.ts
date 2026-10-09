export interface DecisionCandidate {
  readonly goalId: string;
  readonly priorityBand: number;
  readonly score: number;
  readonly skillId: string | null;
  readonly input: unknown;
  readonly targetKey: string | null;
  readonly rationale: string;
}

export interface DecisionRecord {
  readonly modelId: string;
  readonly decidedAt: string;
  readonly observationSequence: number;
  readonly selected: DecisionCandidate | null;
  readonly alternatives: readonly DecisionCandidate[];
  readonly terminalStatus: "completed" | "blocked" | null;
  readonly summary: string;
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
