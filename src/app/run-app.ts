import path from "node:path";
import type { Logger } from "pino";
import { ExperienceLearner } from "../core/learning/learner.js";
import { classifyFailure } from "../core/failure-taxonomy.js";
import type { MinecraftTask } from "../games/minecraft/task.js";
import type { MinecraftTaskResult } from "../games/minecraft/task-runner.js";
import { AppAlreadyRunningError, GameMindApp, type AppOptions } from "./app.js";
import { AppEventLog } from "./event-log.js";
import { defaultRedactionContext } from "./redact.js";
import { MinecraftSession, SessionStartError, DEFAULT_RECONNECT_POLICY } from "./session.js";
import { createSessionFactory } from "./session-factory.js";
import type { TaskReporter } from "./task-report.js";
import type { ConnectRequest, SessionMode } from "./types.js";

/**
 * What the command line does with the platform: start the app (or, with no Control Center, a bare session), connect,
 * run the task that was asked for, and then either stay up until the operator stops it (persistent, the default) or end
 * with the task (one-shot, opt-in). Everything returns an exit code; nothing here calls `process.exit`.
 */

export interface RunAppRequest {
  readonly root: string;
  readonly dataDirectory?: string;
  readonly logger: Logger;
  readonly version: string;
  readonly mode: SessionMode;
  /** Serve the Control Center. Persistent runs serve it by default; one-shot runs only when asked. */
  readonly controlCenter: boolean;
  readonly bind: { readonly host?: string; readonly port?: number; readonly allowedHosts?: readonly string[] };
  /** The first session to start; null starts only the Control Center. */
  readonly connect: ConnectRequest | null;
  readonly openBrowser: boolean;
  readonly learningDirectory: string | null;
  readonly memoryDirectory?: string;
  readonly traceDirectory?: string;
  readonly reconnectAttempts?: number;
  readonly instanceLock: boolean;
  /** Printed by the CLI for every finished task; lets the caller keep its report format. */
  readonly report: TaskReporter;
  /** Describes the requested task for error lines (for example "gather-logs"). */
  readonly taskDescription: string;
  /** Whether a finished task counts as a failed run for the exit code. Default: anything but `succeeded`. */
  readonly isFailure?: (result: MinecraftTaskResult) => boolean;
  readonly out?: (line: string) => void;
  /** Installs and removes the signal handlers; injectable so tests can drive shutdown without real signals. */
  readonly signals?: SignalHub;
  readonly appOptions?: Partial<AppOptions>;
}

export interface SignalHub {
  /** Registers a handler for a graceful stop request (first signal) and returns how to unregister it. */
  onShutdown(handler: (reason: string) => void): () => void;
}

/**
 * A second signal within this window is treated as a duplicate, not as a deliberate second Ctrl-C. Process groups
 * deliver the same SIGINT twice: once directly, once relayed by the tsx wrapper in front of the agent. Without this
 * window the agent would force-exit (code 130) in the middle of its clean shutdown.
 */
export const DUPLICATE_SIGNAL_WINDOW_MS = 1500;

export interface SignalTarget {
  on(name: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(name: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface SignalHubOptions {
  readonly now?: () => number;
  readonly exit?: (code: number) => void;
  readonly target?: SignalTarget;
  readonly platform?: NodeJS.Platform;
}

export function processSignalHub(logger: Logger, options: SignalHubOptions = {}): SignalHub {
  const now = options.now ?? Date.now;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const target = options.target ?? process;
  const platform = options.platform ?? process.platform;
  return {
    onShutdown(handler) {
      let count = 0;
      let firstAt = 0;
      const listener = (name: NodeJS.Signals): void => {
        if (count === 0) {
          count = 1;
          firstAt = now();
          logger.warn({ signal: name }, "Shutdown signal received; closing the session and the Control Center cleanly. Press Ctrl-C again to force an immediate exit.");
          handler(name);
          return;
        }
        if (now() - firstAt < DUPLICATE_SIGNAL_WINDOW_MS) {
          logger.debug({ signal: name }, "Duplicate shutdown signal ignored; the clean shutdown is already running.");
          return;
        }
        logger.error({ signal: name }, "Second shutdown signal: exiting immediately without finishing cleanup.");
        exit(130);
      };
      const names: NodeJS.Signals[] = ["SIGINT", "SIGTERM", ...(platform === "win32" ? (["SIGBREAK"] as NodeJS.Signals[]) : (["SIGHUP"] as NodeJS.Signals[]))];
      for (const name of names) target.on(name, listener);
      return () => {
        for (const name of names) target.off(name, listener);
      };
    },
  };
}

export interface ReadyInfo {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  readonly bindHost: string;
  readonly localOnly: boolean;
  readonly version: string;
  readonly session: string;
  readonly browser: { readonly requested: boolean; readonly opened: boolean; readonly method: string | null; readonly reason: string | null };
}

export const READY_MARKER = "GAMEMIND_READY";

/** The machine-readable line a launcher waits for; the human-readable lines around it are for people. */
export function formatReadyLine(info: ReadyInfo): string {
  return `${READY_MARKER} ${JSON.stringify(info)}`;
}

function defaultIsFailure(result: MinecraftTaskResult): boolean {
  return result.status !== "succeeded";
}

function summariseTask(result: MinecraftTaskResult, description: string): string {
  const classified = classifyFailure(result.failure?.code ?? null, result.failure?.message ?? null);
  const head = `${classified.label} · ${classified.code ?? "no code"} · ${classified.owner}`;
  return `Minecraft ${description} task ended with status '${result.status}' (${head}): ${result.failure?.message ?? "the task reported no reason"}`;
}

/** Runs the whole command-line flow. Resolves with the process exit code. */
export async function runCommandLine(request: RunAppRequest): Promise<number> {
  const out = request.out ?? ((line: string) => console.log(line));
  if (!request.controlCenter) return runHeadless(request, out);
  let app: GameMindApp;
  try {
    app = await GameMindApp.start({
      root: request.root,
      ...(request.dataDirectory ? { dataDirectory: request.dataDirectory } : {}),
      logger: request.logger,
      version: request.version,
      bind: request.bind,
      learningDirectory: request.learningDirectory,
      ...(request.memoryDirectory ? { memoryDirectory: request.memoryDirectory } : {}),
      ...(request.traceDirectory ? { traceDirectory: request.traceDirectory } : {}),
      instanceLock: request.instanceLock,
      sessionDefaults: {
        mode: request.mode,
        autonomy: request.connect?.autonomy ?? true,
        reconnect: { ...DEFAULT_RECONNECT_POLICY, ...(request.reconnectAttempts !== undefined ? { enabled: request.reconnectAttempts > 0, maxAttempts: Math.max(1, request.reconnectAttempts) } : {}) },
      },
      report: request.report,
      ...request.appOptions,
    });
  } catch (error) {
    if (error instanceof AppAlreadyRunningError) {
      out(`GameMind did not start: ${error.message}`);
      return 3;
    }
    out(`GameMind did not start: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let exitCode = 0;
  const unregister = (request.signals ?? processSignalHub(request.logger)).onShutdown((reason) => {
    void app.shutdown(reason);
  });
  const onFatal = (error: unknown): void => {
    request.logger.error({ err: error }, "Unexpected error; shutting down cleanly");
    exitCode = 1;
    void app.shutdown("unexpected error");
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  try {
    let browser: ReadyInfo["browser"] = { requested: request.openBrowser, opened: false, method: null, reason: null };
    if (request.openBrowser) {
      const opened = await app.openBrowser();
      browser = { requested: true, opened: opened.opened, method: opened.method, reason: opened.reason };
      if (!opened.opened) out(`Could not open a browser automatically (${opened.reason ?? "unknown reason"}). Open ${app.url} yourself.`);
    }
    let session: MinecraftSession | null = null;
    if (request.connect) {
      const outcome = await app.connect(request.connect, { wait: false });
      session = outcome.session;
      if (!outcome.ok) {
        out(`Could not start the session: ${outcome.message}`);
        if (request.mode === "one-shot") {
          await app.shutdown("session request rejected");
          return 1;
        }
      }
    }
    out(`Control Center: ${app.url}${app.handle.localOnly ? " (this machine only)" : " (reachable from the network)"}`);
    out(formatReadyLine({ url: app.url, port: app.handle.port, pid: process.pid, bindHost: app.handle.bindHost, localOnly: app.handle.localOnly, version: request.version, session: session?.state ?? "none", browser }));

    if (session) {
      try {
        await session.start();
      } catch (error) {
        if (error instanceof SessionStartError) {
          out(`Connection failed: ${error.diagnosis.summary}`);
          for (const hint of error.diagnosis.hints) out(`  - ${hint}`);
          out(`  Error reported: ${error.diagnosis.detail}`);
        } else {
          out(`The session could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (request.mode === "one-shot") {
          await app.shutdown("connection failed");
          return 1;
        }
        out("The Control Center stays open: fix the connection settings there and connect again, or press Ctrl-C to quit.");
      }
      const startup = await session.startup;
      if (startup) {
        if (startup.result) {
          request.report(startup.result, "cli", session.reportDetails());
          if (startup.result.status !== "succeeded") out(summariseTask(startup.result, request.taskDescription));
          if ((request.isFailure ?? defaultIsFailure)(startup.result) && request.mode === "one-shot") exitCode = 1;
        } else if (startup.error) {
          out(`The requested task could not run: ${startup.error.message}`);
          if (request.mode === "one-shot") exitCode = 1;
        }
      }
      if (request.mode === "one-shot") {
        await app.shutdown("one-shot run complete");
        return exitCode;
      }
      if (session.isActive) out("The session stays connected after its task. Stop it from the Control Center or press Ctrl-C to quit.");
    }
    await app.closed;
    return exitCode;
  } finally {
    unregister();
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    await app.shutdown("process ending");
  }
}

/** The run without a Control Center: one session, no server, ended by the task (one-shot) or by a signal. */
async function runHeadless(request: RunAppRequest, out: (line: string) => void): Promise<number> {
  if (!request.connect) {
    out("Nothing to do: --no-connect needs the Control Center. Remove --no-control-center to use it.");
    return 2;
  }
  const root = path.resolve(request.root);
  const dataDirectory = path.resolve(request.dataDirectory ?? path.join(root, "data"));
  const redaction = defaultRedactionContext(root);
  const events = new AppEventLog({ redaction, directory: path.join(dataDirectory, "events") });
  const live = request.connect.source === "live";
  const learner = request.learningDirectory === null ? null : ExperienceLearner.forDirectory(path.resolve(request.learningDirectory), { logger: request.logger, evidenceProvenance: live ? ["live"] : ["simulator-demo"] });
  await learner?.load();
  const factory = createSessionFactory({
    logger: request.logger,
    events,
    learner: live ? learner : null,
    simulatedLearner: live ? null : learner,
    traceDirectory: path.resolve(request.traceDirectory ?? path.join(dataDirectory, "traces")),
    memoryDirectory: path.resolve(request.memoryDirectory ?? path.join(dataDirectory, "world-memory")),
  });
  let resources;
  try {
    resources = factory({ ...request.connect, mode: request.mode });
  } catch (error) {
    out(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const session = new MinecraftSession({
    id: "session-1",
    request: { ...request.connect, mode: request.mode },
    resources,
    events,
    logger: request.logger,
    reconnect: { ...DEFAULT_RECONNECT_POLICY, ...(request.reconnectAttempts !== undefined ? { enabled: request.reconnectAttempts > 0, maxAttempts: Math.max(1, request.reconnectAttempts) } : {}) },
    host: { dataDirectory, trainingDirectory: path.join(dataDirectory, "training"), worldConfigPath: path.join(dataDirectory, "world-config.json"), companionMemoryDirectory: path.join(dataDirectory, "companion"), training: null },
  });
  const unregister = (request.signals ?? processSignalHub(request.logger)).onShutdown((reason) => {
    void session.stop(reason);
  });
  let exitCode = 0;
  try {
    try {
      await session.start();
    } catch (error) {
      if (error instanceof SessionStartError) {
        out(`Connection failed: ${error.diagnosis.summary}`);
        for (const hint of error.diagnosis.hints) out(`  - ${hint}`);
        out(`  Error reported: ${error.diagnosis.detail}`);
      } else {
        out(`The session could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
      return 1;
    }
    const startup = await session.startup;
    if (startup?.result) {
      request.report(startup.result, "cli", session.reportDetails());
      if (startup.result.status !== "succeeded") out(summariseTask(startup.result, request.taskDescription));
      if ((request.isFailure ?? defaultIsFailure)(startup.result)) exitCode = 1;
    } else if (startup?.error) {
      out(`The requested task could not run: ${startup.error.message}`);
      exitCode = 1;
    }
    if (request.mode === "one-shot") {
      await session.stop("one-shot run complete");
    } else {
      out("The session stays connected. Press Ctrl-C to disconnect and quit.");
      await session.ended;
    }
    return exitCode;
  } finally {
    unregister();
    await session.stop("process ending");
    await events.flush();
  }
}

export type { MinecraftTask };
