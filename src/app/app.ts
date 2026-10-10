import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { startControlCenter } from "../control-center/server.js";
import type {
  ControlCenterAppView,
  ControlCenterCommands,
  ControlCenterHandle,
  ControlCenterHost,
  ControlCenterSnapshot,
  ControlCommandResult,
} from "../control-center/types.js";
import { ExperienceLearner } from "../core/learning/learner.js";
import { controlCenterTaskKinds, taskFromControlCenterRequest } from "../games/minecraft/attach-control-center.js";
import { minecraftCraftTaskItemNames, minecraftLogNames } from "../games/minecraft/capabilities.js";
import { minecraftMineableBlockNames } from "../games/minecraft/mining.js";
import { readEvaluationSummary } from "../games/minecraft/run-control.js";
import { createRuntimePerformanceSampler } from "../games/minecraft/runtime-performance.js";
import { evaluationScenarios } from "../testing/eval/scenarios.js";
import { BrowserOpener, type BrowserOpenResult } from "./browser.js";
import { buildDetachedSnapshot } from "./detached-snapshot.js";
import { AppEventLog, type AppEventCategory, type AppEventLevel, type AppEventSource } from "./event-log.js";
import { planLiveVerification, planOfflineEval, planUnitTests, JobPlanError, type PlanContext } from "./job-plans.js";
import { JobRunner } from "./jobs.js";
import { detectPlatform, discoverWindowsHost, type PlatformInfo } from "./platform.js";
import { buildLearningQuery, buildMemoryQuery, evaluationOverview } from "./queries.js";
import { defaultRedactionContext, displayPath, redactStrings, type RedactionContext } from "./redact.js";
import { DEFAULT_RECONNECT_POLICY, MinecraftSession, SessionStartError, type ReconnectPolicy } from "./session.js";
import { DEFAULT_SIMULATED_SCENARIO, SessionRequestError, createSessionFactory, type SessionFactory, type SessionFactoryDeps } from "./session-factory.js";
import { TrainingDirectoryNameError, TrainingHub } from "./training-hub.js";
import { NO_SESSION_VIEW, type ConnectRequest, type SessionMode, type SessionView } from "./types.js";

/**
 * The process-level owner of the platform: the Control Center server (up for the whole life of the process), at most
 * one agent session at a time, the training hub, the job runner, the policy store and the event log.
 *
 * A session coming and going never touches the server, and the server being opened or refreshed never touches the
 * session: the page only reads snapshots and sends commands, so a refresh cannot restart, reconnect or reopen anything.
 * Shutdown is one ordered, idempotent routine that every exit path (a signal, the UI, an error) goes through.
 */

export interface AppOptions {
  /** Project root; relative paths shown to the operator are relative to it. */
  readonly root: string;
  readonly dataDirectory?: string;
  readonly logger: Logger;
  readonly version: string;
  readonly bind?: { readonly host?: string; readonly port?: number; readonly allowedHosts?: readonly string[] };
  /** `null` turns the experience store off. Default `<data>/learning`. */
  readonly learningDirectory?: string | null;
  readonly memoryDirectory?: string;
  readonly traceDirectory?: string;
  readonly sessionDefaults?: { readonly mode?: SessionMode; readonly autonomy?: boolean; readonly reconnect?: ReconnectPolicy };
  /** Writes `<data>/run/gamemind.lock.json` and refuses to start next to a live instance. */
  readonly instanceLock?: boolean;
  readonly sessionFactory?: (deps: SessionFactoryDeps) => SessionFactory;
  readonly browser?: BrowserOpener;
  readonly platform?: PlatformInfo;
  readonly events?: AppEventLog;
  readonly jobRunner?: JobRunner;
  /** Prints a report for tasks started from the Control Center. */
  readonly report?: SessionFactoryDeps["report"];
  /** Overrides the extra shutdown time given to each stage; tests shorten it. */
  readonly stepTimeoutMs?: number;
  readonly now?: () => number;
}

/** Lock files held by apps in this very process, so a second app in the same process is refused too. */
const HELD_LOCKS = new Set<string>();

export class AppAlreadyRunningError extends Error {
  readonly code = "APP_ALREADY_RUNNING";
  constructor(
    readonly url: string | null,
    readonly pid: number,
  ) {
    super(`GameMind is already running in this project (process ${pid}${url ? `, Control Center at ${url}` : ""}). Open that address, or stop that process first.`);
    this.name = "AppAlreadyRunningError";
  }
}

export interface ConnectOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly session: MinecraftSession | null;
  readonly code?: string;
  readonly hints?: readonly string[];
}

/** Session commands the app forwards when a session exists; without one they refuse with this sentence. */
const SESSION_COMMANDS = [
  "pause",
  "resume",
  "trip",
  "resetTrip",
  "enableCombat",
  "setWorldSeed",
  "refreshRoadmap",
  "roadmapAction",
  "startTask",
  "stopTask",
  "cancelQueuedTask",
  "clearTaskQueue",
  "setAutonomy",
  "promotePolicy",
  "rejectPolicy",
  "libraryExecute",
  "panic",
] as const satisfies readonly (keyof ControlCenterCommands)[];

export class GameMindApp {
  readonly events: AppEventLog;
  readonly training: TrainingHub;
  readonly jobs: JobRunner;
  readonly learner: ExperienceLearner | null;
  readonly simulatedLearner: ExperienceLearner | null;
  readonly redaction: RedactionContext;
  readonly platform: PlatformInfo;
  readonly browser: BrowserOpener;
  readonly startedAt: string;
  private readonly options: AppOptions;
  private readonly dataDirectory: string;
  private readonly learningDirectory: string | null;
  private readonly memoryDirectory: string;
  private readonly traceDirectory: string;
  private readonly sampler = createRuntimePerformanceSampler();
  private readonly makeSession: SessionFactory;
  private readonly sessionDefaults: { mode: SessionMode; autonomy: boolean; reconnect: ReconnectPolicy };
  private readonly lockFile: string | null;
  private handleValue: ControlCenterHandle | null = null;
  private sessionValue: MinecraftSession | null = null;
  private sessionCounter = 0;
  private connecting = false;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly closedResolvers: Array<() => void> = [];
  private closedFlag = false;
  private cachedWindowsHost: Awaited<ReturnType<typeof discoverWindowsHost>> | null = null;

  private constructor(options: AppOptions) {
    this.options = options;
    const root = path.resolve(options.root);
    this.dataDirectory = path.resolve(options.dataDirectory ?? path.join(root, "data"));
    this.learningDirectory = options.learningDirectory === null ? null : path.resolve(options.learningDirectory ?? path.join(this.dataDirectory, "learning"));
    this.memoryDirectory = path.resolve(options.memoryDirectory ?? path.join(this.dataDirectory, "world-memory"));
    this.traceDirectory = path.resolve(options.traceDirectory ?? path.join(this.dataDirectory, "traces"));
    this.lockFile = options.instanceLock ? path.join(this.dataDirectory, "run", "gamemind.lock.json") : null;
    this.redaction = defaultRedactionContext(root);
    this.platform = options.platform ?? detectPlatform();
    this.startedAt = new Date((options.now ?? Date.now)()).toISOString();
    this.events =
      options.events ??
      new AppEventLog({
        redaction: this.redaction,
        directory: path.join(this.dataDirectory, "events"),
        onPersistError: (error) => options.logger.warn({ err: error }, "Could not persist the event log"),
      });
    this.training = new TrainingHub({ dataDirectory: this.dataDirectory, displayData: displayPath(this.dataDirectory, this.redaction) ?? "data", events: this.events });
    this.jobs =
      options.jobRunner ??
      new JobRunner({ redaction: this.redaction, events: this.events, historyDirectory: path.join(this.dataDirectory, "jobs") });
    this.learner =
      this.learningDirectory === null
        ? null
        : ExperienceLearner.forDirectory(this.learningDirectory, { logger: options.logger, evidenceProvenance: ["live"] });
    this.simulatedLearner =
      this.learningDirectory === null
        ? null
        : ExperienceLearner.forDirectory(path.join(this.dataDirectory, "learning-simulated"), { logger: options.logger, evidenceProvenance: ["simulator-demo"] });
    this.browser = options.browser ?? new BrowserOpener({ platform: this.platform });
    this.sessionDefaults = {
      mode: options.sessionDefaults?.mode ?? "persistent",
      autonomy: options.sessionDefaults?.autonomy ?? true,
      reconnect: options.sessionDefaults?.reconnect ?? DEFAULT_RECONNECT_POLICY,
    };
    const deps: SessionFactoryDeps = {
      logger: options.logger,
      events: this.events,
      learner: this.learner,
      simulatedLearner: this.simulatedLearner,
      traceDirectory: this.traceDirectory,
      memoryDirectory: this.memoryDirectory,
      ...(options.report ? { report: options.report } : {}),
    };
    this.makeSession = (options.sessionFactory ?? createSessionFactory)(deps);
  }

  /** Starts the app: event history, instance lock, learners, then the Control Center server. */
  static async start(options: AppOptions): Promise<GameMindApp> {
    const app = new GameMindApp(options);
    await app.initialise();
    return app;
  }

  get handle(): ControlCenterHandle {
    if (!this.handleValue) throw new Error("The Control Center has not started.");
    return this.handleValue;
  }

  get url(): string {
    return this.handle.url;
  }

  /** Every command this app answers, with or without a session. The page's controls are checked against this list. */
  get commandNames(): readonly string[] {
    return Object.keys(this.commands());
  }

  get session(): MinecraftSession | null {
    return this.sessionValue;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Resolves once shutdown has fully completed. */
  get closed(): Promise<void> {
    if (this.closedFlag) return Promise.resolve();
    return new Promise((resolve) => this.closedResolvers.push(resolve));
  }

  private async initialise(): Promise<void> {
    mkdirSync(this.dataDirectory, { recursive: true });
    await this.events.loadHistory();
    await this.jobs.loadHistory();
    this.acquireInstanceLock();
    this.event("app", "APP_STARTING", `GameMind ${this.options.version} starting`, "info", { pid: process.pid, os: this.platform.os, wsl: this.platform.wsl, node: process.version });
    try {
      await this.learner?.load();
      await this.simulatedLearner?.load();
    } catch (error) {
      this.event("learning", "LEARNING_LOAD_FAILED", `The experience store could not be loaded: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    const host = this.controlCenterHost();
    try {
      this.handleValue = await startControlCenter(host, {
        ...(this.options.bind?.host !== undefined ? { host: this.options.bind.host } : {}),
        ...(this.options.bind?.port !== undefined ? { port: this.options.bind.port } : {}),
        ...(this.options.bind?.allowedHosts ? { allowedHosts: this.options.bind.allowedHosts } : {}),
        logger: {
          info: (message) => this.options.logger.info(message),
          warn: (message) => this.options.logger.warn(message),
          error: (message) => this.options.logger.error(message),
        },
      });
    } catch (error) {
      this.releaseInstanceLock();
      throw error;
    }
    this.writeInstanceLock();
    this.event("app", "CONTROL_CENTER_LISTENING", `Control Center listening at ${this.handleValue.url}`, "info", {
      url: this.handleValue.url,
      bindHost: this.handleValue.bindHost,
      localOnly: this.handleValue.localOnly,
    });
    if (!this.handleValue.localOnly) {
      this.event("app", "CONTROL_CENTER_EXPOSED", `The Control Center is bound to ${this.handleValue.bindHost}, so other machines on the network can reach it and send commands.`, "warn");
    }
  }

  // ---- session control -----------------------------------------------------------------------------

  /**
   * Starts a session. With `wait` the promise settles when the session is ready (or has failed); without it the call
   * returns as soon as the session exists and the outcome is read from the session state.
   */
  async connect(request: ConnectRequest, options: { readonly wait?: boolean } = {}): Promise<ConnectOutcome> {
    if (this.shuttingDown) return { ok: false, message: "GameMind is shutting down.", session: null, code: "APP_SHUTTING_DOWN" };
    const existing = this.sessionValue;
    if (this.connecting || (existing && existing.isActive)) {
      const state = existing?.state ?? "connecting";
      return { ok: false, message: `A session is already ${state}. Stop it before connecting again; only one session runs at a time.`, session: existing, code: "SESSION_ALREADY_ACTIVE" };
    }
    this.connecting = true;
    try {
      const merged: ConnectRequest = {
        ...request,
        mode: request.mode ?? this.sessionDefaults.mode,
        autonomy: request.autonomy ?? this.sessionDefaults.autonomy,
      };
      let resources;
      try {
        resources = this.makeSession(merged);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.event("session", error instanceof SessionRequestError ? error.code : "SESSION_REQUEST_REJECTED", `Connection request rejected: ${message}`, "warn");
        return { ok: false, message, session: null, code: error instanceof SessionRequestError ? error.code : "SESSION_REQUEST_REJECTED" };
      }
      this.sessionCounter += 1;
      const session = new MinecraftSession({
        id: `session-${this.sessionCounter}`,
        request: merged,
        resources,
        events: this.events,
        logger: this.options.logger,
        reconnect: this.sessionDefaults.reconnect,
        platform: this.platform,
        windowsHost: async () => (this.cachedWindowsHost ??= await discoverWindowsHost(this.platform)),
        ...(this.options.stepTimeoutMs !== undefined ? { stepTimeoutMs: this.options.stepTimeoutMs } : {}),
        host: {
          dataDirectory: this.dataDirectory,
          trainingDirectory: path.join(this.dataDirectory, "training"),
          worldConfigPath: path.join(this.dataDirectory, "world-config.json"),
          companionMemoryDirectory: path.join(this.dataDirectory, "companion"),
          evaluationReportPath: path.join(this.dataDirectory, "eval", "offline-report.json"),
          training: this.training,
        },
      });
      this.sessionValue = session;
      this.event("session", "SESSION_CREATED", `Session ${session.id} created (${merged.source}, ${merged.mode})`, "info", { sessionId: session.id, source: merged.source, mode: merged.mode ?? null, autonomy: merged.autonomy ?? null });
      const started = session.start();
      if (options.wait) {
        try {
          await started;
          return { ok: true, message: `Session ${session.id} is ready.`, session };
        } catch (error) {
          if (error instanceof SessionStartError) {
            return { ok: false, message: error.message, session, code: error.diagnosis.code, hints: error.diagnosis.hints };
          }
          return { ok: false, message: error instanceof Error ? error.message : String(error), session, code: "SESSION_START_FAILED" };
        }
      }
      started.catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Session start failed");
      });
      return { ok: true, message: `Connecting${resources.target ? ` to ${resources.target.host}:${resources.target.port}` : " to the simulated world"}…`, session };
    } finally {
      this.connecting = false;
    }
  }

  async stopSession(reason: string): Promise<ControlCommandResult> {
    const session = this.sessionValue;
    if (!session || !session.isActive) return { ok: false, message: "There is no active session to stop." };
    await session.stop(reason);
    return { ok: true, message: `Session stopped (${reason}). The Control Center stays open; connect again whenever you like.` };
  }

  /** Ordered, idempotent shutdown of everything this process started. Never throws. */
  shutdown(reason: string): Promise<void> {
    this.shutdownPromise ??= this.runShutdown(reason);
    return this.shutdownPromise;
  }

  private async runShutdown(reason: string): Promise<void> {
    this.shuttingDown = true;
    this.event("shutdown", "APP_SHUTDOWN_REQUESTED", `Shutting down: ${reason}`, "info", { reason });
    const limit = this.options.stepTimeoutMs ?? 20_000;
    const step = async (label: string, run: () => Promise<void>): Promise<void> => {
      let timer: NodeJS.Timeout | null = null;
      try {
        const outcome = await Promise.race([
          run().then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), limit);
          }),
        ]);
        if (outcome === "timeout") this.event("shutdown", "SHUTDOWN_STEP_TIMEOUT", `Shutdown step '${label}' did not finish within ${Math.round(limit / 1000)} s; continuing`, "error");
      } catch (error) {
        this.event("shutdown", "SHUTDOWN_STEP_FAILED", `Shutdown step '${label}' failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await step("session", async () => {
      await this.sessionValue?.stop(reason);
    });
    await step("jobs", async () => this.jobs.dispose());
    await step("training", async () => this.training.dispose());
    await step("experience stores", async () => {
      // The learners persist after each run; nothing is buffered, so there is nothing to flush beyond the log below.
    });
    this.event("shutdown", "APP_SHUTDOWN_COMPLETE", `Shutdown complete: ${reason}`, "info", { reason });
    await this.events.flush();
    await step("control center", async () => this.handleValue?.stop(reason));
    this.releaseInstanceLock();
    this.closedFlag = true;
    for (const resolve of this.closedResolvers.splice(0)) resolve();
  }

  // ---- browser -------------------------------------------------------------------------------------

  /** Opens the Control Center once. A repeated call returns the first result without opening another tab. */
  async openBrowser(): Promise<BrowserOpenResult> {
    const result = await this.browser.open(this.url);
    if (result.alreadyOpened) return result;
    this.event("browser", result.opened ? "BROWSER_OPENED" : "BROWSER_OPEN_FAILED", result.opened ? `Opened ${result.url} with ${result.method}` : `Could not open a browser: ${result.reason ?? "unknown reason"}`, result.opened ? "info" : "warn", {
      url: result.url,
      method: result.method,
    });
    return result;
  }

  // ---- composition -----------------------------------------------------------------------------------

  private event(category: AppEventCategory, code: string, message: string, level: AppEventLevel = "info", data?: Record<string, unknown>, source: AppEventSource = "system"): void {
    this.events.record({ level, category, code, message, source, ...(data ? { data } : {}) });
  }

  private sessionView(): SessionView {
    return this.sessionValue ? this.sessionValue.view() : NO_SESSION_VIEW;
  }

  appView(): ControlCenterAppView {
    const handle = this.handleValue;
    return {
      name: "GameMind",
      version: this.options.version,
      pid: process.pid,
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, (this.options.now ?? Date.now)() - Date.parse(this.startedAt)),
      bind: { host: handle?.bindHost ?? "unknown", port: handle?.port ?? 0, localOnly: handle?.localOnly ?? true, url: handle?.url ?? "" },
      platform: { os: this.platform.os, wsl: this.platform.wsl, wslVersion: this.platform.wslVersion, distro: this.platform.distro, node: process.version },
      directories: {
        data: displayPath(this.dataDirectory, this.redaction) ?? "data",
        learning: displayPath(this.learningDirectory, this.redaction),
        worldMemory: displayPath(this.memoryDirectory, this.redaction) ?? "data/world-memory",
        traces: displayPath(this.traceDirectory, this.redaction) ?? "data/traces",
        training: `${displayPath(this.dataDirectory, this.redaction) ?? "data"}/${this.training.selected}`,
      },
      defaultMode: this.sessionDefaults.mode,
      learning: { enabled: this.learner !== null, evidence: this.learner ? ["live"] : null },
      browserOpened: this.browser.openedUrls,
      shuttingDown: this.shuttingDown,
    };
  }

  /** The single snapshot the Control Center serves: the live session's when there is one, else the detached view. */
  async snapshot(): Promise<ControlCenterSnapshot> {
    const session = this.sessionValue;
    const host = session?.host ?? null;
    const sessionView = this.sessionView();
    const training = await this.training.snapshot();
    const base: ControlCenterSnapshot = host && session && session.isActive
      ? await host.source.snapshot()
      : buildDetachedSnapshot({
          performance: this.sampler(),
          session: sessionView,
          learner: sessionView.source === "simulated" ? this.simulatedLearner : this.learner,
          training,
          evaluation: await readEvaluationSummary(path.join(this.dataDirectory, "eval", "offline-report.json")),
        });
    const recent = this.events.list({ limit: 60, minLevel: "info" });
    const jobs = this.jobs.list();
    // The single egress point for page data: whatever any subsystem put in a string, absolute paths and credentials
    // are rewritten here before the snapshot leaves the process.
    return redactStrings(
      {
        ...base,
        training,
        app: this.appView(),
        session: sessionView,
        events: { latestSeq: recent.latestSeq, total: recent.total, items: recent.events },
        jobs: { busy: this.jobs.busy, items: jobs.slice(0, 6).map((job) => ({ ...job, outputTail: job.outputTail.slice(-12) })) },
      },
      this.redaction,
    );
  }

  private health(): Record<string, unknown> {
    const handle = this.handleValue;
    return {
      version: this.options.version,
      pid: process.pid,
      startedAt: this.startedAt,
      bindHost: handle?.bindHost ?? null,
      localOnly: handle?.localOnly ?? null,
      sessionState: this.sessionView().state,
      shuttingDown: this.shuttingDown,
    };
  }

  private liveDefaults(): { host: string; port: number; username: string } {
    const target = this.sessionValue?.view().target;
    return { host: target?.host ?? "127.0.0.1", port: target?.port ?? 25565, username: "GameMindCheck" };
  }

  private planContext(): PlanContext {
    return { root: path.resolve(this.options.root), dataDirectory: this.dataDirectory };
  }

  private controlCenterHost(): ControlCenterHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the host object needs a stable reference to the app
    const app = this;
    return {
      title: "GameMind",
      snapshot: () => app.snapshot(),
      get commands(): ControlCenterCommands {
        return app.commands();
      },
      queries: app.queries(),
      health: () => app.health(),
    };
  }

  /** Built per request: the session's commands exist only while a session does, and the app's always win. */
  private commands(): ControlCenterCommands {
    const session = this.sessionValue;
    const sessionCommands: Record<string, unknown> = session?.host && session.isActive ? { ...session.host.source.commands } : {};
    if (!(session?.host && session.isActive)) {
      for (const name of SESSION_COMMANDS) {
        sessionCommands[name] = () => ({ ok: false, message: "There is no live session. Connect to a Minecraft server first (Overview or Bots)." });
      }
    }
    const app: Record<string, unknown> = {
      connectSession: (payload: unknown) => this.commandConnect(payload),
      stopSession: (payload: unknown) => this.stopSession(typeof payload === "string" && payload.length > 0 ? payload : "stopped from the Control Center"),
      shutdownApp: () => {
        void this.shutdown("shut down from the Control Center");
        return { ok: true, message: "GameMind is shutting down; this page will stop responding." };
      },
      startTraining: (payload: unknown) => this.training.start(typeof payload === "object" && payload !== null ? (payload as Parameters<TrainingHub["start"]>[0]) : {}),
      pauseTraining: () => this.training.pause(),
      resumeTraining: () => this.training.resume(),
      stopTraining: () => this.training.stop(),
      evaluateTraining: (payload: unknown) => this.training.evaluate(typeof payload === "string" && payload.length > 0 ? payload : undefined),
      selectTrainingDirectory: (payload: unknown) => this.commandSelectTraining(payload),
      runUnitTests: () => this.commandJob(() => planUnitTests(this.planContext())),
      runOfflineEvaluation: (payload: unknown) => {
        const options = typeof payload === "object" && payload !== null ? (payload as { seeds?: unknown; scenarioId?: unknown }) : {};
        return this.commandJob(() => planOfflineEval(this.planContext(), {
          ...(typeof options.seeds === "number" ? { seeds: options.seeds } : {}),
          ...(typeof options.scenarioId === "string" && options.scenarioId.length > 0 ? { scenarioId: options.scenarioId } : {}),
        }));
      },
      runLiveVerification: (payload: unknown) => this.commandLive(payload),
      cancelJob: async (payload: unknown) => {
        const id = typeof payload === "string" ? payload : typeof payload === "object" && payload !== null ? String((payload as { id?: unknown }).id ?? "") : "";
        const cancelled = await this.jobs.cancel(id.length > 0 ? id : undefined);
        return cancelled ? { ok: true, message: "The job was stopped." } : { ok: false, message: "No job is running." };
      },
    };
    return { ...sessionCommands, ...app } as ControlCenterCommands;
  }

  private async commandConnect(payload: unknown): Promise<ControlCommandResult> {
    const raw = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const source = raw.source === "simulated" ? "simulated" : "live";
    const request: ConnectRequest = {
      source,
      ...(typeof raw.host === "string" && raw.host.trim() ? { host: raw.host.trim() } : {}),
      ...(raw.port !== undefined && raw.port !== "" ? { port: Number(raw.port) } : {}),
      ...(typeof raw.username === "string" && raw.username.trim() ? { username: raw.username.trim() } : {}),
      ...(typeof raw.version === "string" && raw.version.trim() ? { version: raw.version.trim() } : {}),
      ...(raw.auth === "offline" || raw.auth === "microsoft" ? { auth: raw.auth } : {}),
      ...(typeof raw.scenarioId === "string" && raw.scenarioId ? { scenarioId: raw.scenarioId } : {}),
      ...(raw.seed !== undefined && raw.seed !== "" ? { seed: Number(raw.seed) } : {}),
      ...(raw.mode === "one-shot" || raw.mode === "persistent" ? { mode: raw.mode } : {}),
      ...(typeof raw.autonomy === "boolean" ? { autonomy: raw.autonomy } : {}),
      ...(raw.allowCombat === true ? { allowCombat: true } : {}),
    };
    const outcome = await this.connect(request);
    return { ok: outcome.ok, message: outcome.message, ...(outcome.code ? { data: { code: outcome.code, hints: outcome.hints ?? [] } } : {}) };
  }

  private async commandSelectTraining(payload: unknown): Promise<ControlCommandResult> {
    const name = typeof payload === "string" ? payload : typeof payload === "object" && payload !== null ? String((payload as { directory?: unknown }).directory ?? "") : "";
    try {
      this.training.select(name.trim() === "" ? "training" : name.trim());
      return { ok: true, message: `Showing the training folder '${this.training.selected}'.` };
    } catch (error) {
      return { ok: false, message: error instanceof TrainingDirectoryNameError || error instanceof Error ? error.message : String(error) };
    }
  }

  private commandJob(plan: () => ReturnType<typeof planUnitTests>): ControlCommandResult {
    try {
      const started = this.jobs.start(plan());
      return started.ok ? { ok: true, message: `${started.job.label} started.`, data: { id: started.job.id } } : { ok: false, message: started.message, data: { code: started.code } };
    } catch (error) {
      if (error instanceof JobPlanError) return { ok: false, message: error.message, data: { code: error.code } };
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private commandLive(payload: unknown): ControlCommandResult {
    const raw = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const defaults = this.liveDefaults();
    const host = typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : defaults.host;
    const port = raw.port !== undefined && raw.port !== "" ? Number(raw.port) : defaults.port;
    const username = typeof raw.username === "string" && raw.username.trim() ? raw.username.trim() : defaults.username;
    const session = this.sessionValue;
    if (session?.isActive && session.view().target && session.view().target?.username === username && session.view().target?.host === host && session.view().target?.port === port) {
      return { ok: false, message: `The running session already uses the name '${username}' on ${host}:${port}; a second login with the same name would kick it. Pick another bot name.` };
    }
    return this.commandJob(() =>
      planLiveVerification(this.planContext(), {
        host,
        port,
        username,
        scope: raw.scope === "actions" ? "actions" : "read-only",
        allowDig: raw.allowDig === true,
        allowCombat: raw.allowCombat === true,
        confirmed: raw.confirmed === true,
        confirmedWorldChanges: raw.confirmedWorldChanges === true,
      }),
    );
  }

  private queries(): NonNullable<ControlCenterHost["queries"]> {
    const evaluationReportPath = path.join(this.dataDirectory, "eval", "offline-report.json");
    const raw: NonNullable<ControlCenterHost["queries"]> = {
      events: (params) => {
        const category = params.get("category");
        const level = params.get("level");
        const source = params.get("source");
        const scope = params.get("scope");
        const after = params.get("after");
        const limit = params.get("limit");
        return this.events.list({
          ...(params.get("q") ? { q: params.get("q") as string } : {}),
          ...(category ? { category: category.split(",").filter((entry) => entry.length > 0) as AppEventCategory[] } : {}),
          ...(level === "debug" || level === "info" || level === "warn" || level === "error" ? { minLevel: level } : {}),
          ...(source === "live" || source === "simulated" || source === "offline" || source === "system" ? { source } : {}),
          ...(scope === "current" || scope === "previous" || scope === "all" ? { scope } : {}),
          ...(after && Number.isFinite(Number(after)) ? { after: Number(after) } : {}),
          ...(limit && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
        });
      },
      learning: async (params) => {
        const simulated = params.get("store") === "simulated";
        const learner = simulated ? this.simulatedLearner : this.learner;
        return {
          ...(await buildLearningQuery({
            learner,
            learningDirectory: simulated ? path.join(this.dataDirectory, "learning-simulated") : this.learningDirectory,
            evaluationReportPath,
            evaluationScenarioIds: evaluationScenarios().map((scenario) => scenario.id),
            redaction: this.redaction,
            trainingReports: await this.training.evaluationReports(8),
            trainingDirectory: `${displayPath(this.dataDirectory, this.redaction) ?? "data"}/${this.training.selected}`,
          })),
          store_kind: simulated ? "simulated" : "live",
        };
      },
      memory: async () => {
        const session = this.sessionValue;
        const memory = session?.host?.memory ?? null;
        const worldKey = session?.view().worldKey ?? null;
        let liveSummary = null;
        if (memory && worldKey && session?.isActive) {
          const summary = memory.summary();
          liveSummary = { worldKey, observations: summary.observations, exploredCells: summary.exploredCells, resourceBlocks: summary.resourceBlocks, landmarks: summary.landmarks ?? 0 };
        }
        return buildMemoryQuery({ directory: this.memoryDirectory, currentWorldKey: worldKey, liveSummary, redaction: this.redaction });
      },
      evaluation: async () =>
        evaluationOverview({
          summary: await readEvaluationSummary(evaluationReportPath),
          jobs: this.jobs.list(),
          trainingReports: await this.training.evaluationReports(8),
          liveDefaults: this.liveDefaults(),
        }),
      jobs: (params) => {
        const id = params.get("id");
        const jobs = this.jobs.list();
        return { busy: this.jobs.busy, jobs: id ? jobs.filter((job) => job.id === id) : jobs };
      },
      "training-preflight": async (params) => this.training.preflight(params.get("directory") ?? undefined),
      tasks: () => taskCatalog(),
      diagnostics: async () => ({
        platform: { os: this.platform.os, wsl: this.platform.wsl, wslVersion: this.platform.wslVersion, distro: this.platform.distro },
        windowsHost: this.platform.wsl ? (this.cachedWindowsHost ??= await discoverWindowsHost(this.platform)) : null,
        node: process.version,
        defaults: { host: "127.0.0.1", port: 25565, version: "1.20.4", auth: "offline" },
      }),
    };
    // Every query result passes the same redaction as the snapshot.
    return Object.fromEntries(Object.entries(raw).map(([name, query]) => [name, async (params: URLSearchParams) => redactStrings(await query(params), this.redaction)]));
  }

  // ---- instance lock -------------------------------------------------------------------------------

  private acquireInstanceLock(): void {
    if (!this.lockFile) return;
    try {
      const existing = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: number; url?: string | null };
      const alive = typeof existing.pid === "number" && (existing.pid === process.pid ? HELD_LOCKS.has(this.lockFile) : isProcessAlive(existing.pid));
      if (alive) throw new AppAlreadyRunningError(existing.url ?? null, existing.pid as number);
    } catch (error) {
      if (error instanceof AppAlreadyRunningError) throw error;
      // No lock, or an unreadable one: nothing alive to protect.
    }
    HELD_LOCKS.add(this.lockFile);
    mkdirSync(path.dirname(this.lockFile), { recursive: true });
    writeFileSync(this.lockFile, `${JSON.stringify({ pid: process.pid, url: null, startedAt: this.startedAt })}\n`, "utf8");
  }

  private writeInstanceLock(): void {
    if (!this.lockFile || !this.handleValue) return;
    try {
      writeFileSync(this.lockFile, `${JSON.stringify({ pid: process.pid, url: this.handleValue.url, port: this.handleValue.port, startedAt: this.startedAt })}\n`, "utf8");
    } catch {
      // The lock is a convenience for the launcher; the app works without it.
    }
  }

  private releaseInstanceLock(): void {
    if (!this.lockFile) return;
    HELD_LOCKS.delete(this.lockFile);
    try {
      const current = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: number };
      if (current.pid === process.pid) rmSync(this.lockFile, { force: true });
    } catch {
      // already gone
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The tasks the agent genuinely implements and validates, with their limits as the schemas enforce them. */
export function taskCatalog(): Record<string, unknown> {
  const describe = (kind: (typeof controlCenterTaskKinds)[number]): Record<string, unknown> => {
    const task = taskFromControlCenterRequest({ kind }) as unknown as Record<string, unknown>;
    return {
      limits: {
        maxActions: task.maxActions,
        maxDurationMs: task.maxDurationMs,
        dangerRadius: task.dangerRadius,
        maxTargetDistance: task.maxTargetDistance,
        maxConsecutiveFailures: task.maxConsecutiveFailures,
        maxExplorationLegs: task.maxExplorationLegs,
        explorationRadius: task.explorationRadius,
        maxRestMs: task.maxRestMs,
      },
      defaultCount: typeof task.targetCount === "number" ? task.targetCount : typeof task.targetHunger === "number" ? task.targetHunger : null,
      defaultResource: typeof task.resourceName === "string" ? task.resourceName : typeof task.targetItem === "string" ? task.targetItem : null,
    };
  };
  return {
    generatedAt: new Date().toISOString(),
    note: "Only tasks the agent implements and validates are offered. Every request is parsed by the same schema the command line uses, so the limits below cannot be raised from here.",
    // The offline worlds a simulated session can load (the Bots tab offers them; nothing here is a real server).
    simulatedScenarios: evaluationScenarios().map((scenario) => ({ id: scenario.id, family: scenario.family, description: scenario.description, expectation: scenario.expectation })),
    defaultSimulatedScenario: DEFAULT_SIMULATED_SCENARIO,
    tasks: [
      {
        kind: "gather-logs",
        label: "Gather logs",
        description: "Walks to trees, mines logs and picks them up until the inventory holds the requested number.",
        parameters: { resource: { type: "select", options: minecraftLogNames }, count: { type: "integer", min: 1, max: 64, unit: "logs" } },
        needs: ["Survival mode", "A reachable tree within the task's target distance (or exploration legs to find one)"],
        ...describe("gather-logs"),
      },
      {
        kind: "mine-stone",
        label: "Mine blocks",
        description: "Digs a stone-class or ore block with the right tool; the tool requirement is derived, never requested.",
        parameters: { resource: { type: "select", options: minecraftMineableBlockNames }, count: { type: "integer", min: 1, max: 64, unit: "blocks" } },
        needs: ["Survival mode", "A pickaxe of the required tier in the inventory, or the materials to craft one"],
        ...describe("mine-stone"),
      },
      {
        kind: "craft-wooden-pickaxe",
        label: "Craft an item",
        description: "Crafts a supported item, collecting and crafting its prerequisites and placing a crafting table when needed.",
        parameters: { resource: { type: "select", options: minecraftCraftTaskItemNames }, count: { type: "integer", min: 1, max: 64, unit: "items" } },
        needs: ["Survival mode", "Logs or planks in the inventory, or trees nearby"],
        ...describe("craft-wooden-pickaxe"),
      },
      {
        kind: "secure-food",
        label: "Secure food",
        description: "Eats what it carries, picks up dropped food, harvests ripe berries and explores for food until the hunger target is met.",
        parameters: { count: { type: "integer", min: 1, max: 20, unit: "hunger points" } },
        needs: ["Survival mode", "Food in the inventory or a reachable source"],
        ...describe("secure-food"),
      },
      {
        kind: "build-shelter",
        label: "Build a shelter",
        description: "Closes the open sides around the player with placeable blocks from the inventory.",
        parameters: {},
        needs: ["Survival mode", "Placeable blocks in the inventory (the task never gathers them)"],
        ...describe("build-shelter"),
      },
    ],
  };
}
