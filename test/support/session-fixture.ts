import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppEventLog } from "../../src/app/event-log.js";
import { defaultRedactionContext } from "../../src/app/redact.js";
import { MinecraftSession, type ReconnectPolicy, type SessionOptions } from "../../src/app/session.js";
import { createSimulatedResources } from "../../src/app/session-factory.js";
import type { ConnectRequest } from "../../src/app/types.js";
import { evaluationScenarios } from "../../src/testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "../../src/testing/simulated-minecraft/adapter.js";
import { captureLogger } from "./lifecycle-fixture.js";

/** A simulated adapter that can be told to refuse the next connection attempts, the way a restarting server does. */
export class FlakyAdapter extends SimulatedMinecraftAdapter {
  failConnects = 0;
  failureMessage = "connect ECONNREFUSED 127.0.0.1:25565";
  connectAttempts = 0;

  override async connect(): ReturnType<SimulatedMinecraftAdapter["connect"]> {
    this.connectAttempts += 1;
    if (this.failConnects > 0) {
      this.failConnects -= 1;
      throw Object.assign(new Error(this.failureMessage), { code: this.failureMessage.includes("ECONNREFUSED") ? "ECONNREFUSED" : undefined });
    }
    return super.connect();
  }
}

export interface SessionFixture {
  readonly directory: string;
  readonly events: AppEventLog;
  readonly session: MinecraftSession;
  readonly adapter: FlakyAdapter;
  readonly logs: ReturnType<typeof captureLogger>;
  readonly close: () => Promise<void>;
}

export interface SessionFixtureOptions {
  readonly request?: Partial<ConnectRequest>;
  readonly reconnect?: ReconnectPolicy;
  readonly failConnects?: number;
  readonly sleep?: SessionOptions["sleep"];
  readonly scenarioId?: string;
  readonly stepTimeoutMs?: number;
}

export async function createSessionFixture(options: SessionFixtureOptions = {}): Promise<SessionFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-session-"));
  const logs = captureLogger("warn");
  const events = new AppEventLog({ redaction: defaultRedactionContext(directory) });
  const scenario = evaluationScenarios().find((candidate) => candidate.id === (options.scenarioId ?? "explore-remote-log")) ?? evaluationScenarios()[0]!;
  const adapter = new FlakyAdapter({ definition: scenario.world(101) });
  adapter.failConnects = options.failConnects ?? 0;
  const request: ConnectRequest = { source: "simulated", scenarioId: scenario.id, seed: 101, ...options.request };
  const resources = createSimulatedResources(
    request,
    { logger: logs.logger, events, learner: null, traceDirectory: path.join(directory, "traces"), memoryDirectory: path.join(directory, "memory") },
    adapter,
  );
  const session = new MinecraftSession({
    id: "test-session",
    request,
    resources,
    events,
    logger: logs.logger,
    host: {
      dataDirectory: path.join(directory, "data"),
      trainingDirectory: path.join(directory, "training"),
      worldConfigPath: path.join(directory, "world-config.json"),
      companionMemoryDirectory: path.join(directory, "companion"),
      evaluationReportPath: path.join(directory, "no-report.json"),
      training: null,
    },
    ...(options.reconnect ? { reconnect: options.reconnect } : {}),
    sleep: options.sleep ?? (async () => undefined),
    stepTimeoutMs: options.stepTimeoutMs ?? 5_000,
  });
  return {
    directory,
    events,
    session,
    adapter,
    logs,
    async close() {
      await session.stop("test complete");
      await events.flush();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
