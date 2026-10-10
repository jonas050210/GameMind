/**
 * Measured timing for the agent loop. Every value here is taken from a real clock reading in the running
 * process: observation completion times, decision and action durations, and the time between an urgent
 * observation and the agent's next response. Samples live in fixed-size windows, so memory stays bounded.
 *
 * The targets below are the contract the Control Center compares against. They are not claims about any
 * particular server; the Control Center reports whether the measured values currently meet them.
 */

export const LOOP_TARGETS = {
  /** One fresh observation at least this often during active play (p95 of the interval). */
  observationIntervalP95Ms: 1_300,
  /** The agent's observation may be at most this old when it decides (p95). */
  observationAgeP95Ms: 1_500,
  /** Strategic decision making must stay responsive (p95 of decide()). */
  decisionP95Ms: 250,
  /** From an urgent observation to the next response dispatched (p95). */
  reactionP95Ms: 1_500,
} as const;

export interface SampleSummary {
  readonly count: number;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** Fixed-capacity sample window with nearest-rank percentiles. Old samples are dropped first. */
export class SampleWindow {
  private readonly values: number[] = [];
  private total = 0;

  constructor(private readonly capacity = 240) {}

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values.push(value);
    this.total += 1;
    if (this.values.length > this.capacity) this.values.shift();
  }

  /** Samples recorded since creation, including those that have aged out of the window. */
  get lifetimeCount(): number {
    return this.total;
  }

  summary(): SampleSummary {
    if (this.values.length === 0) {
      return { count: this.total, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    const rank = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
      count: this.total,
      meanMs: round(sum / sorted.length),
      p50Ms: round(rank(0.5)),
      p95Ms: round(rank(0.95)),
      maxMs: round(sorted[sorted.length - 1] ?? 0),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface TargetStatus {
  readonly label: string;
  readonly targetMs: number;
  readonly measuredMs: number | null;
  readonly met: boolean | null;
}

export interface AgentLoopPerformance {
  readonly sampledAt: string;
  readonly running: boolean;
  readonly observation: {
    readonly total: number;
    readonly errors: number;
    readonly lastError: string | null;
    readonly skippedTicks: number;
    /** Completed observations per second over the last 10 seconds of the clock. */
    readonly frequencyHz: number | null;
    readonly intervalMs: SampleSummary;
    readonly durationMs: SampleSummary;
    /** Age of the newest observation at the moment of this sample; null before the first one. */
    readonly ageMs: number | null;
    readonly lastObservedAt: string | null;
    readonly stale: boolean;
  };
  readonly decisionMs: SampleSummary;
  readonly actionMs: SampleSummary;
  readonly reactionMs: SampleSummary;
  readonly interruptMs: SampleSummary;
  readonly urgent: {
    readonly events: number;
    readonly interruptsDispatched: number;
    readonly interruptsSkippedProtected: number;
    readonly lastCodes: readonly string[];
    readonly lastAt: string | null;
  };
  readonly idle: {
    /** Milliseconds with no task running since the loop started. */
    readonly idleMs: number;
    readonly busyMs: number;
    readonly idleFraction: number | null;
  };
  readonly targets: readonly TargetStatus[];
}

export class RuntimeMetrics {
  private readonly observationIntervals = new SampleWindow();
  private readonly observationDurations = new SampleWindow();
  private readonly decisions = new SampleWindow();
  private readonly actions = new SampleWindow();
  private readonly reactions = new SampleWindow();
  private readonly interrupts = new SampleWindow();
  private readonly recentObservationTimes: number[] = [];
  private observationTotal = 0;
  private observationErrors = 0;
  private lastObservationError: string | null = null;
  private skippedTicks = 0;
  private lastObservationAtMs: number | null = null;
  private lastObservedAtIso: string | null = null;
  private urgentEvents = 0;
  private interruptsDispatched = 0;
  private interruptsProtected = 0;
  private lastUrgentCodes: readonly string[] = [];
  private lastUrgentAt: string | null = null;
  private pendingReactionSince: number | null = null;
  private idleMsTotal = 0;
  private busyMsTotal = 0;
  private busySince: number | null = null;
  private lastIdleMark: number | null = null;
  private running = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  setRunning(running: boolean): void {
    this.running = running;
  }

  /** Records one completed observation. `startedMs`/`finishedMs` come from the same clock as `now`. */
  recordObservation(input: { readonly startedMs: number; readonly finishedMs: number; readonly observedAt: string }): void {
    this.observationTotal += 1;
    this.observationDurations.add(input.finishedMs - input.startedMs);
    if (this.lastObservationAtMs !== null) this.observationIntervals.add(input.finishedMs - this.lastObservationAtMs);
    this.lastObservationAtMs = input.finishedMs;
    this.lastObservedAtIso = input.observedAt;
    this.recentObservationTimes.push(input.finishedMs);
    const cutoff = input.finishedMs - 10_000;
    while (this.recentObservationTimes.length && (this.recentObservationTimes[0] ?? 0) < cutoff) {
      this.recentObservationTimes.shift();
    }
  }

  recordObservationError(message: string): void {
    this.observationErrors += 1;
    this.lastObservationError = message;
  }

  recordSkippedTick(): void {
    this.skippedTicks += 1;
  }

  /** An urgent reason appeared at `detectedMs`; the response is timed when the next action is dispatched. */
  recordUrgent(input: { readonly codes: readonly string[]; readonly detectedMs: number }): void {
    this.urgentEvents += 1;
    this.lastUrgentCodes = [...input.codes];
    this.lastUrgentAt = new Date(input.detectedMs).toISOString();
    if (this.pendingReactionSince === null) this.pendingReactionSince = input.detectedMs;
  }

  recordInterrupt(input: { readonly detectedMs: number | null; readonly dispatchedMs: number; readonly interrupted: boolean; readonly protectedCapability?: boolean }): void {
    if (input.interrupted) {
      this.interruptsDispatched += 1;
      if (input.detectedMs !== null) this.interrupts.add(input.dispatchedMs - input.detectedMs);
      // The interrupt is itself the response to the urgent condition, so it closes the pending reaction.
      if (this.pendingReactionSince !== null) {
        this.reactions.add(input.dispatchedMs - this.pendingReactionSince);
        this.pendingReactionSince = null;
      }
    } else if (input.protectedCapability) {
      this.interruptsProtected += 1;
    }
  }

  recordDecision(durationMs: number): void {
    this.decisions.add(durationMs);
  }

  /** Called when an action is dispatched. Closes a pending urgent reaction, if one is open. */
  recordActionStart(atMs: number = this.now()): void {
    if (this.pendingReactionSince !== null) {
      this.reactions.add(atMs - this.pendingReactionSince);
      this.pendingReactionSince = null;
    }
  }

  recordActionDuration(durationMs: number): void {
    this.actions.add(durationMs);
  }

  /** Marks the start/end of a task so idle time is measured against it. */
  setBusy(busy: boolean, atMs: number = this.now()): void {
    this.accrueIdle(atMs);
    if (busy) {
      if (this.busySince === null) this.busySince = atMs;
    } else if (this.busySince !== null) {
      this.busyMsTotal += atMs - this.busySince;
      this.busySince = null;
    }
    this.lastIdleMark = atMs;
  }

  private accrueIdle(atMs: number): void {
    if (this.lastIdleMark === null) {
      this.lastIdleMark = atMs;
      return;
    }
    if (this.busySince === null) this.idleMsTotal += Math.max(0, atMs - this.lastIdleMark);
    this.lastIdleMark = atMs;
  }

  summary(): AgentLoopPerformance {
    const nowMs = this.now();
    const interval = this.observationIntervals.summary();
    const decisionP95 = this.decisions.summary().p95Ms;
    const reactionP95 = this.reactions.summary().p95Ms;
    const ageMs = this.lastObservationAtMs === null ? null : Math.max(0, nowMs - this.lastObservationAtMs);
    const frequencyHz = this.recentObservationTimes.length > 1
      ? round((this.recentObservationTimes.length - 1) / Math.max(1, (nowMs - (this.recentObservationTimes[0] ?? nowMs)) / 1_000))
      : null;
    this.accrueIdle(nowMs);
    const busyMs = this.busyMsTotal + (this.busySince !== null ? nowMs - this.busySince : 0);
    const idleMs = this.idleMsTotal;
    const total = busyMs + idleMs;
    const ageP95 = ageMs;
    return {
      sampledAt: new Date(nowMs).toISOString(),
      running: this.running,
      observation: {
        total: this.observationTotal,
        errors: this.observationErrors,
        lastError: this.lastObservationError,
        skippedTicks: this.skippedTicks,
        frequencyHz,
        intervalMs: interval,
        durationMs: this.observationDurations.summary(),
        ageMs: ageMs === null ? null : round(ageMs),
        lastObservedAt: this.lastObservedAtIso,
        stale: ageMs === null || ageMs > LOOP_TARGETS.observationAgeP95Ms,
      },
      decisionMs: this.decisions.summary(),
      actionMs: this.actions.summary(),
      reactionMs: this.reactions.summary(),
      interruptMs: this.interrupts.summary(),
      urgent: {
        events: this.urgentEvents,
        interruptsDispatched: this.interruptsDispatched,
        interruptsSkippedProtected: this.interruptsProtected,
        lastCodes: this.lastUrgentCodes,
        lastAt: this.lastUrgentAt,
      },
      idle: {
        idleMs: round(idleMs),
        busyMs: round(busyMs),
        idleFraction: total > 0 ? round(idleMs / total) : null,
      },
      targets: [
        {
          label: "Observation interval (p95)",
          targetMs: LOOP_TARGETS.observationIntervalP95Ms,
          measuredMs: interval.p95Ms,
          met: interval.p95Ms === null ? null : interval.p95Ms <= LOOP_TARGETS.observationIntervalP95Ms,
        },
        {
          label: "Observation age (now)",
          targetMs: LOOP_TARGETS.observationAgeP95Ms,
          measuredMs: ageP95 === null ? null : round(ageP95),
          met: ageP95 === null ? null : ageP95 <= LOOP_TARGETS.observationAgeP95Ms,
        },
        {
          label: "Decision latency (p95)",
          targetMs: LOOP_TARGETS.decisionP95Ms,
          measuredMs: decisionP95,
          met: decisionP95 === null ? null : decisionP95 <= LOOP_TARGETS.decisionP95Ms,
        },
        {
          label: "Reaction time (p95)",
          targetMs: LOOP_TARGETS.reactionP95Ms,
          measuredMs: reactionP95,
          met: reactionP95 === null ? null : reactionP95 <= LOOP_TARGETS.reactionP95Ms,
        },
      ],
    };
  }
}
