/**
 * Contracts for the Control Center. The HTTP layer and the UI only ever see these shapes, so everything
 * they display is produced by the running agent from real state — there is no mock data path in this
 * module set. The UI polls `/api/snapshot`, which is the only read channel: a push stream would need the
 * host to know when a viewer is watching, and every snapshot it could deliver is already derivable from
 * the state below.
 */

import type { SchedulerSnapshot } from "../games/minecraft/task-scheduler.js";

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

import type { AgentLoopPerformance } from "../games/minecraft/runtime-metrics.js";
import type { AutonomySnapshot } from "../games/minecraft/autonomy-controller.js";
import type { RoadmapSnapshot } from "../roadmap/service.js";

export interface ControlCenterAgent {
  readonly state: "idle" | "running" | "paused" | "tripped" | "stopping" | "stopped" | "autonomous";
  readonly taskId: string | null;
  readonly taskKind: string | null;
  readonly decisionModel: string | null;
  readonly startedAt: string | null;
  readonly actionsUsed: number;
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
    readonly distance: number;
    readonly hostile: boolean;
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
  /**
   * Structured operation log (Library actions, mode transitions, homepoint and task outcomes).
   * The chat transcript was removed with the chat-command system; this log carries no free text
   * commands, only executed operations and their measured results.
   */
  readonly history: readonly { readonly at: string; readonly kind: string; readonly text: string; readonly ok: boolean | null }[];
}

/** One Library parameter field, rendered as a form control by the Control Center. */
export interface ControlCenterLibraryParam {
  readonly name: string;
  readonly label: string;
  readonly type: "string" | "integer" | "number" | "boolean" | "select";
  readonly required: boolean;
  readonly def?: unknown;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly help?: string;
}

/** One executable Library entry with its honest per-run availability. */
export interface ControlCenterLibraryEntry {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly status: "implemented" | "experimental" | "unavailable";
  readonly statusReason: string | null;
  readonly requiresConnection: boolean;
  readonly params: readonly ControlCenterLibraryParam[];
}

/** One Library execution with its measured outcome (never "success" for a mere accept). */
export interface ControlCenterLibraryOperation {
  readonly id: string;
  readonly entryId: string;
  readonly title: string;
  readonly category: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly state: "running" | "succeeded" | "failed" | "refused";
  readonly message: string;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly confirmed: boolean | null;
  readonly durationMs: number | null;
}

export interface ControlCenterLibrary {
  readonly catalog: readonly ControlCenterLibraryEntry[];
  readonly operations: readonly ControlCenterLibraryOperation[];
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

/**
 * The world seed as the operator entered it. It is never auto-detected (the live session does not expose it
 * reliably), and nothing derived from it is shown as observed: `verified` stays false until a real check.
 */
export interface ControlCenterWorldSeed {
  readonly value: string | null;
  readonly source: "manual" | "unset";
  readonly verified: false;
  readonly note: string;
}

export interface ControlCenterTrainingDeltas {
  readonly successRate: number;
  readonly medianActions: number;
  readonly meanWastedActions: number;
  readonly unsafeActions: number;
  readonly deaths: number;
}

/** Training as reported from its state file and its child process. Nothing here is estimated. */
export interface ControlCenterTraining {
  /** `interrupted` means the state says a run was active but its process is gone; it can be resumed. */
  readonly status: "idle" | "running" | "paused" | "stopped" | "completed" | "failed" | "interrupted" | "evaluating";
  readonly processAlive: boolean;
  readonly pid: number | null;
  readonly root: string;
  readonly episodesTotal: number;
  readonly episodeBudget: number;
  readonly episodesPerStage: number | null;
  readonly stage: {
    readonly index: number;
    readonly total: number;
    readonly id: string;
    readonly label: string;
    readonly episodes: number;
    readonly successRate: number | null;
    readonly passRate: number;
  } | null;
  readonly recentSuccessRate: number | null;
  readonly recentMeanReward: number | null;
  readonly recentEpisodes: readonly {
    readonly index: number;
    readonly stageId: string;
    readonly scenarioId: string;
    readonly seed: number;
    readonly success: boolean;
    readonly status: string;
    readonly failureCode: string | null;
    readonly actions: number;
    readonly wastedActions: number;
    readonly simulatedSeconds: number;
    readonly reward: number | null;
    readonly at: string;
  }[];
  readonly checkpoints: readonly {
    readonly id: string;
    readonly stageId: string;
    readonly createdAt: string;
    readonly episodes: number;
    readonly weightedContexts: number;
  }[];
  readonly lastEvaluation: {
    readonly checkpointId: string;
    readonly generatedAt: string;
    readonly verdict: "promotable" | "not-promotable";
    readonly successRate: { readonly baseline: number; readonly candidate: number };
    readonly deltas: ControlCenterTrainingDeltas | null;
    readonly reasons: readonly string[];
  } | null;
  readonly lastError: string | null;
  readonly updatedAt: string | null;
  readonly note: string;
  /** Where training runs. Always the offline simulator: no Minecraft client, no browser rendering. */
  readonly execution: "offline-simulator";
  readonly render: "none";
  /** Time budget for the run, in minutes; null when only the episode budget applies. */
  readonly maxMinutes: number | null;
  /** Active episode time across all invocations, in seconds. Pauses are not counted. */
  readonly activeSeconds: number;
  /** Lifetime throughput: episodes divided by active minutes. Null before any active time. */
  readonly episodesPerMinute: number | null;
  /** Per-episode reward for the saved recent episodes, oldest first. Null entries had no learner reward. */
  readonly rewardTrend: readonly (number | null)[];
  /** Why the run last stopped (operator, time budget, episode budget, curriculum complete). */
  readonly stopReason: string | null;
}

export interface ControlCenterSnapshot {
  readonly generatedAt: string;
  /** Measured timing of the fast observation loop: frequency, observation age, decision/action/reaction latency. */
  readonly agentLoop?: AgentLoopPerformance | null;
  /** Subgoal choice, cooldowns, and recent outcomes from the autonomy controller. */
  readonly objective?: AutonomySnapshot | null;
  readonly worldSeed?: ControlCenterWorldSeed | null;
  readonly training?: ControlCenterTraining | null;
  /** Improvement roadmap built from recorded evidence and the live loop. Null when the host has none. */
  readonly roadmap?: RoadmapSnapshot | null;
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
  /** Central Library catalog and recent executions. Null when the host has no Library. */
  readonly library?: ControlCenterLibrary | null;
  /** The authoritative task scheduler: active task, queue, recent outcomes, refusals. Null when the host has none. */
  readonly scheduler?: SchedulerSnapshot | null;
  /** Whether the agent starts its own tasks when idle. Null when the host cannot say. */
  readonly autonomyEnabled?: boolean | null;
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
  setWorldSeed?(seed: string | null): ControlCommandResult | Promise<ControlCommandResult>;
  startTraining?(options: { readonly episodesPerStage?: number; readonly maxEpisodes?: number; readonly maxMinutes?: number; readonly fresh?: boolean }): ControlCommandResult | Promise<ControlCommandResult>;
  refreshRoadmap?(): ControlCommandResult | Promise<ControlCommandResult>;
  roadmapAction?(payload: { readonly fingerprint: string; readonly action: string; readonly value?: number; readonly note?: string }): ControlCommandResult | Promise<ControlCommandResult>;
  pauseTraining?(): ControlCommandResult | Promise<ControlCommandResult>;
  resumeTraining?(): ControlCommandResult | Promise<ControlCommandResult>;
  stopTraining?(): ControlCommandResult | Promise<ControlCommandResult>;
  evaluateTraining?(checkpointId?: string): ControlCommandResult | Promise<ControlCommandResult>;
  /** `queue: true` runs the task after the current one instead of refusing while the agent is busy. */
  startTask?(task: { readonly kind: string; readonly resource?: string; readonly count?: number; readonly queue?: boolean }): ControlCommandResult | Promise<ControlCommandResult>;
  stopTask?(reason: string): ControlCommandResult | Promise<ControlCommandResult>;
  /** Removes one queued task (by ticket id) from the scheduler. */
  cancelQueuedTask?(payload: { readonly ticketId: string } | string): ControlCommandResult | Promise<ControlCommandResult>;
  /** Cancels every queued task; the running one is untouched. */
  clearTaskQueue?(): ControlCommandResult | Promise<ControlCommandResult>;
  /** Turns autonomous idle behaviour on or off. Safety policy, budgets and combat restrictions are unaffected. */
  setAutonomy?(payload: { readonly enabled: boolean } | boolean): ControlCommandResult | Promise<ControlCommandResult>;
  promotePolicy?(): ControlCommandResult | Promise<ControlCommandResult>;
  rejectPolicy?(): ControlCommandResult | Promise<ControlCommandResult>;
  /**
   * Executes one Library entry by id with structured parameters. The only capability-execution
   * command; the removed `chat` free-text path answered 501 after the chat-command removal.
   */
  libraryExecute?(payload: { readonly id: string; readonly params?: Readonly<Record<string, unknown>> }): ControlCommandResult | Promise<ControlCommandResult>;
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
