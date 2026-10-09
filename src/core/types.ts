import type { ZodType } from "zod";

export type AdapterStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "stopping"
  | "failed";

export interface GameSession {
  readonly id: string;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly connectedAt: string;
}

export interface GameObservation<TState = unknown> {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly observedAt: string;
  readonly state: TState;
}

export interface WorldState<TState = unknown> extends GameObservation<TState> {
  readonly receivedAt: string;
}

export type RiskLevel = "low" | "medium" | "high";

export interface CapabilityDefinition<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly risk: RiskLevel;
}

export interface AdapterAction {
  readonly actionId: string;
  readonly sessionId: string;
  readonly capability: string;
  readonly input: unknown;
}

export interface AdapterActionOutcome {
  readonly confirmed: boolean;
  /** Describes the evidence level, e.g. client-side state or an observed world update. */
  readonly confirmation: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ActionStatus =
  | "succeeded"
  | "rejected"
  | "failed"
  | "timed_out"
  | "disconnected"
  | "aborted";

export interface ActionRequest {
  readonly actionId?: string;
  readonly sessionId: string | null;
  readonly capability: string;
  /**
   * Skill that requested the action, when it came through the skill runtime. Safety rules that are
   * written per skill (recovery skills allowed during a health floor) need this; capability-level
   * rules ignore it.
   */
  readonly skillId?: string;
  readonly input: unknown;
  readonly timeoutMs?: number;
  readonly source?: string;
}

export interface ActionFailure {
  readonly code: string;
  readonly message: string;
}

export interface ActionResult {
  readonly actionId: string;
  readonly sessionId: string | null;
  readonly capability: string;
  readonly status: ActionStatus;
  readonly confirmed: boolean;
  readonly confirmation: string | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly failure: ActionFailure | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface AdapterStatusChange {
  readonly status: AdapterStatus;
  readonly at: string;
  readonly sessionId: string | null;
  readonly reason: string | null;
}

export interface GameAdapter<TState = unknown> {
  readonly gameId: string;
  readonly status: AdapterStatus;
  readonly session: GameSession | null;
  readonly capabilities: readonly CapabilityDefinition[];

  connect(): Promise<GameSession>;
  observe(): Promise<GameObservation<TState>>;
  executeAction(
    action: AdapterAction,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome>;
  cancelActiveAction(actionId: string, reason: string): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  onStatusChange(listener: (change: AdapterStatusChange) => void): () => void;
}
