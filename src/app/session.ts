import type { Logger } from "pino";
import type { GameAdapter } from "../core/types.js";
import type { GameMindRuntime } from "../core/game-mind-runtime.js";
import type { SkillRuntime } from "../core/skill-runtime.js";
import type { SafetyBroker } from "../core/safety-broker.js";
import type { RingBufferTraceSink } from "../core/trace.js";
import type { ExperienceLearner } from "../core/learning/learner.js";
import type { TrainingManager } from "../training/manager.js";
import { attachMinecraftRunHost, type MinecraftRunHost, type MinecraftRunHostOptions } from "../games/minecraft/attach-control-center.js";
import type { MinecraftObservation } from "../games/minecraft/observation.js";
import type { WorldMemory } from "../games/minecraft/world-memory.js";
import type { MinecraftTask } from "../games/minecraft/task.js";
import type { MinecraftTaskResult } from "../games/minecraft/task-runner.js";
import type { SchedulerEvent } from "../games/minecraft/task-scheduler.js";
import { PersistentWorldMemory } from "../games/minecraft/persistent-world-memory.js";
import type { AppEventLog, AppEventInput, AppEventSource } from "./event-log.js";
import { diagnoseConnectionFailure, type ConnectionDiagnosis, type PlatformInfo, type WindowsHostCandidates } from "./platform.js";
import {
  diagnosisToErrorView,
  type ConnectRequest,
  type SessionErrorView,
  type SessionMode,
  type SessionPhase,
  type SessionReconnectView,
  type SessionSource,
  type SessionState,
  type SessionStateChange,
  type SessionTarget,
  type SessionView,
} from "./types.js";

/**
 * Everything one agent session is built from. A factory produces it (the real Mineflayer adapter for a live
 * server, the deterministic simulator for offline work); the session itself never knows which, so the lifecycle
 * below is exercised identically against both.
 */
export interface SessionResources {
  readonly source: SessionSource;
  readonly adapter: GameAdapter<MinecraftObservation>;
  readonly runtime: GameMindRuntime<MinecraftObservation>;
  readonly skills: SkillRuntime;
  readonly safety: SafetyBroker | null;
  readonly ring: RingBufferTraceSink;
  readonly createRunner: MinecraftRunHostOptions["createRunner"];
  readonly learner: ExperienceLearner | null;
  readonly target: SessionTarget | null;
  readonly offlineNote: string | null;
  readonly evaluationScenarioIds: readonly string[];
  readonly onTaskFinished?: MinecraftRunHostOptions["onTaskFinished"];
  /** Known only after the first observation, because the dimension is part of a world's identity. */
  worldKeyFor(dimension: string | null): string;
  /** Opens (or creates) the persistent memory for a world; null when memory is not persisted. */
  openMemory?(worldKey: string): Promise<WorldMemory>;
}

export interface ReconnectPolicy {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { enabled: true, maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 30_000 };

export interface SessionHostSettings {
  readonly dataDirectory?: string;
  readonly trainingDirectory?: string;
  readonly worldConfigPath?: string;
  readonly companionMemoryDirectory?: string | null;
  readonly evaluationReportPath?: string | null;
  readonly training?: TrainingManager | null;
}

export interface SessionOptions {
  readonly id: string;
  readonly request: ConnectRequest;
  readonly resources: SessionResources;
  readonly events: AppEventLog;
  readonly logger: Logger;
  readonly host?: SessionHostSettings;
  readonly reconnect?: ReconnectPolicy;
  readonly platform?: PlatformInfo | null;
  readonly windowsHost?: () => Promise<WindowsHostCandidates | null>;
  readonly now?: () => number;
  /** Cancellable delay; injectable so reconnect tests need no real waiting. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Longest a single shutdown step may take before the supervisor moves on and reports it. */
  readonly stepTimeoutMs?: number;
  /** Test hook for the attach step. */
  readonly attachHost?: typeof attachMinecraftRunHost;
}

/** Thrown by `start()` when the session could not be established. It carries the diagnosis the UI shows. */
export class SessionStartError extends Error {
  constructor(readonly diagnosis: ConnectionDiagnosis) {
    super(`${diagnosis.summary} ${diagnosis.detail ? `(${diagnosis.detail})` : ""}`.trim());
    this.name = "SessionStartError";
  }
}

export interface SessionEnd {
  readonly reason: string;
  readonly error: SessionErrorView | null;
  readonly endedAt: string;
}

export interface StartupOutcome {
  readonly result: MinecraftTaskResult | null;
  readonly error: Error | null;
}

const HISTORY_LIMIT = 40;
const NON_RETRYABLE_DISCONNECT = /banned|whitelist|outdated|incompatible|unsupported|authenticat|verify username|invalid session/i;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class MinecraftSession {
  readonly id: string;
  private readonly request: ConnectRequest;
  private readonly resources: SessionResources;
  private readonly events: AppEventLog;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly abort = new AbortController();
  private readonly history: SessionStateChange[] = [];
  private readonly createdAtMs: number;
  private readonly eventSource: AppEventSource;
  private phase: SessionPhase = "connecting";
  private phaseSinceMs: number;
  private reason: string | null = null;
  private error: SessionErrorView | null = null;
  private reconnectView: SessionReconnectView | null = null;
  private connectedAtMs: number | null = null;
  private endedAtMs: number | null = null;
  private worldKey: string | null = null;
  private hostValue: MinecraftRunHost | null = null;
  private memory: WorldMemory | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private lastViewState: SessionState | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private startupPromise: Promise<StartupOutcome> | null = null;
  private readonly endResolvers: Array<(end: SessionEnd) => void> = [];
  private endValue: SessionEnd | null = null;

  constructor(private readonly options: SessionOptions) {
    this.id = options.id;
    this.request = options.request;
    this.resources = options.resources;
    this.events = options.events;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.reconnectPolicy = options.reconnect ?? DEFAULT_RECONNECT_POLICY;
    this.createdAtMs = this.now();
    this.phaseSinceMs = this.createdAtMs;
    this.eventSource = options.resources.source === "live" ? "live" : "simulated";
    this.push("connecting", `connecting${options.resources.target ? ` to ${options.resources.target.host}:${options.resources.target.port}` : ""}`);
  }

  get mode(): SessionMode {
    return this.request.mode ?? "persistent";
  }

  /** The run host once the session is initialised; null while connecting, after a failed start and after shutdown. */
  get host(): MinecraftRunHost | null {
    return this.hostValue;
  }

  get runtime(): GameMindRuntime<MinecraftObservation> {
    return this.resources.runtime;
  }

  get isActive(): boolean {
    return this.phase !== "shutdown";
  }

  get currentPhase(): SessionPhase {
    return this.phase;
  }

  /** Resolves with the startup task's outcome (or null outcome when none was requested) once it has ended. */
  get startup(): Promise<StartupOutcome | null> {
    return this.startupPromise ?? Promise.resolve(null);
  }

  /** Resolves once, after teardown has completed, with why the session ended. */
  get ended(): Promise<SessionEnd> {
    if (this.endValue) return Promise.resolve(this.endValue);
    return new Promise((resolve) => this.endResolvers.push(resolve));
  }

  /** The operator-facing state: `ready` splits into idle and running by whether the scheduler holds a task. */
  get state(): SessionState {
    if (this.phase === "ready") return this.hostValue?.scheduler.busy ? "running" : "idle";
    return this.phase;
  }

  start(): Promise<void> {
    this.startPromise ??= this.runStart();
    return this.startPromise;
  }

  /** Orderly shutdown; safe to call any number of times from any state. */
  stop(reason: string): Promise<void> {
    this.stopPromise ??= this.runStop(reason);
    return this.stopPromise;
  }

  view(): SessionView {
    const nowMs = this.now();
    const state = this.state;
    return {
      id: this.id,
      state,
      mode: this.mode,
      source: this.resources.source,
      since: new Date(this.phaseSinceMs).toISOString(),
      createdAt: new Date(this.createdAtMs).toISOString(),
      connectedAt: this.connectedAtMs === null ? null : new Date(this.connectedAtMs).toISOString(),
      runtimeMs: Math.max(0, (this.endedAtMs ?? nowMs) - this.createdAtMs),
      target: this.resources.target,
      worldKey: this.worldKey,
      reason: this.reason,
      error: this.error,
      reconnect: this.reconnectView,
      history: [...this.history],
      autonomy: this.hostValue ? this.hostValue.autonomyEnabled : this.request.autonomy !== false,
      canConnect: this.phase === "shutdown",
      canStop: this.phase !== "shutdown" && this.phase !== "stopping",
    };
  }

  /** True once a stop has begun. A method (not an inline comparison) because the phase changes across awaits. */
  private isReconnecting(): boolean {
    return this.phase === "reconnecting";
  }

  private isEnding(): boolean {
    return this.phase === "stopping" || this.phase === "shutdown";
  }

  // ---- start -----------------------------------------------------------------------------------------

  private async runStart(): Promise<void> {
    const { runtime } = this.resources;
    this.record({ category: "connection", code: "SESSION_CONNECTING", message: `Connecting${this.targetText()}`, data: this.targetData() });
    try {
      await runtime.connect();
    } catch (error) {
      if (this.isEnding()) return;
      const diagnosis = await this.diagnose(error);
      this.error = diagnosisToErrorView(diagnosis);
      this.record({ level: "error", category: "connection", code: diagnosis.code, message: `Connection failed: ${diagnosis.summary}`, data: { detail: diagnosis.detail, retryable: diagnosis.retryable } });
      await this.stop(`connection failed: ${diagnosis.code}`);
      throw new SessionStartError(diagnosis);
    }
    if (this.isEnding()) return;
    this.connectedAtMs = this.now();
    this.push("initializing", "connected; loading world memory and starting the agent");
    this.record({ category: "connection", code: "SESSION_CONNECTED", message: `Connected${this.targetText()}`, data: { sessionId: runtime.session?.id ?? null, gameVersion: runtime.session?.gameVersion ?? null } });
    try {
      await this.initialise();
    } catch (error) {
      if (this.isEnding()) return;
      const message = error instanceof Error ? error.message : String(error);
      this.error = { code: "INITIALISATION_FAILED", summary: "The session connected but could not finish starting.", hints: ["The details below come from the failing step; the session was shut down cleanly."], detail: message, retryable: true };
      this.record({ level: "error", category: "error", code: "INITIALISATION_FAILED", message: `Session initialisation failed: ${message}` });
      await this.stop("initialisation failed");
      throw error instanceof Error ? error : new Error(message);
    }
    if (this.isEnding()) return;
    this.push("ready", "ready");
    this.unsubscribeStatus = this.resources.adapter.onStatusChange((change) => this.onAdapterChange(change.status, change.reason));
    this.record({ category: "session", code: "SESSION_READY", message: `Session ready (${this.mode}); autonomy ${this.hostValue?.autonomyEnabled ? "on" : "off"}` });
    this.beginStartupTask();
  }

  private async initialise(): Promise<void> {
    const { runtime } = this.resources;
    const world = runtime.currentWorldState;
    const dimension = world?.state.player.dimension ?? null;
    this.worldKey = this.request.worldKey ? `${this.request.worldKey}:${dimension ?? "unknown"}` : this.resources.worldKeyFor(dimension);
    this.memory = this.resources.openMemory ? await this.resources.openMemory(this.worldKey) : null;
    if (this.memory && world) this.memory.observe(world.state, world.sequence);
    this.record({ category: "memory", code: "MEMORY_OPENED", message: `World memory opened for ${this.worldKey}`, data: { worldKey: this.worldKey, persistent: this.memory instanceof PersistentWorldMemory } });
    const settings = this.options.host ?? {};
    const attach = this.options.attachHost ?? attachMinecraftRunHost;
    this.hostValue = await attach({
      runtime,
      skills: this.resources.skills,
      safety: this.resources.safety,
      traceSink: this.resources.ring,
      logger: this.logger,
      ...(this.resources.learner ? { learner: this.resources.learner } : {}),
      worldKey: this.worldKey,
      ...(this.memory ? { memory: this.memory } : {}),
      offlineNote: this.resources.offlineNote,
      worldSource: this.resources.source,
      evaluationScenarioIds: this.resources.evaluationScenarioIds,
      title: this.resources.source === "simulated" ? "GameMind (offline world)" : "GameMind",
      startServer: false,
      autonomous: this.request.autonomy !== false,
      ...(this.request.startupTask ? { startupTask: this.request.startupTask } : {}),
      ...(settings.dataDirectory ? { dataDirectory: settings.dataDirectory } : {}),
      ...(settings.trainingDirectory ? { trainingDirectory: settings.trainingDirectory } : {}),
      ...(settings.worldConfigPath ? { worldConfigPath: settings.worldConfigPath } : {}),
      ...(settings.companionMemoryDirectory !== undefined ? { companionMemoryDirectory: settings.companionMemoryDirectory } : {}),
      ...(settings.evaluationReportPath !== undefined ? { evaluationReportPath: settings.evaluationReportPath } : {}),
      ...(settings.training !== undefined ? { training: settings.training } : {}),
      scheduler: { onEvent: (event) => this.onSchedulerEvent(event) },
      createRunner: this.resources.createRunner,
      ...(this.resources.onTaskFinished ? { onTaskFinished: this.resources.onTaskFinished } : {}),
    });
  }

  private beginStartupTask(): void {
    const task = this.request.startupTask;
    const host = this.hostValue;
    if (!task || !host) return;
    this.startupPromise = (async (): Promise<StartupOutcome> => {
      try {
        const result = await host.runTask(task);
        return { result, error: null };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.record({ level: "error", category: "task", code: "STARTUP_TASK_FAILED", message: `The requested task could not run: ${failure.message}` });
        return { result: null, error: failure };
      } finally {
        if (this.mode === "one-shot") {
          // One-shot is the explicit, opt-in way to end with the task. The default persistent mode never gets here.
          void this.stop("one-shot task finished");
        }
      }
    })();
  }

  // ---- supervision -----------------------------------------------------------------------------------

  private onAdapterChange(status: string, reason: string | null): void {
    if (this.phase !== "ready") return;
    if (status !== "disconnected" && status !== "failed") return;
    const why = reason ?? `adapter ${status}`;
    this.record({ level: "warn", category: "connection", code: "SESSION_CONNECTION_LOST", message: `Connection lost: ${why}`, data: { status, reason } });
    if (this.mode === "one-shot" || !this.reconnectPolicy.enabled) {
      void this.stop(`connection lost: ${why}`);
      return;
    }
    if (NON_RETRYABLE_DISCONNECT.test(why)) {
      this.error = { code: "NOT_RETRYABLE", summary: "The server ended the session for a reason retrying cannot fix.", hints: ["Fix the cause named below, then connect again."], detail: why, retryable: false };
      void this.stop(`connection lost: ${why}`);
      return;
    }
    void this.reconnectLoop(why);
  }

  private async reconnectLoop(firstReason: string): Promise<void> {
    const { runtime } = this.resources;
    this.push("reconnecting", firstReason);
    let lastError: string | null = firstReason;
    for (let attempt = 1; attempt <= this.reconnectPolicy.maxAttempts; attempt += 1) {
      const delay = Math.min(this.reconnectPolicy.maxDelayMs, this.reconnectPolicy.baseDelayMs * 2 ** (attempt - 1));
      this.reconnectView = { attempt, maxAttempts: this.reconnectPolicy.maxAttempts, nextAttemptAt: new Date(this.now() + delay).toISOString(), lastError };
      this.record({ level: "info", category: "connection", code: "RECONNECT_SCHEDULED", message: `Reconnect attempt ${attempt}/${this.reconnectPolicy.maxAttempts} in ${Math.round(delay / 1000)} s`, data: { attempt, delayMs: delay } });
      await this.sleep(delay, this.abort.signal);
      if (!this.isReconnecting()) return;
      this.reconnectView = { attempt, maxAttempts: this.reconnectPolicy.maxAttempts, nextAttemptAt: null, lastError };
      try {
        await runtime.connect();
      } catch (error) {
        if (!this.isReconnecting()) return;
        const diagnosis = await this.diagnose(error);
        lastError = diagnosis.summary;
        this.record({ level: "warn", category: "connection", code: diagnosis.code, message: `Reconnect attempt ${attempt} failed: ${diagnosis.summary}`, data: { detail: diagnosis.detail } });
        if (!diagnosis.retryable) {
          this.error = diagnosisToErrorView(diagnosis);
          await this.stop(`reconnect failed: ${diagnosis.code}`);
          return;
        }
        continue;
      }
      if (!this.isReconnecting()) return;
      this.push("initializing", "reconnected; refreshing the world view");
      const world = runtime.currentWorldState;
      if (this.memory && world) this.memory.observe(world.state, world.sequence);
      this.reconnectView = null;
      this.push("ready", "ready after reconnect");
      this.record({ category: "connection", code: "RECONNECTED", message: `Reconnected after ${attempt} attempt(s)`, data: { attempt } });
      return;
    }
    this.error = { code: "RECONNECT_EXHAUSTED", summary: `The connection did not come back after ${this.reconnectPolicy.maxAttempts} attempts.`, hints: ["Check that the server is running, then connect again from the Control Center."], detail: lastError ?? "", retryable: true };
    await this.stop("reconnect attempts exhausted");
  }

  // ---- stop ------------------------------------------------------------------------------------------

  private async runStop(reason: string): Promise<void> {
    if (this.phase === "shutdown") return;
    this.abort.abort();
    this.reconnectView = null;
    this.push("stopping", reason);
    this.record({ category: "shutdown", code: "SESSION_STOPPING", message: `Stopping the session: ${reason}`, data: { reason } });
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    // Every step runs even if an earlier one failed or hung: a stuck task must not leave the bot connected.
    await this.step("task scheduler and run host", async () => {
      await this.hostValue?.close();
    });
    await this.step("game runtime", async () => {
      await this.resources.runtime.shutdown(reason);
    });
    await this.step("world memory", async () => {
      if (this.memory instanceof PersistentWorldMemory) await this.memory.flush();
    });
    this.endedAtMs = this.now();
    this.reason = reason;
    this.push("shutdown", reason);
    this.record({ level: this.error ? "error" : "info", category: "shutdown", code: "SESSION_SHUTDOWN", message: `Session shut down: ${reason}`, data: { reason, runtimeMs: this.endedAtMs - this.createdAtMs } });
    const end: SessionEnd = { reason, error: this.error, endedAt: new Date(this.endedAtMs).toISOString() };
    this.endValue = end;
    for (const resolve of this.endResolvers.splice(0)) resolve(end);
  }

  private async step(label: string, run: () => Promise<void>): Promise<void> {
    const limit = this.options.stepTimeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | null = null;
    try {
      const outcome = await Promise.race([
        run().then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), limit);
        }),
      ]);
      if (outcome === "timeout") {
        this.record({ level: "error", category: "shutdown", code: "SHUTDOWN_STEP_TIMEOUT", message: `Shutdown step '${label}' did not finish within ${Math.round(limit / 1000)} s; continuing` });
      }
    } catch (error) {
      this.record({ level: "error", category: "shutdown", code: "SHUTDOWN_STEP_FAILED", message: `Shutdown step '${label}' failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---- helpers ---------------------------------------------------------------------------------------

  private onSchedulerEvent(event: SchedulerEvent): void {
    const base = { sessionId: this.id, source: this.eventSource } as const;
    switch (event.type) {
      case "queued":
        this.events.record({ ...base, category: "task", code: "TASK_QUEUED", message: `Task queued: ${event.ticket.label} (${event.ticket.origin})`, data: { ticketId: event.ticket.ticketId, origin: event.ticket.origin, position: event.ticket.position } });
        break;
      case "started":
        this.events.record({ ...base, category: "task", code: "TASK_SCHEDULED", message: `Task started: ${event.ticket.label} (${event.ticket.origin})`, data: { ticketId: event.ticket.ticketId, origin: event.ticket.origin } });
        break;
      case "finished":
        this.events.record({
          ...base,
          level: event.ticket.status === "succeeded" ? "info" : "warn",
          category: "task",
          code: "TASK_FINISHED",
          message: `Task finished: ${event.ticket.label} → ${event.ticket.status ?? "unknown"}${event.ticket.failure ? ` (${event.ticket.failure.code})` : ""}`,
          data: { ticketId: event.ticket.ticketId, origin: event.ticket.origin, status: event.ticket.status, failureCode: event.ticket.failure?.code ?? null, actions: event.ticket.actions, elapsedMs: event.ticket.elapsedMs },
        });
        break;
      case "errored":
        this.events.record({ ...base, level: "error", category: "task", code: "TASK_ERRORED", message: `Task could not run: ${event.ticket.label}: ${event.ticket.note ?? "unknown error"}`, data: { ticketId: event.ticket.ticketId, origin: event.ticket.origin } });
        break;
      case "cancelled":
        this.events.record({ ...base, level: "warn", category: "task", code: "TASK_CANCELLED", message: `Task cancelled: ${event.ticket.label}: ${event.ticket.note ?? ""}`.trim(), data: { ticketId: event.ticket.ticketId, origin: event.ticket.origin } });
        break;
      case "preempting":
        this.events.record({ ...base, level: "info", category: "task", code: "TASK_PREEMPTING", message: `${event.by.origin} task '${event.by.label}' is taking over from ${event.ticket.origin} task '${event.ticket.label}'`, data: { ticketId: event.ticket.ticketId, by: event.by.ticketId } });
        break;
      case "refused":
        // Autonomy is refused constantly and legitimately (busy, reserved); logging each refusal would drown the log.
        if (event.origin !== "autonomy") {
          this.events.record({ ...base, level: "warn", category: "task", code: event.code, message: `Task refused (${event.origin}): ${event.message}`, data: { taskId: event.taskId, origin: event.origin } });
        }
        break;
      case "reserved":
        this.events.record({ ...base, level: "debug", category: "task", code: "SCHEDULER_RESERVED", message: `Slot reserved for ${event.owner}: ${event.label}`, data: { owner: event.owner } });
        break;
      case "reservation-released":
        this.events.record({ ...base, level: "debug", category: "task", code: "SCHEDULER_RESERVATION_RELEASED", message: `Reservation for ${event.owner} ${event.reason}`, data: { owner: event.owner, reason: event.reason } });
        break;
      case "closed":
        this.events.record({ ...base, category: "task", code: "SCHEDULER_CLOSED", message: `Task scheduler closed: ${event.reason}`, data: { reason: event.reason } });
        break;
    }
    this.noteViewState();
  }

  /** Records idle↔running flips in the lifecycle history, so the timeline shows when work started and ended. */
  private noteViewState(): void {
    if (this.phase !== "ready") return;
    // The scheduler flips `busy` after its own bookkeeping; look at the state on the next turn.
    queueMicrotask(() => {
      const state = this.state;
      if (this.phase === "ready" && state !== this.lastViewState && (state === "idle" || state === "running")) {
        this.lastViewState = state;
        this.pushHistory(state, null);
      }
    });
  }

  private push(phase: SessionPhase, reason: string | null): void {
    this.phase = phase;
    this.phaseSinceMs = this.now();
    this.reason = phase === "shutdown" || phase === "stopping" ? reason : this.reason;
    const state = phase === "ready" ? (this.hostValue?.scheduler.busy ? "running" : "idle") : phase;
    this.lastViewState = state;
    this.pushHistory(state, reason);
  }

  private pushHistory(state: SessionState, reason: string | null): void {
    this.history.push({ at: new Date(this.now()).toISOString(), state, reason });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  private record(input: AppEventInput): void {
    this.events.record({ sessionId: this.id, source: this.eventSource, ...input });
  }

  private targetText(): string {
    const target = this.resources.target;
    return target ? ` to ${target.host}:${target.port} (Minecraft ${target.version})` : ` (${this.resources.source} world)`;
  }

  private targetData(): Record<string, string | number | null> {
    const target = this.resources.target;
    return target ? { host: target.host, port: target.port, version: target.version, username: target.username, auth: target.auth } : { source: this.resources.source };
  }

  private async diagnose(error: unknown): Promise<ConnectionDiagnosis> {
    const target = this.resources.target;
    let windowsHost: WindowsHostCandidates | null = null;
    try {
      windowsHost = (await this.options.windowsHost?.()) ?? null;
    } catch {
      windowsHost = null;
    }
    return diagnoseConnectionFailure(error, {
      host: target?.host ?? "unknown",
      port: target?.port ?? 0,
      version: target?.version ?? null,
      username: target?.username ?? null,
      auth: target?.auth ?? null,
      platform: this.options.platform ?? null,
      windowsHost,
    });
  }
}

/** Helper for callers that need the task a session was asked to run first. */
export function startupTaskOf(request: ConnectRequest): MinecraftTask | null {
  return request.startupTask ?? null;
}
