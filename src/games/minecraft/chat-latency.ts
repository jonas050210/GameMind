/**
 * Measured chat response times. Every value here comes from a real clock reading in the running process:
 * when an operator message arrived, how long it waited for the serialised queue, how long handling it took,
 * how long the optional local model needed, and when the first chat line went back out.
 *
 * The targets are the contract the Control Center compares against, in the same spirit as `LOOP_TARGETS`:
 * they are not claims about any particular server and not an ambition. They mark the boundary between
 * legitimate work and a problem, so a slow or hanging answer becomes a number instead of an impression.
 * Handling is bounded above by the queue timeout (CHAT_HANDLE_TIMEOUT_MS, 20 s): anything that reaches it
 * is abandoned, so a target well below it still leaves room for one observation refresh plus a local-model
 * answer at its 8 s cold budget.
 */
import { SampleWindow, type SampleSummary, type TargetStatus } from "./runtime-metrics.js";

export const CHAT_TARGETS = {
  /** Message arrival to its handling starting. Grows only while an earlier message holds the queue (p95). */
  queueWaitP95Ms: 1_500,
  /** One message's own work: parse, refresh the observation, dispatch, answer. Tasks are not awaited (p95). */
  handleP95Ms: 9_000,
  /** Message arrival to the first chat line sent back for it, whatever the message decided to say (p95). */
  firstReplyP95Ms: 9_000,
  /** The optional local model on its own, whose cold budgets are 3 s warm and 8 s cold (p95). */
  responderP95Ms: 8_000,
} as const;

/**
 * One received message and its timings. The controller creates it on receipt and passes it back, so a reply
 * or a duration is always attributed to the message it belongs to even when messages interleave.
 */
export interface ChatMessageTiming {
  readonly receivedMs: number;
  startedMs: number | null;
  queueWaitMs: number | null;
  firstReplyMs: number | null;
  replied: boolean;
  /** Set when the optional local model answered this message; its duration goes to its own window. */
  responderMs: number | null;
}

/** What one message cost. Logged per message so a live session can be read afterwards. */
export interface ChatLatencySample {
  readonly queueWaitMs: number | null;
  readonly handleMs: number | null;
  readonly firstReplyMs: number | null;
  readonly responderMs: number | null;
  readonly timedOut: boolean;
}

export interface ChatLatency {
  readonly sampledAt: string;
  readonly messages: {
    /** Passed the operator gate and the duplicate filter. */
    readonly received: number;
    /** Dropped before any work: wrong sender, empty text, or a duplicate inside the dedupe window. */
    readonly ignored: number;
    /** Handling finished on its own. */
    readonly handled: number;
    /** Handling was abandoned by the queue timeout. */
    readonly timedOut: number;
    /** Messages that produced at least one chat line. */
    readonly answered: number;
  };
  readonly queueWaitMs: SampleSummary;
  readonly handleMs: SampleSummary;
  readonly firstReplyMs: SampleSummary;
  readonly responderMs: SampleSummary;
  /** The most recent finished message, for a log line or a panel; null before the first one. */
  readonly last: ChatLatencySample | null;
  readonly targets: readonly TargetStatus[];
}

export class ChatLatencyMetrics {
  private readonly queueWait = new SampleWindow();
  private readonly handle = new SampleWindow();
  private readonly firstReply = new SampleWindow();
  private readonly responder = new SampleWindow();
  private received = 0;
  private ignored = 0;
  private handled = 0;
  private timedOut = 0;
  private answered = 0;
  private last: ChatLatencySample | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** An operator message arrived and will be looked at. Returns the timing the caller passes back. */
  messageReceived(): ChatMessageTiming {
    this.received += 1;
    return { receivedMs: this.now(), startedMs: null, queueWaitMs: null, firstReplyMs: null, replied: false, responderMs: null };
  }

  /** A message was dropped before any work. It costs nothing and must not look like a slow answer. */
  messageIgnored(): void {
    this.ignored += 1;
  }

  /** Work on this message began; the wait since arrival is the queue delay. */
  handlingStarted(timing: ChatMessageTiming): void {
    const at = this.now();
    timing.startedMs = at;
    timing.queueWaitMs = Math.max(0, at - timing.receivedMs);
    this.queueWait.add(timing.queueWaitMs);
  }

  /** One optional local model answer for this message, timed separately from the command work around it. */
  recordResponder(timing: ChatMessageTiming, durationMs: number): void {
    timing.responderMs = durationMs;
    this.responder.add(durationMs);
  }

  /** The first chat line for this message went out. Later lines of the same answer are not counted again. */
  replySent(timing: ChatMessageTiming): void {
    if (timing.replied) return;
    timing.replied = true;
    timing.firstReplyMs = Math.max(0, this.now() - timing.receivedMs);
    this.answered += 1;
    this.firstReply.add(timing.firstReplyMs);
  }

  /**
   * Work on this message ended, normally or abandoned by the queue timeout. Returns what it cost so the
   * caller can log it; null only if handling never started, which produces no duration to report.
   */
  handlingFinished(timing: ChatMessageTiming, options: { readonly timedOut?: boolean } = {}): ChatLatencySample | null {
    const isTimeout = options.timedOut === true;
    if (isTimeout) this.timedOut += 1;
    else this.handled += 1;
    if (timing.startedMs === null) return null;
    const handleMs = Math.max(0, this.now() - timing.startedMs);
    this.handle.add(handleMs);
    const sample: ChatLatencySample = {
      queueWaitMs: timing.queueWaitMs,
      handleMs,
      firstReplyMs: timing.firstReplyMs,
      responderMs: timing.responderMs,
      timedOut: isTimeout,
    };
    this.last = sample;
    return sample;
  }

  summary(): ChatLatency {
    const queueWaitP95 = this.queueWait.summary().p95Ms;
    const handleP95 = this.handle.summary().p95Ms;
    const firstReplyP95 = this.firstReply.summary().p95Ms;
    const responderP95 = this.responder.summary().p95Ms;
    return {
      sampledAt: new Date(this.now()).toISOString(),
      messages: {
        received: this.received,
        ignored: this.ignored,
        handled: this.handled,
        timedOut: this.timedOut,
        answered: this.answered,
      },
      queueWaitMs: this.queueWait.summary(),
      handleMs: this.handle.summary(),
      firstReplyMs: this.firstReply.summary(),
      responderMs: this.responder.summary(),
      last: this.last,
      targets: [
        {
          label: "Chat queue wait (p95)",
          targetMs: CHAT_TARGETS.queueWaitP95Ms,
          measuredMs: queueWaitP95,
          met: queueWaitP95 === null ? null : queueWaitP95 <= CHAT_TARGETS.queueWaitP95Ms,
        },
        {
          label: "Chat handling (p95)",
          targetMs: CHAT_TARGETS.handleP95Ms,
          measuredMs: handleP95,
          met: handleP95 === null ? null : handleP95 <= CHAT_TARGETS.handleP95Ms,
        },
        {
          label: "Chat first reply (p95)",
          targetMs: CHAT_TARGETS.firstReplyP95Ms,
          measuredMs: firstReplyP95,
          met: firstReplyP95 === null ? null : firstReplyP95 <= CHAT_TARGETS.firstReplyP95Ms,
        },
        {
          label: "Chat helper model (p95)",
          targetMs: CHAT_TARGETS.responderP95Ms,
          measuredMs: responderP95,
          met: responderP95 === null ? null : responderP95 <= CHAT_TARGETS.responderP95Ms,
        },
      ],
    };
  }
}

/** The slowest target a sample can miss, so one log line says whether this message was a problem. */
export function chatLatencyBreaches(sample: ChatLatencySample): string[] {
  const breaches: string[] = [];
  if (sample.timedOut) breaches.push(`abandoned after the ${CHAT_TARGETS.handleP95Ms} ms handling target`);
  if (sample.queueWaitMs !== null && sample.queueWaitMs > CHAT_TARGETS.queueWaitP95Ms) {
    breaches.push(`queue wait ${sample.queueWaitMs} ms > ${CHAT_TARGETS.queueWaitP95Ms} ms`);
  }
  if (sample.handleMs !== null && sample.handleMs > CHAT_TARGETS.handleP95Ms) {
    breaches.push(`handling ${sample.handleMs} ms > ${CHAT_TARGETS.handleP95Ms} ms`);
  }
  if (sample.firstReplyMs !== null && sample.firstReplyMs > CHAT_TARGETS.firstReplyP95Ms) {
    breaches.push(`first reply ${sample.firstReplyMs} ms > ${CHAT_TARGETS.firstReplyP95Ms} ms`);
  }
  if (sample.responderMs !== null && sample.responderMs > CHAT_TARGETS.responderP95Ms) {
    breaches.push(`helper model ${sample.responderMs} ms > ${CHAT_TARGETS.responderP95Ms} ms`);
  }
  return breaches;
}
