import type { Logger } from "pino";
import { ActionExecutor } from "./action-executor.js";
import { SafetyBroker, type SafetyPolicy } from "./safety-broker.js";
import type { GameAdapter, GameObservation, GameSession, WorldState } from "./types.js";
import { TraceRecorder } from "./trace.js";
import { WorldModel } from "./world-model.js";

export type SafetyWorldContextInput = Omit<
  import("./safety-broker.js").SafetyWorldContext,
  "sequence"
>;

export interface SafetyObservationMeta {
  readonly sequence: number;
  readonly observedAtMs: number;
}

export interface GameMindRuntimeOptions<TState = unknown> {
  /**
   * Broker or policy gating every action this runtime dispatches. `undefined` (the default) and `null`
   * both mean "no broker", so an unconfigured runtime behaves exactly as before; `createMinecraftAgent`
   * always passes the Minecraft policy, which is what makes the gate live in practice.
   */
  readonly safety?: SafetyBroker | SafetyPolicy | null;
  /**
   * Extracts the safety-relevant fields of a game state so the broker can fail closed on stale or
   * dangerous observations without knowing anything about Minecraft.
   */
  readonly safetyContext?: (state: TState, meta: SafetyObservationMeta) => SafetyWorldContextInput;
}

export class GameMindRuntime<TState = unknown> {
  readonly worldModel = new WorldModel<TState>();
  readonly safety: SafetyBroker | null;
  readonly actionExecutor: ActionExecutor<TState>;
  private sessionValue: GameSession | null = null;
  private shuttingDown = false;
  private readonly unsubscribeStatus: () => void;

  constructor(
    readonly adapter: GameAdapter<TState>,
    readonly trace: TraceRecorder,
    private readonly logger: Logger,
    private readonly options: GameMindRuntimeOptions<TState> = {},
  ) {
    // No broker unless the composition root asks for one: `undefined` and `null` both mean "not gated".
    this.safety =
      options.safety === undefined || options.safety === null
        ? null
        : options.safety instanceof SafetyBroker
          ? options.safety
          : new SafetyBroker(options.safety);
    this.actionExecutor = new ActionExecutor(adapter, trace, logger, {
      ...(this.safety ? { safety: this.safety } : {}),
    });
    this.unsubscribeStatus = adapter.onStatusChange((change) => {
      if (change.status === "disconnected" || change.status === "failed") {
        this.sessionValue = null;
        this.worldModel.clear();
      }
      void this.trace
        .record({
          eventType: `adapter.${change.status}`,
          gameId: adapter.gameId,
          sessionId: change.sessionId,
          data: { reason: change.reason, at: change.at },
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, adapterStatus: change.status },
            "Could not persist adapter status trace",
          );
        });
    });
  }

  get session(): GameSession | null {
    return this.sessionValue;
  }

  get currentWorldState(): WorldState<TState> | null {
    return this.worldModel.current;
  }

  async connect(): Promise<GameSession> {
    if (this.shuttingDown) throw new Error("Runtime is shutting down and cannot reconnect.");
    if (this.adapter.status === "connected" && this.sessionValue) return this.sessionValue;

    const session = await this.adapter.connect();
    this.sessionValue = session;
    this.worldModel.beginSession(session);
    await this.trace.record({
      eventType: "session.started",
      gameId: session.gameId,
      sessionId: session.id,
      data: {
        gameVersion: session.gameVersion,
        connectedAt: session.connectedAt,
        capabilities: this.adapter.capabilities.map(({ name, risk }) => ({ name, risk })),
      },
    });
    await this.observe();
    return session;
  }

  async observe(): Promise<WorldState<TState>> {
    if (this.adapter.status !== "connected" || !this.sessionValue) {
      throw new Error("Cannot observe without an active GameMind session.");
    }

    const observation: GameObservation<TState> = await this.adapter.observe();
    const state = this.worldModel.apply(observation);
    this.publishSafetyContext(state);
    await this.trace.record({
      eventType: "observation.received",
      gameId: state.gameId,
      sessionId: state.sessionId,
      data: {
        sequence: state.sequence,
        observedAt: state.observedAt,
        receivedAt: state.receivedAt,
        state: state.state,
      },
    });
    return state;
  }

  /** Pushes the current world context into the broker so its checks see live numbers. */
  private publishSafetyContext(state: WorldState<TState>): void {
    if (!this.safety) return;
    const extract = this.options.safetyContext;
    if (!extract) return;
    try {
      this.safety.updateWorld({
        ...extract(state.state, {
          sequence: state.sequence,
          observedAtMs: Date.parse(state.observedAt) || Date.now(),
        }),
        sequence: state.sequence,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Safety context extraction failed; the broker keeps its last context");
    }
  }

  /** Read-only view of connection, world-model and safety state; used by the Control Center. */
  status(): {
    readonly adapterStatus: string;
    readonly sessionId: string | null;
    readonly sequence: number | null;
    readonly lastObservationAt: string | null;
    readonly safety: ReturnType<SafetyBroker["snapshot"]> | null;
  } {
    const current = this.worldModel.current;
    return {
      adapterStatus: this.adapter.status,
      sessionId: this.sessionValue?.id ?? null,
      sequence: current?.sequence ?? null,
      lastObservationAt: current?.observedAt ?? null,
      safety: this.safety?.snapshot() ?? null,
    };
  }

  async shutdown(reason = "requested shutdown"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const session = this.sessionValue;
    try {
      await this.trace.record({
        eventType: "session.stopping",
        gameId: this.adapter.gameId,
        sessionId: session?.id ?? this.adapter.session?.id ?? null,
        data: { reason },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Could not persist shutdown trace");
    }

    await this.actionExecutor.shutdown(reason);
    try {
      await this.adapter.disconnect(reason);
    } finally {
      this.sessionValue = null;
      this.worldModel.clear();
      this.unsubscribeStatus();
      try {
        await this.trace.record({
          eventType: "session.stopped",
          gameId: this.adapter.gameId,
          sessionId: session?.id ?? null,
          data: { reason, finalAdapterStatus: this.adapter.status },
        });
      } catch (error) {
        this.logger.error({ err: error }, "Could not persist final shutdown trace");
      }
      await this.trace.close();
    }
  }
}
