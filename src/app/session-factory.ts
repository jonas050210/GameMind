import path from "node:path";
import type { Logger } from "pino";
import { FanOutTraceSink, JsonlTraceSink, RingBufferTraceSink, TraceRecorder } from "../core/trace.js";
import type { ExperienceLearner } from "../core/learning/learner.js";
import { createMinecraftAgent } from "../games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../games/minecraft/decision-model.js";
import { DEFAULT_MINECRAFT_CONFIG, MinecraftAdapter, minecraftAdapterConfigFromEnv, type MinecraftAdapterConfig } from "../games/minecraft/minecraft-adapter.js";
import { MinecraftTaskRunner } from "../games/minecraft/task-runner.js";
import { MINECRAFT_ATTACK_HOSTILE_CAPABILITY } from "../games/minecraft/capabilities.js";
import { PersistentWorldMemory } from "../games/minecraft/persistent-world-memory.js";
import { evaluationScenarios } from "../testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "../testing/simulated-minecraft/adapter.js";
import type { AppEventLog } from "./event-log.js";
import { EventLogTraceSink } from "./trace-events.js";
import type { SessionResources } from "./session.js";
import type { ReportDetails, TaskReporter } from "./task-report.js";
import type { ConnectRequest, SessionTarget } from "./types.js";

export interface SessionFactoryDeps {
  readonly logger: Logger;
  readonly events: AppEventLog;
  /** The store live sessions record into and learn from. */
  readonly learner: ExperienceLearner | null;
  /** Simulated sessions record into their own store, so offline demos can never become evidence for a live policy. */
  readonly simulatedLearner?: ExperienceLearner | null;
  readonly traceDirectory: string;
  readonly memoryDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Prints a task report; used for tasks an operator starts from the Control Center. */
  readonly report?: TaskReporter;
}

/** Thrown for a request that cannot be turned into a session at all; the message is shown to the operator. */
export class SessionRequestError extends Error {
  readonly code = "INVALID_TARGET";
  constructor(message: string) {
    super(message);
    this.name = "SessionRequestError";
  }
}

const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:]+\]$|^[0-9A-Fa-f:]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;

/**
 * Merges defaults, the environment and the explicit request (in that order of precedence, lowest first) and
 * validates the result, so a typo is reported as a typo instead of surfacing later as a socket error.
 */
export function resolveLiveTarget(request: ConnectRequest, env: NodeJS.ProcessEnv = process.env): MinecraftAdapterConfig {
  let fromEnv: Partial<MinecraftAdapterConfig> = {};
  try {
    fromEnv = minecraftAdapterConfigFromEnv(env);
  } catch (error) {
    throw new SessionRequestError(`The environment configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const config: MinecraftAdapterConfig = {
    ...DEFAULT_MINECRAFT_CONFIG,
    ...fromEnv,
    ...(request.host !== undefined ? { host: request.host.trim() } : {}),
    ...(request.port !== undefined ? { port: request.port } : {}),
    ...(request.username !== undefined ? { username: request.username.trim() } : {}),
    ...(request.version !== undefined ? { version: request.version.trim() } : {}),
    ...(request.auth !== undefined ? { auth: request.auth } : {}),
    ...(request.allowCombat ? { allowCombat: true } : {}),
  };
  if (!config.host || !HOST_PATTERN.test(config.host)) throw new SessionRequestError(`'${config.host}' is not a valid server host name or address.`);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) throw new SessionRequestError(`Port '${String(config.port)}' is not valid; use a whole number from 1 to 65535.`);
  if (config.auth === "offline" && !USERNAME_PATTERN.test(config.username)) {
    throw new SessionRequestError(`'${config.username}' is not a valid Minecraft user name; use 3 to 16 letters, digits or underscores.`);
  }
  if (!VERSION_PATTERN.test(config.version)) throw new SessionRequestError(`'${config.version}' is not a Minecraft version like 1.20.4.`);
  if (config.auth !== "offline" && config.auth !== "microsoft") throw new SessionRequestError(`Authentication mode '${String(config.auth)}' is not supported; use 'offline' or 'microsoft'.`);
  return config;
}

export function targetOf(config: MinecraftAdapterConfig): SessionTarget {
  return { host: config.host, port: config.port, version: config.version, username: config.username, auth: config.auth };
}

/** Builds the pieces of one live session from an explicit request. Connecting is the session's job, not the factory's. */
export function createLiveResources(request: ConnectRequest, deps: SessionFactoryDeps): SessionResources {
  const config = resolveLiveTarget(request, deps.env);
  const adapter = new MinecraftAdapter(deps.logger, config);
  const ring = new RingBufferTraceSink(400);
  const trace = new TraceRecorder(
    new FanOutTraceSink([new JsonlTraceSink(deps.traceDirectory), ring, new EventLogTraceSink(deps.events, "live")], deps.logger),
    deps.logger,
  );
  const { runtime, skills, safety } = createMinecraftAgent(adapter, trace, deps.logger, {
    // Combat is opt-in at three layers; this is the operator's explicit second and third "yes".
    ...(request.allowCombat ? { optedInCapabilities: [MINECRAFT_ATTACK_HOSTILE_CAPABILITY] } : {}),
  });
  const decisionModel = new MinecraftTaskDecisionModel();
  let worldKey: string | null = null;
  return {
    source: "live",
    adapter,
    runtime,
    skills,
    safety,
    ring,
    learner: deps.learner,
    target: targetOf(config),
    offlineNote: null,
    evaluationScenarioIds: evaluationScenarios().map((scenario) => scenario.id),
    ...(deps.report ? { onTaskFinished: (result, source) => { if (source === "control-center") deps.report?.(result, source); } } : {}),
    createRunner: (extra) =>
      new MinecraftTaskRunner(runtime, skills, decisionModel, deps.logger, {
        ...(deps.learner ? { learner: deps.learner } : {}),
        worldKey,
        allowCombat: request.allowCombat === true,
        provenance: "live",
        ...extra,
      }),
    worldKeyFor: (dimension) => {
      worldKey = `minecraft-java:${config.host.toLowerCase()}:${config.port}:${dimension ?? "unknown"}`;
      return worldKey;
    },
    openMemory: (key) => PersistentWorldMemory.open(path.resolve(deps.memoryDirectory), key, { logger: deps.logger }),
  };
}

export const DEFAULT_SIMULATED_SCENARIO = "explore-remote-log";

/**
 * What the simulator itself measured: its own clock and the damage, lowest health and starvation it applied. These
 * belong to the printed report of an offline run only; a live world has no simulated clock and reports nothing like them.
 */
function simulatedReportDetails(adapter: SimulatedMinecraftAdapter): ReportDetails {
  const { damageTaken, minHealth, starvationTicks } = adapter.world.stats;
  return { simulatedElapsedMs: adapter.simulatedNowMs, worldStats: { damageTaken, minHealth, starvationTicks } };
}

/** Builds a session over the deterministic offline simulator. Everything it reports is labelled simulated. */
export function createSimulatedResources(request: ConnectRequest, deps: SessionFactoryDeps, adapterOverride?: SimulatedMinecraftAdapter): SessionResources {
  const scenarioId = request.scenarioId ?? DEFAULT_SIMULATED_SCENARIO;
  const scenario = evaluationScenarios().find((candidate) => candidate.id === scenarioId);
  if (!scenario) {
    const ids = evaluationScenarios().map((candidate) => candidate.id).join(", ");
    throw new SessionRequestError(`Unknown simulated scenario '${scenarioId}'. Available: ${ids}.`);
  }
  const seed = request.seed ?? 101;
  // `adapterOverride` lets tests substitute an adapter that drops or refuses connections; production never passes one.
  const adapter = adapterOverride ?? new SimulatedMinecraftAdapter({ definition: scenario.world(seed), allowCombat: request.allowCombat === true });
  const ring = new RingBufferTraceSink(400);
  const trace = new TraceRecorder(new FanOutTraceSink([ring, new EventLogTraceSink(deps.events, "simulated")], deps.logger), deps.logger);
  const { runtime, skills, safety } = createMinecraftAgent(adapter, trace, deps.logger, {
    ...(request.allowCombat ? { optedInCapabilities: [MINECRAFT_ATTACK_HOSTILE_CAPABILITY] } : {}),
  });
  const decisionModel = new MinecraftTaskDecisionModel();
  const worldKey = `${scenarioId}#${seed}`;
  return {
    source: "simulated",
    adapter,
    runtime,
    skills,
    safety,
    ring,
    learner: deps.simulatedLearner ?? null,
    target: null,
    offlineNote: "Simulated world: this is the offline evaluation adapter, not a Minecraft server.",
    evaluationScenarioIds: evaluationScenarios().map((candidate) => candidate.id),
    reportDetails: () => simulatedReportDetails(adapter),
    ...(deps.report ? { onTaskFinished: (result, source) => { if (source === "control-center") deps.report?.(result, source, simulatedReportDetails(adapter)); } } : {}),
    createRunner: (extra) =>
      new MinecraftTaskRunner(runtime, skills, decisionModel, deps.logger, {
        clock: () => adapter.simulatedNowMs,
        ...(deps.simulatedLearner ? { learner: deps.simulatedLearner } : {}),
        worldKey,
        allowCombat: request.allowCombat === true,
        provenance: "simulator-demo",
        ...extra,
      }),
    worldKeyFor: () => worldKey,
  };
}

export type SessionFactory = (request: ConnectRequest) => SessionResources;

export function createSessionFactory(deps: SessionFactoryDeps): SessionFactory {
  return (request) => (request.source === "simulated" ? createSimulatedResources(request, deps) : createLiveResources(request, deps));
}
