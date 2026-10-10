import type { ConnectionDiagnosis } from "./platform.js";
import type { MinecraftTask } from "../games/minecraft/task.js";

/**
 * Lifecycle vocabulary shared by the session supervisor, the Control Center and the tests.
 *
 * `SessionPhase` is what the supervisor itself is doing; `SessionState` is what an operator sees. They differ in
 * exactly one place: while the phase is `ready` the state is `running` when the scheduler holds a task and `idle`
 * when it does not, so "connected but not busy" can never be confused with "working" or "gone".
 */
export type SessionPhase = "connecting" | "initializing" | "ready" | "reconnecting" | "stopping" | "shutdown";

export type SessionState = "connecting" | "initializing" | "idle" | "running" | "reconnecting" | "stopping" | "shutdown";

/** Persistent sessions stay connected after a task until the operator stops them; one-shot ones end with the task. */
export type SessionMode = "persistent" | "one-shot";

export type SessionSource = "live" | "simulated";

export interface SessionTarget {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly username: string;
  readonly auth: "offline" | "microsoft";
}

export interface ConnectRequest {
  readonly source: SessionSource;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly version?: string;
  readonly auth?: "offline" | "microsoft";
  /** Simulated sessions only: the evaluation scenario to load and its seed. */
  readonly scenarioId?: string;
  readonly seed?: number;
  readonly mode?: SessionMode;
  /** Start with autonomy on (default) or off. Never changes a safety policy. */
  readonly autonomy?: boolean;
  /** The task the CLI asked for; it is reserved before anything else can start and runs first. */
  readonly startupTask?: MinecraftTask;
  readonly allowCombat?: boolean;
  /** Overrides the world identity derived from host, port and dimension. */
  readonly worldKey?: string;
}

export interface SessionStateChange {
  readonly at: string;
  readonly state: SessionState;
  readonly reason: string | null;
}

export interface SessionErrorView {
  readonly code: string;
  readonly summary: string;
  readonly hints: readonly string[];
  readonly detail: string;
  readonly retryable: boolean;
}

export interface SessionReconnectView {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
}

/** What the Control Center shows about the agent's session, whether or not one exists. */
export interface SessionView {
  readonly id: string | null;
  /** "none" before the first connect request of this process. */
  readonly state: SessionState | "none";
  readonly mode: SessionMode | null;
  readonly source: SessionSource | null;
  /** When the current state began. */
  readonly since: string | null;
  readonly createdAt: string | null;
  readonly connectedAt: string | null;
  readonly runtimeMs: number | null;
  /** Where the bot is connected; never includes credentials. */
  readonly target: SessionTarget | null;
  /** Identity of the world the memory is filed under; null until the first observation. */
  readonly worldKey: string | null;
  readonly reason: string | null;
  readonly error: SessionErrorView | null;
  readonly reconnect: SessionReconnectView | null;
  readonly history: readonly SessionStateChange[];
  readonly autonomy: boolean | null;
  /** True when a new session can be started now (none exists, or the last one is shut down). */
  readonly canConnect: boolean;
  readonly canStop: boolean;
}

export function diagnosisToErrorView(diagnosis: ConnectionDiagnosis): SessionErrorView {
  return { code: diagnosis.code, summary: diagnosis.summary, hints: diagnosis.hints, detail: diagnosis.detail, retryable: diagnosis.retryable };
}

export const NO_SESSION_VIEW: SessionView = {
  id: null,
  state: "none",
  mode: null,
  source: null,
  since: null,
  createdAt: null,
  connectedAt: null,
  runtimeMs: null,
  target: null,
  worldKey: null,
  reason: null,
  error: null,
  reconnect: null,
  history: [],
  autonomy: null,
  canConnect: true,
  canStop: false,
};
