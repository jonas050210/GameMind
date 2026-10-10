import type {
  ControlCenterRuntimePerformance,
  ControlCenterSnapshot,
  ControlCenterTraining,
  EvaluationSummary,
} from "../control-center/types.js";
import type { ExperienceLearner } from "../core/learning/learner.js";
import type { SessionView } from "./types.js";
import { buildLearningView } from "../games/minecraft/run-control.js";

/**
 * The snapshot of an app that has no live game session: before the first connection, between sessions, and after
 * one ended. Everything that comes from a session is reported as unknown (null) or empty, never as a default that
 * looks like a measurement: health is not 20, the position is not 0,0,0, and the world is "not observed".
 * What does exist without a session is real and is included: the training state, the policy store and the last
 * evaluation report all live on disk.
 */
export interface DetachedInputs {
  readonly performance: ControlCenterRuntimePerformance;
  readonly session: SessionView;
  readonly learner: ExperienceLearner | null;
  readonly training: ControlCenterTraining | null;
  readonly evaluation: EvaluationSummary | null;
  /** Whether this process was started to talk to a live server or to the simulator, for the connection label. */
  readonly gameId?: string;
}

export function buildDetachedSnapshot(input: DetachedInputs): ControlCenterSnapshot {
  const { session } = input;
  const ended = session.state === "shutdown";
  const reason = ended
    ? `The last session ended: ${session.reason ?? "no reason recorded"}.`
    : session.state === "none"
      ? "No Minecraft session has been started in this process yet."
      : `The session is ${session.state}.`;
  const hint = session.error?.hints[0] ?? "Connect to a Minecraft server from the Overview or Bots tab.";
  return {
    generatedAt: new Date().toISOString(),
    performance: input.performance,
    connection: {
      adapterStatus: session.state === "none" || session.state === "shutdown" ? "disconnected" : session.state,
      gameId: input.gameId ?? "minecraft-java",
      sessionId: session.id,
      gameVersion: session.target?.version ?? null,
      server: session.target ? `${session.target.host}:${session.target.port}` : null,
      lastObservationAt: null,
      sequence: null,
      connectedForMs: null,
      statusReason: session.error?.summary ?? session.reason,
      statusChangedAt: session.since,
      worldAvailable: false,
    },
    agent: {
      state: "idle",
      taskId: null,
      taskKind: null,
      decisionModel: null,
      startedAt: null,
      actionsUsed: 0,
      elapsedMs: null,
      status: null,
      failure: null,
      blocker: {
        kind: "connection",
        code: session.error?.code ?? null,
        label: ended ? "Session ended" : "No session",
        headline: ended ? "The agent is not connected." : "The agent has not connected yet.",
        detail: session.error ? `${session.error.summary} ${session.error.detail}`.trim() : reason,
        hint,
        owner: session.error ? "server" : "operator",
        source: "session supervisor",
        at: session.since,
        retryable: session.error?.retryable ?? true,
      },
      stoppingRequestedAt: null,
      autonomous: false,
    },
    goal: null,
    world: {
      dimension: null,
      gameMode: null,
      health: null,
      food: null,
      saturation: null,
      airTicks: null,
      onGround: null,
      alive: null,
      deathCount: null,
      time: null,
      perception: null,
      entities: [],
      provenance: { source: "world-memory", note: "No live observation is available; nothing below was read from a running game." },
      freshness: { sequence: null, observedAt: null, ageMs: null, stale: true, reason: "no-observation" },
      sessionFacts: null,
      knownResourceBlocks: {},
      minableBlocks: 0,
      exploredCells: 0,
      inventory: [],
      equipment: { hand: null, offhand: null, head: null, torso: null, legs: null, feet: null },
      inventoryFull: null,
      vitalsObservedAt: null,
    },
    safety: null,
    learning: buildLearningView(input.learner?.snapshot() ?? null, null, input.evaluation),
    capabilities: [],
    recentActions: [],
    recentFailures: [],
    recentDecisions: [],
    skillMetrics: [],
    training: input.training,
    offlineNote: null,
    scheduler: null,
    autonomyEnabled: null,
  };
}
