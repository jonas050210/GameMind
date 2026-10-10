import type { Logger } from "pino";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { WorldState } from "../../core/types.js";
import type { MinecraftObservation } from "./observation.js";
import { assessReflex, newlyUrgent, REFLEX_THRESHOLDS, type ReflexAssessment, type ReflexCode } from "./reflex.js";
import type { RuntimeMetrics } from "./runtime-metrics.js";

export interface ObservationTick {
  readonly world: WorldState<MinecraftObservation>;
  readonly assessment: ReflexAssessment;
  /** Urgent reasons that were not urgent in the previous observation. Empty on most ticks. */
  readonly newlyUrgent: readonly ReflexCode[];
  readonly detectedMs: number;
}

export interface FastObservationLoopOptions {
  readonly runtime: GameMindRuntime<MinecraftObservation>;
  readonly metrics: RuntimeMetrics;
  readonly logger: Logger;
  /** Target period between observation starts. The loop never runs two observations at once. */
  readonly intervalMs?: number;
  /** Wall clock in milliseconds; injectable for tests. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called after every completed observation with its reflex assessment. Must not throw. */
  readonly onObservation?: (tick: ObservationTick) => void | Promise<void>;
  /** Called after every observation. The host decides whether it is idle (no task running) and acts on that. */
  readonly onIdle?: (tick: ObservationTick) => void | Promise<void>;
}

export interface FastObservationLoopState {
  readonly running: boolean;
  readonly inFlight: boolean;
  readonly nudgePending: boolean;
  readonly lastAssessment: ReflexAssessment | null;
  readonly lastTickAt: string | null;
}

/**
 * The fast perception loop. It is independent of planning and of any running task: it keeps the world
 * model fresh at about one observation per second, evaluates reflexes on each fresh observation, and tells
 * the host when a newly urgent condition appeared so a running action can be interrupted.
 *
 * Scheduling rules that keep it responsive:
 *  - one observation at a time; a slow observation delays the next tick instead of stacking up behind it;
 *  - `nudge()` (an event such as an action finishing) runs a tick as soon as the current one ends, and any
 *    number of nudges collapse into one pending tick, so the queue never grows;
 *  - a tick that is not connected is counted and skipped without throwing.
 */
export class FastObservationLoop {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private nudgePending = false;
  private lastAssessment: ReflexAssessment | null = null;
  private lastTickAt: string | null = null;
  private previousObservation: MinecraftObservation | null = null;
  private stopped = false;

  constructor(private readonly options: FastObservationLoopOptions) {
    this.intervalMs = Math.max(100, options.intervalMs ?? 1_000);
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref());
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get state(): FastObservationLoopState {
    return {
      running: this.running,
      inFlight: this.inFlight !== null,
      nudgePending: this.nudgePending,
      lastAssessment: this.lastAssessment,
      lastTickAt: this.lastTickAt,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.options.metrics.setRunning(true);
    void this.runTick();
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.options.metrics.setRunning(false);
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /**
   * Requests an immediate observation because something changed (an action finished, a hostile was seen,
   * an operator asked). Coalesced: at most one extra tick is ever pending.
   */
  nudge(): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.nudgePending = true;
      return;
    }
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    void this.runTick();
  }

  /** Runs one tick and resolves when it has finished. Exposed for deterministic tests and manual refresh. */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    return this.runTick();
  }

  private runTick(): Promise<void> {
    const run = this.performTick().finally(() => {
      this.inFlight = null;
      if (this.stopped || !this.running) return;
      if (this.nudgePending) {
        this.nudgePending = false;
        void this.runTick();
        return;
      }
      this.scheduleNext();
    });
    this.inFlight = run;
    return run;
  }

  private scheduleNext(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.running && !this.inFlight) void this.runTick();
    }, this.intervalMs);
  }

  private async performTick(): Promise<void> {
    const runtime = this.options.runtime;
    if (runtime.adapter.status !== "connected" || !runtime.session) {
      this.options.metrics.recordSkippedTick();
      return;
    }
    const startedMs = this.now();
    let world: WorldState<MinecraftObservation>;
    try {
      world = await runtime.observe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.metrics.recordObservationError(message);
      this.options.logger.warn({ err: error }, "Fast observation failed; the loop will retry on its next tick");
      return;
    }
    const finishedMs = this.now();
    this.lastTickAt = new Date(finishedMs).toISOString();
    this.options.metrics.recordObservation({ startedMs, finishedMs, observedAt: world.observedAt });

    const assessment = assessReflex(world.state, this.previousObservation, {
      observationSequence: world.sequence,
      observedAt: world.observedAt,
    });
    const fresh = newlyUrgent(assessment, this.lastAssessment);
    if (fresh.length > 0) this.options.metrics.recordUrgent({ codes: fresh, detectedMs: finishedMs });
    this.lastAssessment = assessment;
    this.previousObservation = world.state;

    const tick: ObservationTick = { world, assessment, newlyUrgent: fresh, detectedMs: finishedMs };
    try {
      await this.options.onObservation?.(tick);
      // Idle work (choosing the next autonomous task) is the host's call: it checks for a running task itself,
      // so urgent observations also reach it and can start a reactive task instead of waiting for calm.
      await this.options.onIdle?.(tick);
    } catch (error) {
      this.options.logger.error({ err: error }, "Observation handler failed; the loop keeps running");
    }
  }

  /** Maximum age, in milliseconds, that a decision may use without refreshing the observation first. */
  static get staleAfterMs(): number {
    return REFLEX_THRESHOLDS.staleAfterMs;
  }
}
