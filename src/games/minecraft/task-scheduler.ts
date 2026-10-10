import type { MinecraftTask } from "./task.js";
import type { MinecraftTaskResult } from "./task-runner.js";

/**
 * The single authority over which task may run on the agent.
 *
 * Before this existed, five code paths (the CLI, the Control Center, the Library, the companion and the
 * autonomy loop) each checked `control.task` and then set it a few awaits later. Whichever got there first
 * won, a loser threw "A task is already running", and a throw between the check and the `finally` leaked the
 * lock forever. Here the admission decision and the slot assignment are one synchronous step, the slot is
 * released in exactly one place, and every refusal carries a stable code and a sentence an operator can act on.
 *
 * Rules, all enforced in `submit`:
 *  - one task runs at a time; there is never a second concurrent runner;
 *  - the same task (same parameters) cannot be running or queued twice;
 *  - operator origins outrank the agent's own autonomy: an autonomous task is asked to stop at the next
 *    action boundary and the operator task starts as soon as the slot is free;
 *  - autonomy never queues and never starts while anything else is running, queued or reserved;
 *  - a startup reservation lets the CLI hold the slot for its requested task before the first observation,
 *    so autonomy cannot take the idle window; it expires by itself, so it can never wedge the agent;
 *  - after `drain` nothing new is accepted, queued tasks are cancelled and the running one is asked to stop.
 */

export type TaskOrigin = "cli" | "control-center" | "library" | "companion" | "autonomy";

/** Higher wins. Only `autonomy` can be pre-empted; every other origin is an explicit request from a person. */
export const TASK_ORIGIN_PRIORITY: Readonly<Record<TaskOrigin, number>> = {
  cli: 100,
  "control-center": 90,
  library: 80,
  companion: 50,
  autonomy: 10,
};

const PREEMPTIBLE_ORIGINS: ReadonlySet<TaskOrigin> = new Set<TaskOrigin>(["autonomy"]);

export type SchedulerRefusalCode =
  | "TASK_ALREADY_RUNNING"
  | "TASK_DUPLICATE"
  | "TASK_QUEUE_FULL"
  | "SCHEDULER_RESERVED"
  | "SCHEDULER_CLOSED"
  | "TASK_REFUSED";

/** Thrown to callers that await a task the scheduler refused to start. The message is safe to show verbatim. */
export class TaskAdmissionError extends Error {
  constructor(
    readonly code: SchedulerRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskAdmissionError";
  }
}

/** Rejects the completion promise of a task that was cancelled while it was still waiting in the queue. */
export class TaskCancelledError extends Error {
  readonly code = "TASK_CANCELLED";
  constructor(readonly reason: string) {
    super(`The task was cancelled before it started: ${reason}`);
    this.name = "TaskCancelledError";
  }
}

export type TicketState = "queued" | "running" | "finished" | "cancelled" | "errored";

export interface SchedulerTicketView {
  readonly ticketId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly label: string;
  readonly origin: TaskOrigin;
  readonly state: TicketState;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** The runner's own verdict once it finished (`succeeded`, `failed`, `blocked`, ...). Null before that. */
  readonly status: MinecraftTaskResult["status"] | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly actions: number | null;
  readonly elapsedMs: number | null;
  /** 0..1 of the task's target as the runner measured it; null when the task never ran. */
  readonly progressRatio: number | null;
  /** Why a task that did not run to completion ended early: a cancel reason, a pre-emption or a start error. */
  readonly note: string | null;
  /** Position in the queue (1 = next). Null unless queued. */
  readonly position: number | null;
}

export interface SchedulerSnapshot {
  readonly state: "idle" | "running" | "reserved" | "closed";
  readonly active: SchedulerTicketView | null;
  readonly queue: readonly SchedulerTicketView[];
  readonly history: readonly SchedulerTicketView[];
  readonly reservation: { readonly owner: TaskOrigin; readonly label: string; readonly since: string; readonly expiresAt: string } | null;
  readonly limits: { readonly maxQueue: number; readonly maxHistory: number };
  readonly counters: {
    readonly submitted: number;
    readonly started: number;
    readonly finished: number;
    readonly refused: number;
    readonly cancelled: number;
    readonly preemptions: number;
    readonly errored: number;
  };
  /** The most recent refusal, so a UI can explain why a click did nothing. */
  readonly lastRefusal: { readonly at: string; readonly origin: TaskOrigin; readonly code: SchedulerRefusalCode; readonly message: string } | null;
}

export type SchedulerEvent =
  | { readonly type: "queued"; readonly ticket: SchedulerTicketView }
  | { readonly type: "started"; readonly ticket: SchedulerTicketView }
  | { readonly type: "finished"; readonly ticket: SchedulerTicketView }
  | { readonly type: "cancelled"; readonly ticket: SchedulerTicketView }
  | { readonly type: "errored"; readonly ticket: SchedulerTicketView }
  | { readonly type: "preempting"; readonly ticket: SchedulerTicketView; readonly by: SchedulerTicketView }
  | { readonly type: "refused"; readonly origin: TaskOrigin; readonly taskId: string; readonly code: SchedulerRefusalCode; readonly message: string }
  | { readonly type: "reserved"; readonly owner: TaskOrigin; readonly label: string }
  | { readonly type: "reservation-released"; readonly owner: TaskOrigin; readonly reason: "consumed" | "released" | "expired" }
  | { readonly type: "closed"; readonly reason: string };

export interface SchedulerRunContext {
  readonly ticketId: string;
  readonly origin: TaskOrigin;
  /** Aborts when the scheduler is drained; the runner's own cooperative stop is `requestStop`. */
  readonly signal: AbortSignal;
}

export interface TaskSchedulerOptions {
  /** Executes exactly one task. Called synchronously from `submit` when the slot is free. */
  readonly run: (task: MinecraftTask, context: SchedulerRunContext) => Promise<MinecraftTaskResult>;
  /** Asks the running task to stop at the next action boundary. */
  readonly requestStop: (reason: string) => void;
  /**
   * Last check before a task is admitted (safety hold, disconnected adapter, ...). Return a sentence to
   * refuse. Autonomy refusals are expected and are not reported as errors by the callers.
   */
  readonly gate?: (origin: TaskOrigin, task: MinecraftTask) => string | null;
  readonly onEvent?: (event: SchedulerEvent) => void;
  readonly now?: () => number;
  readonly maxQueue?: number;
  readonly maxHistory?: number;
  /** How long a startup reservation holds the slot when its owner never submits. */
  readonly reservationTtlMs?: number;
}

export type SubmitRequest = {
  readonly task: MinecraftTask;
  readonly origin: TaskOrigin;
  /** `queue` runs the task after the current one; `reject` refuses when the agent is busy. Default `reject`. */
  readonly whenBusy?: "queue" | "reject";
  readonly label?: string;
};

export type Submission =
  | {
      readonly accepted: true;
      readonly ticketId: string;
      /** 0 when the task started immediately, otherwise its place in the queue (1 = next). */
      readonly position: number;
      /** True when an autonomous task was asked to stop to make room. */
      readonly preempting: boolean;
      /** Settles with the runner's result. Rejects with `TaskCancelledError` or an `Error` if the run itself threw. */
      readonly done: Promise<MinecraftTaskResult>;
    }
  | { readonly accepted: false; readonly code: SchedulerRefusalCode; readonly message: string };

export interface Reservation {
  readonly owner: TaskOrigin;
  release(): void;
}

interface Ticket {
  readonly id: string;
  readonly task: MinecraftTask;
  readonly origin: TaskOrigin;
  readonly signature: string;
  readonly label: string;
  readonly queuedAtMs: number;
  state: TicketState;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  result: MinecraftTaskResult | null;
  note: string | null;
  readonly controller: AbortController;
  readonly resolve: (result: MinecraftTaskResult) => void;
  readonly reject: (error: Error) => void;
  readonly done: Promise<MinecraftTaskResult>;
  settled: Promise<void> | null;
}

const DEFAULT_MAX_QUEUE = 5;
const DEFAULT_MAX_HISTORY = 50;
const DEFAULT_RESERVATION_TTL_MS = 30_000;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Two tasks with the same signature ask the agent to do the same thing; only their ids differ. */
export function taskSignature(task: MinecraftTask): string {
  const { id: _id, ...rest } = task as MinecraftTask & { id: string };
  void _id;
  return stableStringify(rest);
}

/** A short human label for a task, used in the queue and in event text. */
export function describeTask(task: MinecraftTask): string {
  switch (task.kind) {
    case "gather_resource":
      return `Gather ${task.targetCount} ${task.resourceName}`;
    case "mine_resource":
      return `Mine ${task.targetCount} ${task.resourceName}`;
    case "craft_item":
      return `Craft ${task.targetCount} ${task.targetItem}`;
    case "secure_food":
      return `Secure food (hunger ${task.targetHunger})`;
    case "build_shelter":
      return `Build shelter (${task.mode})`;
    default:
      return String((task as { kind?: unknown }).kind ?? "task");
  }
}

export class TaskScheduler {
  private readonly maxQueue: number;
  private readonly maxHistory: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;
  private active: Ticket | null = null;
  private queue: Ticket[] = [];
  private history: SchedulerTicketView[] = [];
  private reservation: { owner: TaskOrigin; label: string; sinceMs: number; expiresMs: number } | null = null;
  private closed = false;
  private sequence = 0;
  private lastRefusal: SchedulerSnapshot["lastRefusal"] = null;
  private readonly counters = { submitted: 0, started: 0, finished: 0, refused: 0, cancelled: 0, preemptions: 0, errored: 0 };

  constructor(private readonly options: TaskSchedulerOptions) {
    this.maxQueue = Math.max(0, options.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.maxHistory = Math.max(1, options.maxHistory ?? DEFAULT_MAX_HISTORY);
    this.reservationTtlMs = Math.max(1, options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS);
    this.now = options.now ?? (() => Date.now());
  }

  /** True while a task holds the slot. */
  get busy(): boolean {
    return this.active !== null;
  }

  get activeTask(): MinecraftTask | null {
    return this.active?.task ?? null;
  }

  get activeOrigin(): TaskOrigin | null {
    return this.active?.origin ?? null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True when `origin` could start a task right now (idle, not reserved against it, not closed). */
  canStartNow(origin: TaskOrigin): boolean {
    if (this.closed || this.active !== null || this.queue.length > 0) return false;
    this.expireReservation();
    return this.reservation === null || this.reservation.owner === origin;
  }

  /**
   * Holds the slot for `owner` until it submits (which consumes the reservation), releases it, or the TTL
   * passes. While held, no origin of equal or lower priority can start or queue a task.
   */
  reserve(owner: TaskOrigin, label: string): Reservation {
    this.expireReservation();
    const nowMs = this.now();
    this.reservation = { owner, label, sinceMs: nowMs, expiresMs: nowMs + this.reservationTtlMs };
    this.emit({ type: "reserved", owner, label });
    const mine = this.reservation;
    return {
      owner,
      release: () => {
        if (this.reservation === mine) {
          this.reservation = null;
          this.emit({ type: "reservation-released", owner, reason: "released" });
        }
      },
    };
  }

  submit(request: SubmitRequest): Submission {
    const { task, origin } = request;
    this.counters.submitted += 1;
    if (this.closed) return this.refuse(request, "SCHEDULER_CLOSED", "The agent session is shutting down and accepts no new tasks.");
    this.expireReservation();

    const refusedByGate = this.options.gate?.(origin, task) ?? null;
    if (refusedByGate) return this.refuse(request, "TASK_REFUSED", refusedByGate);

    const reservation = this.reservation;
    if (reservation && reservation.owner !== origin && TASK_ORIGIN_PRIORITY[origin] <= TASK_ORIGIN_PRIORITY[reservation.owner]) {
      return this.refuse(
        request,
        "SCHEDULER_RESERVED",
        `The agent is holding the next slot for the ${reservation.owner} task '${reservation.label}'; try again once it has started.`,
      );
    }

    const signature = taskSignature(task);
    const holder = this.findNonPreemptibleDuplicate(signature);
    if (holder) {
      return this.refuse(
        request,
        "TASK_DUPLICATE",
        `'${describeTask(task)}' is already ${holder.state === "running" ? "running" : `queued (position ${this.positionOf(holder)})`}; it was not started a second time.`,
      );
    }

    const running = this.active;
    if (running === null && this.queue.length === 0) {
      const ticket = this.createTicket(request, signature);
      this.consumeReservation(origin);
      this.begin(ticket);
      return { accepted: true, ticketId: ticket.id, position: 0, preempting: false, done: ticket.done };
    }

    // Busy from here on.
    if (origin === "autonomy") {
      return this.refuse(request, "TASK_ALREADY_RUNNING", "The agent is busy; autonomy does not queue work behind an operator task.");
    }
    const preemptible = running !== null && PREEMPTIBLE_ORIGINS.has(running.origin) && TASK_ORIGIN_PRIORITY[origin] > TASK_ORIGIN_PRIORITY[running.origin];
    if (!preemptible && request.whenBusy !== "queue") {
      const current = running ? `'${running.label}' (${running.origin})` : "a queued task";
      return this.refuse(request, "TASK_ALREADY_RUNNING", `A task is already running: ${current}. Stop it or queue this one to run after it.`);
    }
    if (!preemptible && this.queue.length >= this.maxQueue) {
      return this.refuse(request, "TASK_QUEUE_FULL", `The task queue is full (${this.maxQueue}); cancel a queued task first.`);
    }

    const ticket = this.createTicket(request, signature);
    this.consumeReservation(origin);
    if (preemptible && running) {
      // The operator's task goes to the front; the autonomous one is asked to stop at its next action boundary.
      this.queue.unshift(ticket);
      this.counters.preemptions += 1;
      this.emit({ type: "queued", ticket: this.view(ticket) });
      this.emit({ type: "preempting", ticket: this.view(running), by: this.view(ticket) });
      running.note = `Stopped to make room for the ${origin} task '${ticket.label}'.`;
      try {
        this.options.requestStop(`preempted by ${origin} task '${ticket.label}'`);
      } catch (error) {
        // A stop request that throws must not strand the queued operator task; it still starts when the slot frees.
        void error;
      }
      return { accepted: true, ticketId: ticket.id, position: 1, preempting: true, done: ticket.done };
    }
    this.insertByPriority(ticket);
    this.emit({ type: "queued", ticket: this.view(ticket) });
    return { accepted: true, ticketId: ticket.id, position: this.positionOf(ticket), preempting: false, done: ticket.done };
  }

  /** Cancels a queued task, or asks the running one to stop. Returns what happened, or null if the id is unknown. */
  cancel(ticketId: string, reason = "cancelled by the operator"): "cancelled" | "stop-requested" | null {
    const queued = this.queue.find((ticket) => ticket.id === ticketId);
    if (queued) {
      this.queue = this.queue.filter((ticket) => ticket !== queued);
      this.cancelTicket(queued, reason);
      return "cancelled";
    }
    if (this.active?.id === ticketId) {
      this.options.requestStop(reason);
      return "stop-requested";
    }
    return null;
  }

  /** Cancels everything that is waiting; the running task is untouched. Returns how many were cancelled. */
  clearQueue(reason = "queue cleared by the operator"): number {
    const waiting = this.queue;
    this.queue = [];
    for (const ticket of waiting) this.cancelTicket(ticket, reason);
    return waiting.length;
  }

  /** Asks the running task to stop. Returns false when nothing is running. */
  stopActive(reason: string): boolean {
    if (!this.active) return false;
    this.options.requestStop(reason);
    return true;
  }

  /** Resolves once nothing is running and nothing is queued. */
  async idle(): Promise<void> {
    while (this.active !== null || this.queue.length > 0) {
      const current = this.active?.settled;
      if (current) await current;
      else await Promise.resolve();
    }
  }

  /**
   * Orderly shutdown of scheduling: refuse new tasks, cancel the queue, stop the running task and wait for it
   * to settle. Resolves with `settled: false` if the running task did not finish within `timeoutMs`; the
   * caller then knows an async operation may still be winding down and says so instead of pretending.
   */
  async drain(reason: string, timeoutMs = 10_000): Promise<{ readonly settled: boolean; readonly cancelled: number }> {
    if (!this.closed) {
      this.closed = true;
      this.reservation = null;
      this.emit({ type: "closed", reason });
    }
    const cancelled = this.clearQueue(reason);
    const running = this.active;
    if (!running) return { settled: true, cancelled };
    running.controller.abort(new Error(reason));
    try {
      this.options.requestStop(reason);
    } catch (error) {
      void error;
    }
    const settled = running.settled ?? Promise.resolve();
    let timer: NodeJS.Timeout | null = null;
    const outcome = await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { settled: outcome, cancelled };
  }

  snapshot(): SchedulerSnapshot {
    this.expireReservation();
    const reservation = this.reservation;
    return {
      state: this.closed ? "closed" : this.active ? "running" : reservation ? "reserved" : "idle",
      active: this.active ? this.view(this.active) : null,
      queue: this.queue.map((ticket) => this.view(ticket)),
      history: [...this.history],
      reservation: reservation
        ? {
            owner: reservation.owner,
            label: reservation.label,
            since: new Date(reservation.sinceMs).toISOString(),
            expiresAt: new Date(reservation.expiresMs).toISOString(),
          }
        : null,
      limits: { maxQueue: this.maxQueue, maxHistory: this.maxHistory },
      counters: { ...this.counters },
      lastRefusal: this.lastRefusal,
    };
  }

  // ---- internals -------------------------------------------------------------------------------------

  private createTicket(request: SubmitRequest, signature: string): Ticket {
    this.sequence += 1;
    let resolve!: (result: MinecraftTaskResult) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<MinecraftTaskResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Fire-and-forget callers (autonomy, the UI) never await `done`; their rejection must not become unhandled.
    done.catch(() => undefined);
    return {
      id: `t-${this.sequence}`,
      task: request.task,
      origin: request.origin,
      signature,
      label: request.label ?? describeTask(request.task),
      queuedAtMs: this.now(),
      state: "queued",
      startedAtMs: null,
      finishedAtMs: null,
      result: null,
      note: null,
      controller: new AbortController(),
      resolve,
      reject,
      done,
      settled: null,
    };
  }

  /** Takes the slot and starts the runner. The runner's synchronous prefix executes before `submit` returns. */
  private begin(ticket: Ticket): void {
    this.active = ticket;
    ticket.state = "running";
    ticket.startedAtMs = this.now();
    this.counters.started += 1;
    this.emit({ type: "started", ticket: this.view(ticket) });
    ticket.settled = (async () => {
      let failure: Error | null = null;
      try {
        ticket.result = await this.options.run(ticket.task, {
          ticketId: ticket.id,
          origin: ticket.origin,
          signal: ticket.controller.signal,
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        // The only place the slot is released: whatever the runner did, nothing can leave it held.
        ticket.finishedAtMs = this.now();
        this.active = null;
      }
      if (failure) {
        ticket.state = "errored";
        ticket.note = failure.message;
        this.counters.errored += 1;
        this.remember(ticket);
        this.emit({ type: "errored", ticket: this.view(ticket) });
        ticket.reject(failure);
      } else {
        ticket.state = "finished";
        this.counters.finished += 1;
        this.remember(ticket);
        this.emit({ type: "finished", ticket: this.view(ticket) });
        ticket.resolve(ticket.result as MinecraftTaskResult);
      }
      this.startNext();
    })();
  }

  private startNext(): void {
    if (this.closed || this.active !== null) return;
    const next = this.queue.shift();
    if (next) this.begin(next);
  }

  private cancelTicket(ticket: Ticket, reason: string): void {
    ticket.state = "cancelled";
    ticket.finishedAtMs = this.now();
    ticket.note = reason;
    this.counters.cancelled += 1;
    this.remember(ticket);
    this.emit({ type: "cancelled", ticket: this.view(ticket) });
    ticket.reject(new TaskCancelledError(reason));
  }

  private remember(ticket: Ticket): void {
    this.history.unshift(this.view(ticket));
    if (this.history.length > this.maxHistory) this.history.length = this.maxHistory;
  }

  private findNonPreemptibleDuplicate(signature: string): Ticket | null {
    const candidates = this.active ? [this.active, ...this.queue] : [...this.queue];
    return candidates.find((ticket) => ticket.signature === signature && !PREEMPTIBLE_ORIGINS.has(ticket.origin)) ?? null;
  }

  private insertByPriority(ticket: Ticket): void {
    const priority = TASK_ORIGIN_PRIORITY[ticket.origin];
    let index = this.queue.length;
    while (index > 0 && TASK_ORIGIN_PRIORITY[this.queue[index - 1]!.origin] < priority) index -= 1;
    this.queue.splice(index, 0, ticket);
  }

  private positionOf(ticket: Ticket): number {
    const index = this.queue.indexOf(ticket);
    return index === -1 ? 0 : index + 1;
  }

  private expireReservation(): void {
    if (this.reservation && this.now() > this.reservation.expiresMs) {
      const owner = this.reservation.owner;
      this.reservation = null;
      this.emit({ type: "reservation-released", owner, reason: "expired" });
    }
  }

  private consumeReservation(origin: TaskOrigin): void {
    if (this.reservation && this.reservation.owner === origin) {
      this.reservation = null;
      this.emit({ type: "reservation-released", owner: origin, reason: "consumed" });
    }
  }

  private refuse(request: SubmitRequest, code: SchedulerRefusalCode, message: string): Submission {
    this.counters.refused += 1;
    this.lastRefusal = { at: new Date(this.now()).toISOString(), origin: request.origin, code, message };
    this.emit({ type: "refused", origin: request.origin, taskId: request.task.id, code, message });
    return { accepted: false, code, message };
  }

  private view(ticket: Ticket): SchedulerTicketView {
    const result = ticket.result;
    return {
      ticketId: ticket.id,
      taskId: ticket.task.id,
      kind: ticket.task.kind,
      label: ticket.label,
      origin: ticket.origin,
      state: ticket.state,
      queuedAt: new Date(ticket.queuedAtMs).toISOString(),
      startedAt: ticket.startedAtMs === null ? null : new Date(ticket.startedAtMs).toISOString(),
      finishedAt: ticket.finishedAtMs === null ? null : new Date(ticket.finishedAtMs).toISOString(),
      status: result?.status ?? null,
      failure: result?.failure ? { code: result.failure.code, message: result.failure.message } : null,
      actions: result ? result.metrics.actions : null,
      elapsedMs: result ? result.metrics.elapsedMs : ticket.startedAtMs !== null && ticket.finishedAtMs !== null ? ticket.finishedAtMs - ticket.startedAtMs : null,
      progressRatio: result ? result.metrics.progressRatio : null,
      note: ticket.note,
      position: ticket.state === "queued" ? this.positionOf(ticket) : null,
    };
  }

  private emit(event: SchedulerEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // An observer must never be able to break scheduling.
    }
  }
}
