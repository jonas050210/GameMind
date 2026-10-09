/**
 * Contracts for the Control Center. The HTTP layer, the SSE stream and the UI only ever see these
 * shapes, so everything they display is produced by the running agent from real state — there is no
 * mock data path in this module set.
 */

export interface ControlCenterConnection {
  readonly adapterStatus: string;
  readonly gameId: string;
  readonly sessionId: string | null;
  readonly gameVersion: string | null;
  readonly server: string | null;
  readonly lastObservationAt: string | null;
  readonly sequence: number | null;
  readonly connectedForMs: number | null;
}

export interface ControlCenterAgent {
  readonly state: "idle" | "running" | "paused" | "tripped" | "stopping" | "stopped";
  readonly taskId: string | null;
  readonly taskKind: string | null;
  readonly decisionModel: string | null;
  readonly startedAt: string | null;
  readonly actionsUsed: number;
  readonly maxActions: number | null;
  readonly elapsedMs: number | null;
  readonly status: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface ControlCenterGoal {
  readonly goalId: string;
  readonly band: number;
  readonly bandLabel: string;
  readonly skillId: string | null;
  readonly targetKey: string | null;
  readonly rationale: string;
  readonly progress: { readonly have: number; readonly of: number; readonly unit: string } | null;
  readonly plan: readonly string[];
  readonly alternatives: readonly {
    readonly goalId: string;
    readonly skillId: string | null;
    readonly targetKey: string | null;
    readonly score: number;
  }[];
  readonly rejected: readonly {
    readonly goalId: string;
    readonly targetKey: string | null;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly safety: { readonly allowed: boolean; readonly code: string; readonly message: string } | null;
}

export interface ControlCenterWorld {
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly dimension: string | null;
  readonly gameMode: string | null;
  readonly health: number | null;
  readonly food: number | null;
  readonly saturation: number | null;
  readonly airTicks: number | null;
  readonly onGround: boolean | null;
  readonly alive: boolean | null;
  readonly deathCount: number | null;
  readonly time: { readonly dayTicks: number; readonly isNight: boolean } | null;
  readonly perception: {
    readonly totalMs: number;
    readonly localScanMs: number;
    readonly strategicScanMs: number;
    readonly entityScanMs: number;
    readonly validationMs: number;
    readonly sampledCells: number;
    readonly unknownCells: number;
    readonly localBlocksFound: number;
    readonly localBlocksReturned: number;
    readonly entitiesReturned: number;
    readonly resourceSightings: number;
    readonly minableSightings: number;
    readonly loadedChunks: number | null;
    readonly resourceScanRadius: number;
    readonly resourceScanTruncated: boolean;
    readonly minableScanRadius: number | null;
    readonly minableScanTruncated: boolean | null;
  } | null;
  readonly entities: readonly {
    readonly id: string;
    readonly name: string;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly distance: number;
    readonly hostile: boolean;
  }[];
  readonly blocks: readonly {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly name: string;
    readonly hazard: boolean;
    /** Highlighted on the map: a resource block, or the block the current task is about. */
    readonly resource: boolean;
    /** True only for a prior-observation memory marker; false for blocks seen in this observation's local or strategic scan. */
    readonly remembered?: boolean;
  }[];
  /** Per-name census of resource blocks the world model still holds. */
  readonly knownResourceBlocks: Readonly<Record<string, number>>;
  readonly minableBlocks: number;
  readonly exploredCells: number;
  readonly inventory: readonly { readonly slot: number; readonly name: string; readonly count: number }[];
  readonly equipment: Readonly<Record<string, string | null>>;
  readonly inventoryFull: boolean | null;
}

export interface ControlCenterSafety {
  readonly policyId: string;
  readonly enabled: boolean;
  readonly maxRisk: string;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly tripped: boolean;
  readonly tripReason: string | null;
  readonly actionsApproved: number;
  readonly actionsDenied: number;
  readonly deniedByCode: Readonly<Record<string, number>>;
  readonly optedInCapabilities: readonly string[];
  /** Hard per-run action ceiling enforced by the broker, independent of the task's own budget. */
  readonly maxActionsPerRun: number;
  readonly world: {
    readonly health: number | null;
    readonly food: number | null;
    readonly visibleHostiles: number;
    readonly nearestHostileDistance: number | null;
    readonly isNight: boolean;
    readonly nearestHazardDistance: number | null;
    readonly nearestHazardName: string | null;
    readonly oxygenTicks: number | null;
  } | null;
  readonly recentVerdicts: readonly {
    readonly capability: string;
    readonly risk: string;
    readonly allowed: boolean;
    readonly code: string;
    readonly message: string;
    readonly evaluatedAt: string;
  }[];
}

export interface ControlCenterLearning {
  readonly enabled: boolean;
  readonly runs: number;
  readonly episodes: number;
  readonly contexts: readonly { readonly key: string; readonly attempts: number; readonly successes: number }[];
  readonly activePolicy: { readonly id: string; readonly contexts: number } | null;
  readonly candidatePolicy: { readonly id: string; readonly contexts: number };
  readonly blockedTargets: readonly {
    readonly targetKey: string;
    readonly attempts: number;
    readonly blocked: boolean;
    readonly failureCode: string | null;
  }[];
  readonly history: readonly { readonly runId: string; readonly at: string; readonly note: string; readonly promoted: boolean }[];
  readonly lastRun: {
    readonly episodes: number;
    readonly successes: number;
    readonly failures: number;
    readonly blockedTargets: number;
  } | null;
  /** Folded result of the offline evaluation, read from the report file on disk. */
  readonly evaluation: EvaluationSummary | null;
}

/** Executed skill call, as measured: which skill, for which goal, with what verification outcome. */
export interface ControlCenterActionView {
  readonly at: string;
  readonly correlationId: string | null;
  readonly skillId: string | null;
  readonly capability: string | null;
  readonly goalId: string | null;
  readonly status: string;
  readonly confirmed: boolean | null;
  /** "verified" means a later observation showed the expected world change. */
  readonly verification: string | null;
  readonly durationMs: number | null;
  readonly note: string | null;
}

export interface ControlCenterFailureView {
  readonly at: string;
  /** What kind of refusal or error this is, so the UI can label it without guessing. */
  readonly kind: "safety" | "action" | "run";
  readonly summary: string;
  readonly detail: string | null;
}

export interface ControlCenterSkillMetric {
  readonly skillId: string;
  readonly attempts: number;
  readonly successes: number;
  readonly meanDurationMs: number;
}

export interface ControlCenterTraceEvent {
  readonly traceId: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly correlationId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ControlCenterCapability {
  readonly name: string;
  readonly risk: string;
  readonly advertised: boolean;
  readonly skillId: string | null;
}

export interface ControlCenterRuntimePerformance {
  readonly sampledAt: string;
  readonly sampleWindowMs: number;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly logicalCpus: number;
  readonly process: {
    /** Process CPU time divided by elapsed time and logical CPU count, as a percentage of host capacity. */
    readonly cpuCapacityPercent: number;
    readonly eventLoopUtilizationPercent: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
    readonly externalBytes: number;
    readonly uptimeSeconds: number;
  };
  readonly host: {
    readonly totalMemoryBytes: number;
    readonly freeMemoryBytes: number;
    readonly loadAverage1m: number | null;
  };
}

export interface ControlCenterSnapshot {
  readonly generatedAt: string;
  /** Lightweight process/host sampling; no inspector, profiler, or Minecraft tick hook is enabled. */
  readonly performance: ControlCenterRuntimePerformance;
  readonly connection: ControlCenterConnection;
  readonly agent: ControlCenterAgent;
  readonly goal: ControlCenterGoal | null;
  readonly world: ControlCenterWorld;
  readonly safety: ControlCenterSafety | null;
  readonly learning: ControlCenterLearning | null;
  readonly capabilities: readonly ControlCenterCapability[];
  /** One entry per executed skill, newest first, folded from the skill and task traces. */
  readonly recentActions: readonly ControlCenterActionView[];
  readonly recentFailures: readonly ControlCenterFailureView[];
  /** Recent non-observation trace events, including deaths, recovery, policy changes and task lifecycle. */
  readonly recentEvents: readonly ControlCenterTraceEvent[];
  /** Recent complete decision records, including the alternatives that lost. */
  readonly recentDecisions: readonly ControlCenterTraceEvent[];
  readonly skillMetrics: readonly ControlCenterSkillMetric[];
  /** Whether the adapter currently accepts attacks; null when the adapter has no such switch. */
  readonly combatAllowed?: boolean | null;
  /** Present only when the data comes from a simulated run rather than a live server. */
  readonly offlineNote?: string | null;
}

/** Folded view of the offline evaluation report, read from disk by the host. */
export interface EvaluationSummary {
  /** Path of the JSON report the numbers were read from; null when no evaluation has run. */
  readonly reportPath: string | null;
  /** When the report was generated; null when no report exists yet. */
  readonly generatedAt: string | null;
  readonly scenarios: number;
  readonly scenarioIds: readonly string[];
  readonly runs: number;
  readonly successRate: number | null;
  readonly unsafeActions: number | null;
  /** Whether the report met its own acceptance thresholds. */
  readonly passed: boolean | null;
  /** Decision model the report was produced with, so the panel cannot be mistaken for another build. */
  readonly model: string | null;
  /** Seeds per scenario in the report. */
  readonly seedsPerScenario: number | null;
  /** Candidate weight table actually measured against the baseline, if one existed. */
  readonly policyCandidateId: string | null;
  /** Whether the stored same-seed policy comparison recommends promotion; null means no candidate was evaluated. */
  readonly policyPromotable: boolean | null;
  readonly policyGateReasons: readonly string[];
  /** Repeat-run effect of the target-failure memory on the same seeded worlds; null when unmeasured. */
  readonly learning: {
    readonly baselineWastedActions: number;
    readonly candidateWastedActions: number;
    readonly scenarios: number;
    /** Scenarios where the repeat run wasted strictly fewer actions than the cold run. */
    readonly improved: number;
    /** Whether every repeat-run gate in the report passed. */
    readonly passed: boolean;
  } | null;
}

export interface ControlCommandResult {
  readonly ok: boolean;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Everything the UI may actively do. Commands the host cannot honour must be reported as such by the
 * server (HTTP 501 with the reason) rather than silently acknowledged, so the dashboard can never show
 * a control that does nothing.
 */
export interface ControlCenterCommands {
  pause?(reason: string): ControlCommandResult | Promise<ControlCommandResult>;
  resume?(): ControlCommandResult | Promise<ControlCommandResult>;
  trip?(reason: string): ControlCommandResult | Promise<ControlCommandResult>;
  resetTrip?(): ControlCommandResult | Promise<ControlCommandResult>;
  enableCombat?(enabled: boolean): ControlCommandResult | Promise<ControlCommandResult>;
  setActionBudget?(maxActions: number): ControlCommandResult | Promise<ControlCommandResult>;
  startTask?(task: { readonly kind: string; readonly resource?: string; readonly count?: number }): ControlCommandResult | Promise<ControlCommandResult>;
  stopTask?(reason: string): ControlCommandResult | Promise<ControlCommandResult>;
  promotePolicy?(): ControlCommandResult | Promise<ControlCommandResult>;
  rejectPolicy?(): ControlCommandResult | Promise<ControlCommandResult>;
}

export interface ControlCenterHost {
  readonly title: string;
  snapshot(): ControlCenterSnapshot | Promise<ControlCenterSnapshot>;
  readonly commands: ControlCenterCommands;
}

export interface ControlCenterServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly logger?: { info(message: string): void; warn(message: string): void; error(message: string): void } | null;
  /** Heartbeat interval for the SSE stream in milliseconds. */
  readonly heartbeatMs?: number;
  /** Extra static header text (e.g. a simulation warning) shown in the UI banner. */
  readonly banner?: string | null;
}

export interface ControlCenterHandle {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  stop(reason?: string): Promise<void>;
  /** Notifies SSE subscribers that state changed; called by the host after a run step. */
  notify(event?: string): void;
  broadcast(event: ControlCenterTraceEvent): void;
}
