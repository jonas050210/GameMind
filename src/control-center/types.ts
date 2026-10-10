/**
 * Contracts for the Control Center. The HTTP layer and the UI only ever see these shapes, so everything
 * they display is produced by the running agent from real state — there is no mock data path in this
 * module set. The UI polls `/api/snapshot`, which is the only read channel: a push stream would need the
 * host to know when a viewer is watching, and every snapshot it could deliver is already derivable from
 * the state below.
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
  /** Why the adapter is in this state, verbatim from the source. Null only when nothing was reported. */
  readonly statusReason: string | null;
  /** When the adapter last changed state, so a stale error is not read as a current one. */
  readonly statusChangedAt: string | null;
  /** Whether world state can be shown at all right now: connected *and* holding a live observation. */
  readonly worldAvailable: boolean;
}

export interface ControlCenterAgent {
  readonly state: "idle" | "running" | "paused" | "tripped" | "stopping" | "stopped" | "autonomous";
  readonly taskId: string | null;
  readonly taskKind: string | null;
  readonly decisionModel: string | null;
  readonly startedAt: string | null;
  readonly actionsUsed: number;
  readonly maxActions: number | null;
  readonly elapsedMs: number | null;
  readonly status: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  /**
   * The single reason the agent is not making progress, already classified. `blocked` on its own is not an
   * explanation; this says whether the cause is a safety refusal, a capability the adapter never
   * advertised, a connection problem, missing perception, or the planner finding nothing to do.
   */
  readonly blocker: ControlCenterBlocker;
  /** When set, the stop button has been pressed but the task has not ended yet. */
  readonly stoppingRequestedAt: string | null;
  /** True when the agent is in autonomous survival mode (no explicit task). */
  readonly autonomous: boolean;
}

/** Who has to act for the blocker to clear. */
export type ControlCenterBlockerOwner = "agent" | "operator" | "server" | "unknown";

/**
 * What kind of stoppage this is. Kept as a closed set because the whole point is that a refusal, an
 * outage and a failed task never look the same in the UI again.
 */
export type ControlCenterBlockerKind =
  | "none"
  | "safety"
  | "capability"
  | "connection"
  | "perception"
  | "planner"
  | "task"
  | "action"
  /** The source produced a code this build does not recognise; the raw reason is still shown verbatim. */
  | "unknown";

export interface ControlCenterBlocker {
  readonly kind: ControlCenterBlockerKind;
  /** Stable machine code, e.g. `SAFETY_LAVA_AHEAD` or `ECONNREFUSED`. Null when the run is clear. */
  readonly code: string | null;
  /** Category label for the UI, e.g. "Safety refusal". */
  readonly label: string;
  /** One-line statement of the situation, suitable as a panel heading. */
  readonly headline: string;
  /** The exact reason text as the source reported it — never a paraphrase. */
  readonly detail: string;
  /** What to do about it, when there is something to do. */
  readonly hint: string | null;
  readonly owner: ControlCenterBlockerOwner;
  /** Which subsystem the reason came from, e.g. "safety-broker" or "adapter". */
  readonly source: string | null;
  readonly at: string | null;
  /** True when the agent could clear this itself by acting (a retry, a re-plan) rather than waiting on a person. */
  readonly retryable: boolean;
}

export interface ControlCenterGoal {
  readonly goalId: string;
  readonly band: number;
  readonly bandLabel: string;
  readonly skillId: string | null;
  readonly targetKey: string | null;
  readonly rationale: string;
  readonly progress: { readonly have: number; readonly of: number; readonly unit: string } | null;
  /** Why the decision model stopped, when it stopped; null when it chose something to do. */
  readonly blockingCode?: string | null;
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
  readonly time: {
    readonly dayTicks: number | null;
    readonly isNight: boolean;
    readonly day: number | null;
    /** Which live field the night judgement came from, so a fallback is never read as a measurement. */
    readonly source: string | null;
  } | null;
  /** Current-observation terrain census; never reconstructed from stale memory. */
  readonly terrain: {
    readonly observedColumns: number;
    readonly obstacleColumns: number;
    readonly hazardColumns: number;
    readonly waterColumns: number;
    readonly unknownCells: number;
    readonly sampledCells: number;
    readonly truncated: boolean;
  } | null;
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
    /** Namespaced identifier shown to operators; derived from the observed canonical block name. */
    readonly identifier: string;
    readonly type: number | null;
    readonly boundingBox: string | null;
    readonly distance: number | null;
    /** `visible`/`occluded` are Mineflayer line-of-sight results; `unknown` is never upgraded to visible. */
    readonly visibility: "visible" | "occluded" | "unknown";
    readonly hazard: boolean;
    /** Highlighted on the map: a resource block, or the block the current task is about. */
    readonly resource: boolean;
    /** True only for a prior-observation memory marker; false for blocks seen in this observation's local or strategic scan. */
    readonly remembered?: boolean;
    /** Where this block came from: the current observation or the world model's memory of an older one. */
    readonly source?: "observation" | "memory";
    readonly observationKind: "local" | "strategic" | "memory";
    readonly observedAt: string | null;
  }[];
  /**
   * How the world panel's data relates to the live session. `live-observation` means every field below
   * came from the current observation; `world-memory` means the observation is gone and remembered blocks
   * are being shown; `simulated` means no live server is involved at all.
   */
  readonly provenance: { readonly source: "live-observation" | "world-memory" | "simulated"; readonly note: string | null };
  /** Age and trustworthiness of the observation the world data came from. */
  readonly freshness: {
    readonly sequence: number | null;
    readonly observedAt: string | null;
    readonly ageMs: number | null;
    /** True when the data is older than the safety policy's `maxObservationAgeMs`. */
    readonly stale: boolean;
    readonly reason: "fresh" | "no-observation" | "stale" | "session-changed" | "simulated";
  };
  /** Dimension and game mode *with the evidence behind them*, so "unknown" is visibly different from "overworld". */
  readonly sessionFacts: {
    readonly dimension: ControlCenterSessionFact;
    readonly gameMode: ControlCenterSessionFact;
    /** When the live session last sent a health packet; null when it never has. */
    readonly vitalsObservedAt: string | null;
    /** Raw read-out of the air gauge and vitals, for the detail line. */
    readonly airEvidence: string | null;
    readonly vitalsEvidence: string | null;
    /** Last dimension/mode change the session reported during this run. */
    readonly lastChange: { readonly at: string; readonly kind: string; readonly detail: string } | null;
  } | null;
  /** Per-name census of resource blocks the world model still holds. */
  readonly knownResourceBlocks: Readonly<Record<string, number>>;
  readonly minableBlocks: number;
  readonly exploredCells: number;
  readonly inventory: readonly { readonly slot: number; readonly name: string; readonly count: number }[];
  readonly equipment: Readonly<Record<string, string | null>>;
  readonly inventoryFull: boolean | null;
  /** When the live session last sent a health packet; null when it never has. */
  readonly vitalsObservedAt: string | null;
}

/** A player fact the adapter read from the live session, with the provenance of that read. */
export interface ControlCenterSessionFact {
  readonly value: string | null;
  /** `verified` = two independent session sources agreed; `single-source` = one said so; `conflicting` / `unreported` = not known. */
  readonly evidence: "verified" | "single-source" | "conflicting" | "unreported";
  readonly source: string;
  readonly observed: string;
  readonly note: string | null;
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
  /** Reward statistics from the enhanced learning system. */
  readonly reward?: {
    readonly meanReward: number;
    readonly ewmaReward: number;
    readonly positiveRate: number;
    readonly totalEpisodes: number;
  } | null;
  /** Class-level failure patterns (generalised from per-target failures). */
  readonly classPatterns?: readonly {
    readonly patternKey: string;
    readonly attempts: number;
    readonly distinctTargets: number;
    readonly blocked: boolean;
  }[];
  /** Policy checkpoint history. */
  readonly checkpoints?: {
    readonly total: number;
    readonly activeId: string | null;
    readonly recent: readonly { readonly id: string; readonly reason: string; readonly createdAt: string }[];
  } | null;
  /** Recent experiment records. */
  readonly experiments?: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly promoted: boolean;
  }[];
  /** RL readiness assessment score. */
  readonly rlReadiness?: {
    readonly score: number;
    readonly maxScore: number;
    readonly ready: readonly string[];
    readonly blockers: readonly string[];
  } | null;
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

export interface ControlCenterCompanion {
  readonly mode: string;
  readonly targetPlayer: string | null;
  readonly anchor: { readonly x: number; readonly y: number; readonly z: number; readonly dimension: string | null; readonly savedAt: string; readonly observationSequence: number } | null;
  readonly home: { readonly x: number; readonly y: number; readonly z: number; readonly dimension: string | null; readonly savedAt: string; readonly observationSequence: number } | null;
  readonly homepoints: readonly { readonly name: string; readonly location: { readonly x: number; readonly y: number; readonly z: number; readonly dimension: string | null; readonly savedAt: string; readonly observationSequence: number }; readonly availability: "available" | "stale" | "different-dimension" | "dimension-unknown" }[];
  readonly activeHomepoint: string | null;
  readonly preferredFollowDistance: number;
  readonly normalMaximumSeparation: number;
  readonly measuredSeparation: number | null;
  readonly followState: string;
  readonly knownStorage: readonly { readonly blockName: string; readonly x: number; readonly y: number; readonly z: number; readonly dimension: string | null; readonly lastSeenAt: string; readonly lastSeenSequence: number }[];
  readonly lastTransitionAt: string;
  readonly reason: string;
  readonly executing: boolean;
  readonly lastOutcome: string | null;
  readonly history: readonly { readonly at: string; readonly direction: "in" | "out"; readonly source: string; readonly speaker: string | null; readonly text: string; readonly ok: boolean | null }[];
}

/** Persistent landmark for the Control Center. */
export interface ControlCenterLandmark {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly createdAt: string;
  readonly lastConfirmedSequence: number;
}

/** Long-term autonomous progression state: current milestone, completed milestones, and inventory summary. */
export interface ControlCenterProgression {
  readonly currentMilestone: string;
  readonly currentMilestoneName: string;
  readonly completedMilestones: readonly string[];
  readonly milestones: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly completed: boolean;
  }[];
  readonly inventorySummary: {
    readonly logs: number;
    readonly planks: number;
    readonly cobblestone: number;
    readonly food: number;
    readonly hasWoodenPickaxe: boolean;
    readonly hasStonePickaxe: boolean;
    readonly hasIronPickaxe: boolean;
  };
}

export interface ControlCenterSnapshot {
  readonly generatedAt: string;
  /** Lightweight process/host sampling; no inspector, profiler, or Minecraft tick hook is enabled. */
  readonly performance: ControlCenterRuntimePerformance;
  readonly connection: ControlCenterConnection;
  readonly agent: ControlCenterAgent;
  readonly companion?: ControlCenterCompanion | null;
  readonly goal: ControlCenterGoal | null;
  readonly world: ControlCenterWorld;
  readonly safety: ControlCenterSafety | null;
  readonly learning: ControlCenterLearning | null;
  readonly capabilities: readonly ControlCenterCapability[];
  /** One entry per executed skill, newest first, folded from the skill and task traces. */
  readonly recentActions: readonly ControlCenterActionView[];
  readonly recentFailures: readonly ControlCenterFailureView[];
  /** Recent complete decision records, including the alternatives that lost. */
  readonly recentDecisions: readonly ControlCenterTraceEvent[];
  readonly skillMetrics: readonly ControlCenterSkillMetric[];
  /** Long-term progression milestones for the autonomous agent; null when no tracker is available. */
  readonly progression?: ControlCenterProgression | null;
  /** Persistent landmarks discovered by the agent; null when no landmark memory is available. */
  readonly landmarks?: readonly ControlCenterLandmark[] | null;
  /** Whether the adapter currently accepts attacks; null when the adapter has no such switch. */
  readonly combatAllowed?: boolean | null;
  /** Which layer is controlling the combat state. */
  readonly combatAllowedSource?: "adapter" | "safety-policy" | "task-runner" | "unknown" | null;
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
  chat?(message: string): ControlCommandResult | Promise<ControlCommandResult>;
  /** Emergency stop: simultaneously trips, stops the task, and disarms combat. */
  panic?(): ControlCommandResult | Promise<ControlCommandResult>;
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
  /** Extra static header text (e.g. a simulation warning) shown in the UI banner. */
  readonly banner?: string | null;
}

export interface ControlCenterHandle {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  stop(reason?: string): Promise<void>;
}
