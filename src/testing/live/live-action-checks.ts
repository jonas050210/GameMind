/**
 * Live action checks for the Minecraft adapter: movement, timeout + cancel + recovery, digging, swimming and
 * combat. Each phase connects its own adapter to the configured server, runs a bounded set of real actions, and
 * reports only what the adapter confirmed from the observed state.
 *
 * Safety model:
 *  - Movement and the timeout/recovery phase only move the bot a few blocks and return it toward its start.
 *  - Digging changes the world, so it runs only with `allowDig`, and only on a dirt/stone-class block within 3.5
 *    blocks of the feet.
 *  - Combat runs only with `allowCombat` and a hostile already visible. Otherwise the phase is SKIPPED, never passed.
 *  - Swimming runs only when the bot is already in water.
 *
 * A phase whose server never answers is NOT RUN. A phase whose precondition is absent is SKIPPED with the reason.
 */

import { randomUUID } from "node:crypto";
import type pino from "pino";
import type {
  LiveAssertion,
  LivePhase,
  LivePhaseResult,
  LiveServerConfig,
} from "./live-verifier.js";

export const ACTION_PHASES: readonly LivePhase[] = ["movement", "timeout-recovery", "dig", "swim", "combat"];

export interface ActionCheckOptions {
  readonly allowDig: boolean;
  readonly allowCombat: boolean;
  readonly logger?: pino.Logger;
}

/** The adapter could not be connected. `serverReached` is false: a failed adapter connect is counted as not reached. */
class ActionConnectError extends Error {
  readonly serverReached = false;
}

type Vec = { x: number; y: number; z: number };

function assert(name: string, passed: boolean, expected: string, actual: string): LiveAssertion {
  return { name, passed, expected, actual };
}

function formatVec(v: Vec): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ActionAdapter = {
  observe(): Promise<{ state: any }>;
  executeAction(action: unknown, signal: AbortSignal): Promise<any>;
  cancelActiveAction(actionId: string, reason: string): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  readonly session: { id: string } | null;
};

async function connectAdapter(config: LiveServerConfig, suffix: string, options: ActionCheckOptions): Promise<ActionAdapter> {
  const { MinecraftAdapter, DEFAULT_MINECRAFT_CONFIG } = await import("../../games/minecraft/minecraft-adapter.js");
  const { default: pinoLogger } = await import("pino");
  const logger = options.logger ?? pinoLogger({ level: "silent" });
  const adapter = new MinecraftAdapter(logger, {
    ...DEFAULT_MINECRAFT_CONFIG,
    host: config.host,
    port: config.port,
    username: `${config.botUsername}${suffix}`,
    version: config.version,
    connectTimeoutMs: config.connectTimeoutMs,
    allowCombat: options.allowCombat,
  });
  try {
    await adapter.connect();
  } catch (error) {
    await adapter.disconnect("connect failed").catch(() => undefined);
    throw new ActionConnectError(error instanceof Error ? error.message : String(error));
  }
  return adapter as unknown as ActionAdapter;
}

async function act(adapter: ActionAdapter, capability: string, input: unknown, signal = new AbortController().signal) {
  const session = adapter.session;
  if (!session) throw new Error("adapter has no session");
  return adapter.executeAction({ actionId: randomUUID(), sessionId: session.id, capability, input }, signal);
}

async function playerPosition(adapter: ActionAdapter): Promise<{ state: any; feet: Vec }> {
  const { state } = await adapter.observe();
  const p = state.player.position as Vec;
  return { state, feet: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } };
}

function result(
  phase: LivePhase,
  start: number,
  assertions: LiveAssertion[],
  notes: string[],
  error: string | null,
  reached: boolean,
): LivePhaseResult {
  return {
    phase,
    passed: error === null && assertions.length > 0 && assertions.every((a) => a.passed),
    durationMs: Date.now() - start,
    assertions,
    error,
    notes,
    serverRequired: true,
    serverReached: reached,
    notRun: false,
  };
}

/** A skip is neither a pass nor a failure. `reached` says whether the phase's bot had logged in before skipping. */
function skipped(phase: LivePhase, start: number, reason: string, reached: boolean): LivePhaseResult {
  return {
    phase,
    passed: false,
    skipped: true,
    durationMs: Date.now() - start,
    assertions: [],
    error: null,
    notes: [`SKIPPED: ${reason}`],
    serverRequired: true,
    serverReached: reached,
    notRun: false,
  };
}

function notRun(phase: LivePhase, start: number, error: unknown): LivePhaseResult {
  const reached = error instanceof ActionConnectError ? error.serverReached : false;
  return {
    phase,
    passed: false,
    durationMs: Date.now() - start,
    assertions: [],
    error: error instanceof Error ? error.message : String(error),
    notes: [],
    serverRequired: true,
    serverReached: reached,
    notRun: !reached,
  };
}

/** Walks a few blocks from the start, confirming each step from the observed position. */
async function movementPhase(config: LiveServerConfig, options: ActionCheckOptions): Promise<LivePhaseResult> {
  const start = Date.now();
  const notes: string[] = [];
  let adapter: ActionAdapter | null = null;
  try {
    adapter = await connectAdapter(config, "-m", options);
    const { feet } = await playerPosition(adapter);
    const attempts: string[] = [];
    let confirmed: Vec | null = null;
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
      const target = { x: feet.x + dx, y: feet.y, z: feet.z + dz };
      try {
        const outcome = await act(adapter, "minecraft.navigate", { ...target, range: 1 });
        attempts.push(`${formatVec(target)} confirmed=${outcome.confirmed}`);
        if (outcome.confirmed) {
          confirmed = target;
          break;
        }
      } catch (error) {
        attempts.push(`${formatVec(target)} ${errorCode(error)}`);
      }
    }
    notes.push(`Attempts: ${attempts.join("; ")}`);
    const assertions = [
      assert(
        "A nearby walk is confirmed from the observed position",
        confirmed !== null,
        "navigation confirmed within range 1 of a cell 2 blocks away",
        confirmed ? `confirmed at ${formatVec(confirmed)}` : "no nearby cell confirmed",
      ),
    ];
    if (confirmed) {
      const { feet: now } = await playerPosition(adapter);
      assertions.push(assert("Position matches the confirmation", distance(now, confirmed) <= 1.5, "within 1.5 blocks", formatVec(now)));
    }
    return result("movement", start, assertions, notes, null, true);
  } catch (error) {
    return notRun("movement", start, error);
  } finally {
    await adapter?.disconnect("movement check finished").catch(() => undefined);
  }
}

/**
 * Interrupts a long walk with an abort (the same sequence the action executor uses: abort, then cancel), checks
 * the bot stops, then runs a planner failure and a recovery walk back to the start.
 */
async function timeoutRecoveryPhase(config: LiveServerConfig, options: ActionCheckOptions): Promise<LivePhaseResult> {
  const start = Date.now();
  const notes: string[] = [];
  let adapter: ActionAdapter | null = null;
  try {
    adapter = await connectAdapter(config, "-t", options);
    const { feet: home } = await playerPosition(adapter);
    const far = { x: home.x + 12, y: home.y, z: home.z };
    const session = adapter.session;
    if (!session) throw new Error("adapter has no session");
    const actionId = randomUUID();
    const controller = new AbortController();
    const operation = adapter.executeAction(
      { actionId, sessionId: session.id, capability: "minecraft.navigate", input: { ...far, range: 1 } },
      controller.signal,
    );
    const interruptAt = setTimeout(() => {
      controller.abort(new Error("probe deadline"));
      // Cancel is sent synchronously after the abort, as the action executor does, so the adapter still owns the action.
      void adapter?.cancelActiveAction(actionId, "probe deadline");
    }, 1_200);
    let outcomeLabel: string;
    try {
      const outcome = await operation;
      outcomeLabel = outcome.confirmed ? "completed-before-deadline" : "returned-unconfirmed";
    } catch (error) {
      outcomeLabel = `rejected:${errorCode(error)}`;
    } finally {
      clearTimeout(interruptAt);
    }
    const afterCancel = (await playerPosition(adapter)).feet;
    await delay(1_000);
    const settleStart = (await playerPosition(adapter)).feet;
    await delay(1_500);
    const settled = (await playerPosition(adapter)).feet;
    const drift = distance(settleStart, settled);
    notes.push(`Interrupted walk outcome: ${outcomeLabel}; position at cancel ${formatVec(afterCancel)}`);

    let failureCode = "none";
    try {
      await act(adapter, "minecraft.navigate", { x: home.x, y: home.y + 30, z: home.z, range: 1 });
    } catch (error) {
      failureCode = errorCode(error);
    }
    notes.push(`Unreachable goal (30 blocks up): ${failureCode}`);

    const recovery = await act(adapter, "minecraft.navigate", { ...home, range: 1 });

    const assertions = [
      assert(
        "The interrupted walk is reported as interrupted, not as success",
        outcomeLabel.startsWith("rejected:"),
        "rejected with a code",
        outcomeLabel,
      ),
      assert("The bot stops after the cancel (under 0.5 block drift in 1.5 s)", drift <= 0.5, "drift <= 0.5 blocks", `${drift.toFixed(2)} blocks`),
      assert(
        "An unreachable goal fails with a stable planner code",
        failureCode === "PATH_NOT_FOUND" || failureCode === "PATH_PLANNING_TIMEOUT",
        "PATH_NOT_FOUND or PATH_PLANNING_TIMEOUT",
        failureCode,
      ),
      assert(
        "The next action succeeds after the failures (recovery)",
        recovery.confirmed === true,
        "confirmed walk back to the start",
        `confirmed=${recovery.confirmed}`,
      ),
    ];
    return result("timeout-recovery", start, assertions, notes, null, true);
  } catch (error) {
    return notRun("timeout-recovery", start, error);
  } finally {
    await adapter?.disconnect("timeout check finished").catch(() => undefined);
  }
}

const DIGGABLE_DROPS: Record<string, string> = {
  dirt: "dirt",
  grass_block: "dirt",
  stone: "cobblestone",
  cobblestone: "cobblestone",
  gravel: "gravel",
  sand: "sand",
};

async function digPhase(config: LiveServerConfig, options: ActionCheckOptions): Promise<LivePhaseResult> {
  const start = Date.now();
  if (!options.allowDig) return skipped("dig", start, "digging changes the world; pass --allow-dig to run it", false);
  let adapter: ActionAdapter | null = null;
  try {
    adapter = await connectAdapter(config, "-g", options);
    const { state, feet } = await playerPosition(adapter);
    const eye = { x: feet.x + 0.5, y: feet.y + 1.62, z: feet.z + 0.5 };
    const candidate = (state.nearbyBlocks as Array<{ name: string; position: Vec }>)
      .filter((block) => DIGGABLE_DROPS[block.name] !== undefined)
      .map((block) => ({ block, d: distance(eye, { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 }) }))
      .filter((entry) => entry.d <= 3.5)
      .sort((a, b) => a.d - b.d)[0];
    if (!candidate) {
      return skipped("dig", start, "no dirt, grass, stone, gravel or sand block within 3.5 blocks of the feet", true);
    }
    const { block } = candidate;
    const drop = DIGGABLE_DROPS[block.name]!;
    const before = (state.inventory as Array<{ name: string; count: number }>)
      .filter((stack) => stack.name === drop)
      .reduce((sum, stack) => sum + stack.count, 0);
    const outcome = await act(adapter, "minecraft.mine_block", {
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      blockName: block.name,
      dangerRadius: 6,
    });
    const notes = [`Target ${block.name} at ${formatVec(block.position)}; drop ${drop}; inventory before ${before}`];
    const assertions = [
      assert(
        "The block is removed and its drop enters the inventory",
        outcome.confirmed === true,
        "confirmed (block removed and inventory gained)",
        `confirmed=${outcome.confirmed} ${outcome.confirmation ?? ""}`,
      ),
    ];
    return result("dig", start, assertions, notes, null, true);
  } catch (error) {
    return notRun("dig", start, error);
  } finally {
    await adapter?.disconnect("dig check finished").catch(() => undefined);
  }
}

async function swimPhase(config: LiveServerConfig, options: ActionCheckOptions): Promise<LivePhaseResult> {
  const start = Date.now();
  let adapter: ActionAdapter | null = null;
  try {
    adapter = await connectAdapter(config, "-s", options);
    const { state } = await playerPosition(adapter);
    if (state.player.inWater !== true && state.player.headInWater !== true) {
      return skipped("swim", start, "the bot is not in water; the swim check needs a submerged start", true);
    }
    const outcome = await act(adapter, "minecraft.swim_to_surface", { maxDistance: 8 });
    const after = await playerPosition(adapter);
    const assertions = [
      assert(
        "The bot leaves the water, confirmed from the observed state",
        outcome.confirmed === true && after.state.player.inWater === false && after.state.player.headInWater === false,
        "confirmed; body and head out of water",
        `confirmed=${outcome.confirmed} inWater=${after.state.player.inWater} headInWater=${after.state.player.headInWater}`,
      ),
    ];
    return result("swim", start, assertions, [`Swim outcome: ${outcome.confirmation}`], null, true);
  } catch (error) {
    return notRun("swim", start, error);
  } finally {
    await adapter?.disconnect("swim check finished").catch(() => undefined);
  }
}

async function combatPhase(config: LiveServerConfig, options: ActionCheckOptions): Promise<LivePhaseResult> {
  const start = Date.now();
  if (!options.allowCombat) return skipped("combat", start, "combat changes the world; pass --allow-combat to run it", false);
  let adapter: ActionAdapter | null = null;
  try {
    adapter = await connectAdapter(config, "-k", options);
    const { state, feet } = await playerPosition(adapter);
    const hostile = (state.entities as Array<{ id: string; name: string; type: string; position: Vec; distance: number }>)
      .filter((entity) => entity.type === "hostile")
      .sort((a, b) => a.distance - b.distance)[0];
    if (!hostile) {
      return skipped("combat", start, "no hostile entity is visible; combat cannot be exercised on this server", true);
    }
    const outcome = await act(adapter, "minecraft.attack_hostile", { entityId: hostile.id, maxHits: 4, dangerRadius: 6 });
    const assertions = [
      assert(
        "The attack is confirmed by the observed hostile state",
        outcome.confirmed === true,
        "confirmed (hit or killed, observed)",
        `confirmed=${outcome.confirmed} ${outcome.confirmation ?? ""}`,
      ),
    ];
    return result("combat", start, assertions, [`Target ${hostile.name} at distance ${hostile.distance.toFixed(1)} from ${formatVec(feet)}`], null, true);
  } catch (error) {
    return notRun("combat", start, error);
  } finally {
    await adapter?.disconnect("combat check finished").catch(() => undefined);
  }
}

const RUNNERS: Record<string, (config: LiveServerConfig, options: ActionCheckOptions) => Promise<LivePhaseResult>> = {
  movement: movementPhase,
  "timeout-recovery": timeoutRecoveryPhase,
  dig: digPhase,
  swim: swimPhase,
  combat: combatPhase,
};

/** Runs one action phase. Unknown names are a programming error and are reported as failures. */
export async function runActionPhase(
  phase: LivePhase,
  config: LiveServerConfig,
  options: ActionCheckOptions,
): Promise<LivePhaseResult> {
  const runner = RUNNERS[phase];
  if (!runner) throw new Error(`not an action phase: ${phase}`);
  return runner(config, options);
}
