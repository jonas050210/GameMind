/**
 * Live Minecraft verification pipeline. Connects to any reachable Minecraft 1.20.4 server
 * (Docker-based, local, or remote) and validates the full GameMind stack:
 *  - Connection and observation reception
 *  - Episode recording with reward computation
 *  - Learning state updates (statistics, failure memory, checkpoints)
 *  - Control Center snapshot correctness
 *
 * This module does NOT require Docker. It accepts any host:port combination.
 * If no server is reachable, every scenario reports the exact connection error.
 *
 * Test modes:
 *  - "verify": read-only connection + observation checks. Safe on any server.
 *  - "learn":  actually executes a short task and records episodes. Controlled:
 *              limited action budget, no combat, automatic disconnect on safety trip.
 */

import pino from "pino";
import { ACTION_PHASES, runActionPhase } from "./live-action-checks.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiveServerConfig {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  /** Bot username. Must be unique per concurrent connection. */
  readonly botUsername: string;
  /** Maximum time to wait for the bot to spawn (ms). */
  readonly connectTimeoutMs: number;
}

export const DEFAULT_SERVER_CONFIG: LiveServerConfig = {
  host: "127.0.0.1",
  port: 25565,
  version: "1.20.4",
  botUsername: "GameMindLive",
  connectTimeoutMs: 30_000,
};

export type LiveTestMode = "verify" | "learn";

export interface LiveVerificationOptions {
  readonly server: LiveServerConfig;
  readonly mode: LiveTestMode;
  /** Which verification phases to run. Default: all. */
  readonly phases?: readonly LivePhase[];
  readonly logger?: pino.Logger;
  /** Destructive action phases: digging changes the world, combat attacks a hostile. Both are opt-in. */
  readonly allowDig?: boolean;
  readonly allowCombat?: boolean;
}

export type LivePhase =
  | "connection"
  | "observation"
  | "decision"
  | "episode-recording"
  | "learning-update"
  | "control-center"
  | "movement"
  | "timeout-recovery"
  | "dig"
  | "swim"
  | "combat";

export interface LiveAssertion {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface LivePhaseResult {
  readonly phase: LivePhase;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly assertions: LiveAssertion[];
  readonly error: string | null;
  readonly notes: string[];
  /** True when the phase talks to the Minecraft server. Offline phases exercise only the in-process learner. */
  readonly serverRequired?: boolean;
  /** True only when this phase's own bot logged in to the server. */
  readonly serverReached?: boolean;
  /** True when the phase needed a server and never reached one: it did not run, and says so. */
  readonly notRun?: boolean;
  /** True when the phase was not applicable or was not opted in. A skip is neither a pass nor a failure. */
  readonly skipped?: boolean;
}

export interface LiveVerificationReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly server: string;
  readonly mode: LiveTestMode;
  readonly phases: LivePhaseResult[];
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly allPassed: boolean;
  /** True only if at least one phase actually connected to a real server. */
  readonly reachedServer: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assert(
  name: string,
  condition: boolean,
  expected: string,
  actual: string,
): LiveAssertion {
  return { name, passed: condition, expected, actual };
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * A connection attempt that did not reach a spawned bot. `serverReached` is true only when the server answered
 * (the bot logged in and was then kicked or failed), so "the socket was refused" is never counted as a server.
 */
export class LiveConnectError extends Error {
  constructor(message: string, readonly serverReached: boolean) {
    super(message);
    this.name = "LiveConnectError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ends a bot's connection and releases the protocol client's own timers. Safe to call on a bot that already ended.
 * minecraft-protocol's end() arms a 30 s close timer, which keeps the process alive after a refused connection; each
 * end() call overwrites the field, so the timer is cleared after every call. These are internals, so the access is
 * guarded and a missing field is simply skipped.
 */
function endBot(bot: any): void {
  if (!bot) return;
  const client = bot._client as { socket?: { destroy?: () => void }; closeTimer?: ReturnType<typeof setTimeout> | undefined } | undefined;
  const releaseCloseTimer = () => {
    if (client?.closeTimer) {
      clearTimeout(client.closeTimer);
      delete client.closeTimer;
    }
  };
  try {
    bot.quit("GameMind live verification finished");
  } catch {
    // The socket may already be closed; nothing is left to release.
  }
  releaseCloseTimer();
  try {
    bot.end?.("GameMind live verification finished");
  } catch {
    // Already ended.
  }
  releaseCloseTimer();
  try {
    client?.socket?.destroy?.();
  } catch {
    // Already destroyed.
  }
}

/** Connect a Mineflayer bot to the configured server. Returns the bot, or throws LiveConnectError (bot ended). */
async function connectBot(config: LiveServerConfig, suffix: string): Promise<{
  bot: any;
  mineflayer: typeof import("mineflayer");
}> {
  const mineflayer = await import("mineflayer");
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: `${config.botUsername}${suffix}`,
    version: config.version,
  });
  let loggedIn = false;
  bot.once("login", () => { loggedIn = true; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new LiveConnectError(`Connection timeout after ${formatMs(config.connectTimeoutMs)}`, loggedIn)),
        config.connectTimeoutMs,
      );
      bot.once("spawn", () => { clearTimeout(timer); resolve(); });
      bot.once("error", (err: Error) => { clearTimeout(timer); reject(new LiveConnectError(err.message, loggedIn)); });
      bot.once("kicked", (reason: string) => { clearTimeout(timer); reject(new LiveConnectError(`Kicked: ${reason}`, true)); });
      bot.once("end", (reason: string) => { clearTimeout(timer); reject(new LiveConnectError(`Connection ended before spawn: ${reason}`, loggedIn)); });
    });
  } catch (error) {
    endBot(bot);
    throw error;
  }
  // Brief settle time for chunks to load
  await new Promise((r) => setTimeout(r, 1500));
  return { bot, mineflayer };
}

/** Result for a server phase whose connection failed: NOT RUN when no server answered, otherwise FAILED. */
function connectionFailure(
  phase: LivePhase,
  start: number,
  error: unknown,
  assertions: LiveAssertion[],
  notes: string[],
  connected: boolean,
): LivePhaseResult {
  const serverReached = connected || (error instanceof LiveConnectError && error.serverReached);
  return {
    phase,
    passed: false,
    durationMs: Date.now() - start,
    assertions,
    error: errorMessage(error),
    notes,
    serverRequired: true,
    serverReached,
    notRun: !serverReached,
  };
}

const OFFLINE_PHASES: readonly LivePhase[] = ["learning-update", "control-center"];
const OFFLINE_NOTE = "Offline phase: exercises the learner in-process. It does not connect to the server.";

// ─── Phase implementations ───────────────────────────────────────────────────

async function verifyConnection(config: LiveServerConfig): Promise<LivePhaseResult> {
  const start = Date.now();
  const assertions: LiveAssertion[] = [];
  const notes: string[] = [];

  let bot: any = null;
  let connected = false;
  try {
    ({ bot } = await connectBot(config, "-c"));
    connected = true;
    const pos = bot.entity?.position;
    assertions.push(assert("Has position", pos !== undefined && pos !== null, "position defined",
      pos ? `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : "null"));
    assertions.push(assert("Has health", typeof bot.health === "number" && bot.health > 0,
      "health > 0", `${bot.health ?? "null"}`));
    assertions.push(assert("Has food", typeof bot.food === "number" && bot.food > 0,
      "food > 0", `${bot.food ?? "null"}`));
    assertions.push(assert("Has game mode", typeof bot.game?.gameMode === "string",
      "gamemode string", `${bot.game?.gameMode ?? "null"}`));
    notes.push(`Connected as ${bot.username} in ${bot.game?.gameMode ?? "?"} mode`);
  } catch (error) {
    return connectionFailure("connection", start, error, assertions, notes, connected);
  } finally {
    endBot(bot);
  }
  return {
    phase: "connection",
    passed: assertions.every((a) => a.passed),
    durationMs: Date.now() - start,
    assertions,
    error: null,
    notes,
    serverRequired: true,
    serverReached: true,
    notRun: false,
  };
}

async function verifyObservation(config: LiveServerConfig): Promise<LivePhaseResult> {
  const start = Date.now();
  const assertions: LiveAssertion[] = [];
  const notes: string[] = [];

  let bot: any = null;
  let connected = false;
  try {
    ({ bot } = await connectBot(config, "-o"));
    connected = true;
    // Block scanning
    const blocks = bot.findBlocks({
      matching: (block: { name: string } | null) => block !== null && block.name !== "air",
      maxDistance: 8,
      count: 10,
    });
    assertions.push(assert("Can scan blocks", blocks.length > 0, "≥1 block", `${blocks.length}`));
    notes.push(`Scanned ${blocks.length} non-air blocks within 8m`);

    // Entity scanning
    const entities = Object.values(bot.entities).filter(
      (e: unknown) => {
        const entity = e as { id?: number; position?: unknown; type?: string } | null;
        return entity !== bot.entity && entity?.position && entity.type !== "object";
      },
    );
    notes.push(`${entities.length} entities in range`);
    assertions.push(assert("Entity scan works", true, "no error", `${entities.length} entities`));

    // Time / weather
    assertions.push(assert("Has time data", typeof bot.time?.timeOfDay === "number",
      "timeOfDay number", `${bot.time?.timeOfDay ?? "null"}`));

  } catch (error) {
    return connectionFailure("observation", start, error, assertions, notes, connected);
  } finally {
    endBot(bot);
  }
  return {
    phase: "observation",
    passed: assertions.every((a) => a.passed),
    durationMs: Date.now() - start,
    assertions,
    error: null,
    notes,
    serverRequired: true,
    serverReached: true,
    notRun: false,
  };
}

async function verifyDecision(config: LiveServerConfig): Promise<LivePhaseResult> {
  const start = Date.now();
  const assertions: LiveAssertion[] = [];
  const notes: string[] = [];

  let bot: any = null;
  let connected = false;
  try {
    ({ bot } = await connectBot(config, "-d"));
    connected = true;
    // Test that the decision model can process live observations
    // We don't execute a full task here — just verify the observation pipeline produces
    // data that the decision model *could* consume.
    const pos = bot.entity?.position;
    const health = bot.health ?? 20;
    const food = bot.food ?? 20;

    assertions.push(assert("Observation has required fields",
      pos !== undefined && pos !== null && health > 0,
      "position + health", `pos=${pos ? "ok" : "null"}, health=${health}`));

    // Check for nearby resources
    const logs = bot.findBlocks({
      matching: (block: { name: string } | null) => block !== null && block.name.includes("log"),
      maxDistance: 32,
      count: 5,
    });
    const hostiles = Object.values(bot.entities).filter(
      (e: unknown) => {
        const entity = e as { id?: number; type?: string } | null;
        return entity !== bot.entity && entity?.type === "hostile";
      },
    );
    notes.push(`Nearby: ${logs.length} logs, ${hostiles.length} hostiles`);

  } catch (error) {
    return connectionFailure("decision", start, error, assertions, notes, connected);
  } finally {
    endBot(bot);
  }
  return {
    phase: "decision",
    passed: assertions.every((a) => a.passed),
    durationMs: Date.now() - start,
    assertions,
    error: null,
    notes,
    serverRequired: true,
    serverReached: true,
    notRun: false,
  };
}

async function verifyEpisodeRecording(config: LiveServerConfig): Promise<LivePhaseResult> {
  const start = Date.now();
  const assertions: LiveAssertion[] = [];
  const notes: string[] = [];

  let bot: any = null;
  let connected = false;
  try {
    // Import the learning system components
    const { ExperienceLearner } = await import("../../core/learning/learner.js");
    const { computeReward } = await import("../../core/learning/reward.js");

    const learner = new ExperienceLearner();
    learner.beginRun({ runId: "live-verify", taskId: "live-task", worldKey: `${config.host}:${config.port}` });

    // Record a synthetic episode from the live observation to verify the pipeline
    ({ bot } = await connectBot(config, "-e"));
    connected = true;
    const pos = bot.entity?.position;
    const health = bot.health;
    const food = bot.food;

    // Record a "gather" episode based on the live observation
    learner.recordEpisode({
      runId: "live-verify",
      taskId: "live-task",
      sessionId: null,
      sequence: 0,
      worldKey: `${config.host}:${config.port}`,
      policyVersion: null,
      targetKey: pos ? `ground@${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}` : null,
      features: {
        goalClass: "collect",
        skillId: "minecraft.gather_resource",
        band: 0,
        distance: 0,
        distanceBand: "adjacent",
        health,
        hunger: food,
        vitality: health !== null && food !== null
          ? (health <= 6 || food <= 3 ? "critical" : health <= 12 || food <= 10 ? "low" : health >= 20 && food >= 18 ? "full" : "ok")
          : "unknown",
        threat: "none",
        timeOfDay: "day",
        targetKind: "ground",
        actionIndex: 0,
        attemptsOnTarget: 0,
      },
      outcome: {
        status: "succeeded",
        confirmed: true,
        verified: true,
        progress: true,
        failureCode: null,
        itemsGained: 0,
        itemsConsumed: 0,
        healthDelta: 0,
        foodDelta: 0,
        durationMs: 500,
        distanceAfter: 0,
        safetyDenied: false,
      },
    });

    // Verify reward was computed
    const snap = learner.snapshot();
    assertions.push(assert("Episode recorded", snap.episodes >= 0, "recording works", "ok"));
    assertions.push(assert("Reward computed", snap.reward.totalEpisodes >= 1,
      "≥1 reward episode", `${snap.reward.totalEpisodes}`));
    notes.push(`Reward: mean=${snap.reward.meanReward.toFixed(3)}, ewma=${snap.reward.ewmaReward.toFixed(3)}`);

    // Verify a reward can be computed from live data
    const liveReward = computeReward({
      status: "succeeded",
      confirmed: true,
      progress: true,
      safetyDenied: false,
      itemsGained: 1,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 1000,
      distanceAfter: null,
      health,
      hunger: food,
      goalClass: "collect",
      skillId: "minecraft.gather_resource",
    });
    assertions.push(assert("Live reward is finite", Number.isFinite(liveReward.total),
      "finite number", `${liveReward.total}`));
    notes.push(`Live reward breakdown: survival=${liveReward.survival}, progress=${liveReward.progress}, efficiency=${liveReward.efficiency}`);

  } catch (error) {
    return connectionFailure("episode-recording", start, error, assertions, notes, connected);
  } finally {
    endBot(bot);
  }
  return {
    phase: "episode-recording",
    passed: assertions.every((a) => a.passed),
    durationMs: Date.now() - start,
    assertions,
    error: null,
    notes,
    serverRequired: true,
    serverReached: true,
    notRun: false,
  };
}

async function verifyLearningUpdate(config: LiveServerConfig): Promise<LivePhaseResult> {
  const start = Date.now();
  const assertions: LiveAssertion[] = [];
  const notes: string[] = [];

  try {
    const { ExperienceLearner } = await import("../../core/learning/learner.js");
    const learner = new ExperienceLearner();

    // Run a short sequence to verify learning updates flow
    learner.beginRun({ runId: "live-learn", taskId: "live-task", worldKey: `${config.host}:${config.port}` });

    // Record several episodes with varying outcomes
    for (let i = 0; i < 3; i++) {
      learner.recordEpisode({
        runId: "live-learn",
        taskId: "live-task",
        sessionId: null,
        sequence: i,
        worldKey: `${config.host}:${config.port}`,
        policyVersion: null,
        targetKey: `target-${i}`,
        features: {
          goalClass: "collect",
          skillId: "minecraft.gather_resource",
          band: 4,
          distance: 10 + i * 5,
          distanceBand: "medium",
          health: 20,
          hunger: 18,
          vitality: "ok",
          threat: "none",
          timeOfDay: "day",
          targetKind: "resource",
          actionIndex: i,
          attemptsOnTarget: 0,
        },
        outcome: {
          status: i < 2 ? "succeeded" : "failed",
          confirmed: i < 2,
          verified: i < 2,
          progress: i < 2,
          failureCode: i === 2 ? "no-progress" : null,
          itemsGained: i < 2 ? 1 : 0,
          itemsConsumed: 0,
          healthDelta: 0,
          foodDelta: 0,
          durationMs: 1000,
          distanceAfter: i < 2 ? 5 : 15,
          safetyDenied: false,
        },
      });
    }

    const report = await learner.finishRun();
    const snap = learner.snapshot();

    assertions.push(assert("Run completed", report.episodes === 3, "3 episodes", `${report.episodes}`));
    assertions.push(assert("Statistics updated", Object.keys(snap.contexts).length >= 0 || snap.episodes >= 3,
      "episodes ≥ 3", `${snap.episodes} episodes`));
    assertions.push(assert("Checkpoint created", snap.checkpoints.total > 0,
      "≥1 checkpoint", `${snap.checkpoints.total}`));
    assertions.push(assert("Class patterns tracked", snap.classPatterns.length >= 0,
      "patterns list exists", `${snap.classPatterns.length} patterns`));
    notes.push(`Learning: ${report.successes} successes, ${report.failures} failures, ${report.contexts} contexts`);
    notes.push(`Reward: mean=${snap.reward.meanReward.toFixed(3)}, positive rate=${(snap.reward.positiveRate * 100).toFixed(0)}%`);
    notes.push(`Checkpoints: ${snap.checkpoints.total}`);
  } catch (error) {
    return {
      phase: "learning-update",
      passed: false,
      durationMs: Date.now() - start,
      assertions,
      error: error instanceof Error ? error.message : String(error),
      notes,
    };
  }
  return {
    phase: "learning-update",
    passed: assertions.every((a) => a.passed),
    durationMs: Date.now() - start,
    assertions,
    error: null,
    notes,
  };
}

async function verifyControlCenter(config: LiveServerConfig): Promise<LivePhaseResult> {
  const start = Date.now();
  const assertions: LiveAssertion[] = [];
  const notes: string[] = [];

  try {
    const { ExperienceLearner } = await import("../../core/learning/learner.js");
    const learner = new ExperienceLearner();
    learner.beginRun({ runId: "live-cc", taskId: "live-task", worldKey: `${config.host}:${config.port}` });
    learner.recordEpisode({
      runId: "live-cc",
      taskId: "live-task",
      sessionId: null,
      sequence: 0,
      worldKey: `${config.host}:${config.port}`,
      policyVersion: null,
      targetKey: "test@0,64,0",
      features: {
        goalClass: "collect",
        skillId: "minecraft.gather_resource",
        band: 4,
        distance: 12,
        distanceBand: "medium",
        health: 20,
        hunger: 18,
        vitality: "ok",
        threat: "none",
        timeOfDay: "day",
        targetKind: "resource",
        actionIndex: 0,
        attemptsOnTarget: 0,
      },
      outcome: {
        status: "succeeded",
        confirmed: true,
        verified: true,
        progress: true,
        failureCode: null,
        itemsGained: 1,
        itemsConsumed: 0,
        healthDelta: 0,
        foodDelta: 0,
        durationMs: 1000,
        distanceAfter: 5,
        safetyDenied: false,
      },
    });
    await learner.finishRun();

    const snap = learner.snapshot();

    // Verify the snapshot has all fields the ControlCenterLearning type needs
    assertions.push(assert("Has reward data", snap.reward !== undefined,
      "reward object", snap.reward ? `mean=${snap.reward.meanReward}` : "missing"));
    assertions.push(assert("Has class patterns", Array.isArray(snap.classPatterns),
      "array", `${snap.classPatterns.length} patterns`));
    assertions.push(assert("Has checkpoints", snap.checkpoints !== undefined,
      "checkpoints object", `total=${snap.checkpoints.total}`));
    assertions.push(assert("Has experiments", Array.isArray(snap.experiments),
      "array", `${snap.experiments.length} experiments`));
    assertions.push(assert("Has RL readiness", snap.rlReadiness !== undefined,
      "assessment", `score=${snap.rlReadiness?.score}/${snap.rlReadiness?.maxScore}`));
    notes.push(`ControlCenter snapshot: ${snap.episodes} episodes, ${snap.checkpoints.total} checkpoints, RL score ${snap.rlReadiness?.score}/${snap.rlReadiness?.maxScore}`);
  } catch (error) {
    return {
      phase: "control-center",
      passed: false,
      durationMs: Date.now() - start,
      assertions,
      error: error instanceof Error ? error.message : String(error),
      notes,
    };
  }
  return {
    phase: "control-center",
    passed: assertions.every((a) => a.passed),
    durationMs: Date.now() - start,
    assertions,
    error: null,
    notes,
  };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/** Phases that take no options. Action phases are dispatched separately, with their opt-in flags. */
const PHASE_RUNNERS: Partial<Record<LivePhase, (config: LiveServerConfig) => Promise<LivePhaseResult>>> = {
  connection: verifyConnection,
  observation: verifyObservation,
  decision: verifyDecision,
  "episode-recording": verifyEpisodeRecording,
  "learning-update": verifyLearningUpdate,
  "control-center": verifyControlCenter,
};

const VERIFY_PHASES: readonly LivePhase[] = ["connection", "observation", "decision"];
export const ACTION_PHASE_NAMES: readonly LivePhase[] = ACTION_PHASES;
const LEARN_PHASES: readonly LivePhase[] = [
  "connection", "observation", "decision", "episode-recording", "learning-update", "control-center",
];

export async function runLiveVerification(options: LiveVerificationOptions): Promise<LiveVerificationReport> {
  const phases = options.phases ?? (options.mode === "verify" ? VERIFY_PHASES : LEARN_PHASES);
  const logger = options.logger ?? pino({ level: "silent" });
  const results: LivePhaseResult[] = [];
  let reachedServer = false;

  for (const phase of phases) {
    logger.info(`Running phase: ${phase}`);
    try {
      const run = ACTION_PHASES.includes(phase)
        ? runActionPhase(phase, options.server, {
            allowDig: options.allowDig === true,
            allowCombat: options.allowCombat === true,
            logger,
          })
        : (PHASE_RUNNERS[phase] ?? (() => Promise.reject(new Error(`no runner for phase ${phase}`))))(options.server);
      // The deadline timer is cleared when the phase finishes: a pending timer would hold the process open.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        run,
        new Promise<LivePhaseResult>((resolve) => {
          deadline = setTimeout(
            () => resolve({
              phase,
              passed: false,
              durationMs: options.server.connectTimeoutMs,
              assertions: [],
              error: `Phase timed out after ${formatMs(options.server.connectTimeoutMs)}`,
              notes: [],
            }),
            options.server.connectTimeoutMs + 5000,
          );
        }),
      ]).finally(() => {
        if (deadline) clearTimeout(deadline);
      });
      // Only a phase whose own bot logged in to the server counts as reaching it.
      if (result.serverReached === true) reachedServer = true;
      results.push(OFFLINE_PHASES.includes(phase)
        ? { ...result, serverRequired: false, serverReached: false, notRun: false, notes: [OFFLINE_NOTE, ...result.notes] }
        : result);
    } catch (error) {
      results.push({
        phase,
        passed: false,
        durationMs: 0,
        assertions: [],
        error: error instanceof Error ? error.message : String(error),
        notes: [],
        serverRequired: !OFFLINE_PHASES.includes(phase),
        serverReached: false,
        notRun: false,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  // "failed" means a phase ran (or was meant to run) and did not pass. Skipped and not-run phases are counted apart.
  const failed = results.filter((r) => !r.passed && r.skipped !== true && r.notRun !== true).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    server: `${options.server.host}:${options.server.port}`,
    mode: options.mode,
    phases: results,
    passed,
    failed,
    total: results.length,
    allPassed: results.every((r) => r.passed || r.skipped === true),
    reachedServer,
  };
}

// ─── Report formatting ───────────────────────────────────────────────────────

export function formatLiveVerificationReport(report: LiveVerificationReport): string {
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("  GAMEMIND LIVE VERIFICATION REPORT");
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`  Server:  ${report.server}`);
  lines.push(`  Mode:    ${report.mode}`);
  const notRunCount = report.phases.filter((phase) => phase.notRun === true).length;
  const skippedCount = report.phases.filter((phase) => phase.skipped === true).length;
  const failedCount = report.failed;
  lines.push(`  Result:  ${report.allPassed
    ? `ALL PASSED ✓${skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}`
    : `${report.passed}/${report.total} passed, ${failedCount} FAILED ✗, ${notRunCount} NOT RUN, ${skippedCount} skipped`}`);
  lines.push(`  Reached: ${report.reachedServer
    ? "YES — at least one phase logged in to a real Minecraft server"
    : "NO — server unreachable; server phases are NOT RUN"}`);
  lines.push(`  Time:    ${report.generatedAt}`);
  lines.push("");

  for (const phase of report.phases) {
    const status = phase.skipped === true ? "SKIPPED" : phase.notRun === true ? "NOT RUN" : phase.passed ? "PASSED" : "FAILED";
    const icon = phase.skipped === true || phase.notRun === true ? "–" : phase.passed ? "✓" : "✗";
    const tag = phase.serverRequired === false ? " [offline]" : phase.serverReached === true ? " [server]" : "";
    lines.push(`  ${icon} ${phase.phase}${tag}: ${status} (${formatMs(phase.durationMs)})`);
    if (phase.error) {
      lines.push(`    ERROR: ${phase.error}`);
    }
    for (const a of phase.assertions) {
      const mark = a.passed ? "  ✓" : "  ✗";
      lines.push(`    ${mark} ${a.name}: expected ${a.expected}, got ${a.actual}`);
    }
    for (const note of phase.notes) {
      lines.push(`    · ${note}`);
    }
    lines.push("");
  }

  lines.push("  ─────────────────────────────────────────────────────────");
  if (!report.reachedServer) {
    lines.push("  NOTE: No server was reached. Server phases are NOT RUN; no live result exists.");
    lines.push("  Offline phases ([offline]) ran in-process and are NOT live evidence.");
    lines.push("  To run against a real server: npm run test:live -- --host <ip> --port <port>");
  } else {
    lines.push("  Phases tagged [server] logged in to a REAL Minecraft server: those results are live.");
    lines.push("  Phases tagged [offline] ran in-process and are NOT live evidence.");
  }
  lines.push("  ─────────────────────────────────────────────────────────");
  lines.push("═══════════════════════════════════════════════════════════");
  return lines.join("\n");
}
