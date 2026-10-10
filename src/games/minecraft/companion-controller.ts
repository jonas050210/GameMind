import type { Logger } from "pino";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import type { MinecraftObservation } from "./observation.js";
import type { MinecraftTask } from "./task.js";
import type { MinecraftTaskResult } from "./task-runner.js";
import { buildShelterTaskSchema, gatherResourceTaskSchema } from "./task.js";
import type { CompanionMode } from "./companion-modes.js";
import { normalizeHomepointName } from "./companion-modes.js";
import { minecraftLogNames } from "./capabilities.js";
import { CompanionMemory, type CompanionLocation } from "./companion-memory.js";
import type { WorldMemory } from "./world-memory.js";
import { chooseExplorationWaypoint } from "./exploration.js";
import { buildLocalTerrainModel } from "./terrain-model.js";
import { isHostileMinecraftEntity } from "./threats.js";

/**
 * Structured operation log entry. The chat transcript (in/out text commands) was removed with the
 * chat-command system; this log records executed Library operations and their measured outcomes.
 */
export interface CompanionHistoryEntry {
  readonly at: string;
  readonly kind: "mode" | "homepoint" | "task" | "status" | "system";
  readonly text: string;
  readonly ok: boolean | null;
}

/** @deprecated Use CompanionHistoryEntry; kept as an alias for snapshot compatibility. */
export type CompanionMessage = CompanionHistoryEntry;

export type FollowRecoveryState = "inactive" | "close" | "following" | "catching-up" | "target-missing" | "observation-stale" | "dimension-mismatch" | "holding-lost" | "blocked";

export interface CompanionSnapshot {
  readonly mode: CompanionMode;
  readonly targetPlayer: string | null;
  readonly anchor: CompanionLocation | null;
  readonly home: CompanionLocation | null;
  readonly homepoints: readonly { readonly name: string; readonly location: CompanionLocation; readonly availability: "available" | "stale" | "different-dimension" | "dimension-unknown" }[];
  readonly activeHomepoint: string | null;
  readonly preferredFollowDistance: number;
  readonly normalMaximumSeparation: number;
  readonly measuredSeparation: number | null;
  readonly followState: FollowRecoveryState;
  readonly knownStorage: readonly { readonly blockName: string; readonly x: number; readonly y: number; readonly z: number; readonly dimension: string | null; readonly lastSeenAt: string; readonly lastSeenSequence: number }[];
  readonly lastTransitionAt: string;
  readonly reason: string;
  readonly executing: boolean;
  readonly lastOutcome: string | null;
  readonly history: readonly CompanionHistoryEntry[];
}

export interface CompanionControllerOptions {
  readonly runtime: GameMindRuntime<MinecraftObservation>;
  readonly skills: SkillRuntime;
  readonly memory: WorldMemory;
  readonly companionMemory: CompanionMemory;
  readonly logger: Logger;
  runTask(task: MinecraftTask): Promise<MinecraftTaskResult>;
  taskRunning(): boolean;
  requestTaskStop(reason: string): void;
  setCombatAllowed(enabled: boolean): { ok: boolean; message: string };
  readonly intervalMs?: number;
}

export type CompanionSettableMode = Exclude<CompanionMode, "task" | "idle">;

const preferredFollowDistance = 4;
const followStopDistance = 5;
const followResumeDistance = 6;
const catchUpDistance = 24;
const normalMaximumSeparation = 32;
const targetMissingCycleLimit = 5;
const homepointStaleMs = 7 * 24 * 60 * 60 * 1_000;

function itemSummary(state: MinecraftObservation): string {
  if (!state.inventory.length) return "inventory empty";
  return state.inventory.slice(0, 6).map((item) => `${item.name}×${item.count}`).join(", ");
}

function measuredDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Persistent companion-mode coordinator over the same runtime and skills used by autonomous tasks.
 * All control arrives through structured methods (the Library); there is no text-command parsing.
 */
export class CompanionController {
  private mode: CompanionMode = "idle";
  private targetPlayer: string | null = null;
  private anchor: CompanionLocation | null = null;
  private lastTransitionAt = new Date().toISOString();
  private reason = "No companion instruction has been issued.";
  private executing = false;
  private lastOutcome: string | null = null;
  private history: CompanionHistoryEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private explorationLegs = 0;
  private activeHomepoint: string | null = null;
  private measuredSeparation: number | null = null;
  private followState: FollowRecoveryState = "inactive";
  private missingTargetCycles = 0;
  private targetLastSeenAt: number | null = null;
  private lastTargetDimension: string | null = null;

  constructor(private readonly options: CompanionControllerOptions) {
    const saved = options.companionMemory.snapshot();
    // One-shot and armed protection modes never resume blindly after a process restart. Durable locations
    // and the previous preference remain in the journal, but movement/combat needs a fresh instruction.
    this.mode = ["task", "come", "unstuck", "combat", "afk", "guard", "return"].includes(saved.preferredMode)
      ? "idle"
      : saved.preferredMode;
    this.targetPlayer = saved.targetPlayer;
    this.anchor = this.mode === "guard" ? saved.guard : this.mode === "hold" ? saved.hold : null;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.observationIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): CompanionSnapshot {
    const memory = this.options.companionMemory.snapshot();
    const dimension = this.options.runtime.currentWorldState?.state.player.dimension ?? null;
    const now = Date.now();
    return {
      mode: this.mode,
      targetPlayer: this.targetPlayer,
      anchor: this.anchor,
      home: memory.home,
      homepoints: memory.homepoints.map((entry) => ({
        ...entry,
        availability: entry.location.dimension === null || dimension === null
          ? "dimension-unknown" as const
          : entry.location.dimension !== dimension
            ? "different-dimension" as const
            : now - Date.parse(entry.location.savedAt) > homepointStaleMs
              ? "stale" as const
              : "available" as const,
      })),
      activeHomepoint: this.activeHomepoint,
      preferredFollowDistance,
      normalMaximumSeparation,
      measuredSeparation: this.measuredSeparation,
      followState: this.followState,
      knownStorage: memory.storage,
      lastTransitionAt: this.lastTransitionAt,
      reason: this.reason,
      executing: this.executing,
      lastOutcome: this.lastOutcome,
      history: [...this.history].slice(-40).reverse(),
    };
  }

  // ------------------------------------------------------------------ Library API

  async setMode(
    mode: CompanionSettableMode,
    options: { readonly targetPlayer?: string | null } = {},
  ): Promise<{ ok: boolean; message: string }> {
    const target = options.targetPlayer ?? null;
    const currentSeparation = this.currentTargetSeparation();
    if (mode === "explore" && this.mode === "follow" && currentSeparation !== null && currentSeparation >= catchUpDistance) {
      return this.log("mode", `Cannot explore while ${this.targetPlayer} is ${currentSeparation.toFixed(1)} blocks away; safe catch-up has priority.`, false);
    }
    if ((mode === "follow" || mode === "come" || mode === "afk") && !target) {
      return this.log("mode", `${mode} needs a player name. Provide the exact in-game username.`, false);
    }
    if (this.options.taskRunning()) {
      this.options.requestTaskStop(`interrupted by companion mode ${mode}`);
    }
    if (mode === "combat") {
      const armed = this.options.setCombatAllowed(true);
      if (!armed.ok) return this.log("mode", armed.message, false);
    }
    let anchor: CompanionLocation | null = null;
    if (mode === "hold" || mode === "guard") {
      anchor = this.currentLocation();
      if (!anchor) return this.log("mode", `Cannot enter ${mode} without a current position.`, false);
      await this.options.companionMemory.update(mode === "hold" ? { hold: anchor } : { guard: anchor });
    }
    if (mode === "return") {
      const defaultHome = this.options.companionMemory.homepoint("default");
      if (!defaultHome) return this.log("mode", "No default home is saved. Save a default home from the Library first.", false);
      const dimension = this.options.runtime.currentWorldState?.state.player.dimension ?? null;
      if (!dimension || !defaultHome.location.dimension || dimension !== defaultHome.location.dimension) {
        return this.log("mode", `Default home is in ${defaultHome.location.dimension ?? "an unknown dimension"}, but the current dimension is ${dimension ?? "unknown"}; no verified route is available.`, false);
      }
      this.activeHomepoint = "default";
      anchor = defaultHome.location;
    }
    this.anchor = anchor;
    await this.transition(mode, target, "Mode selected from the Library.");
    return this.log("mode", `Mode is now ${mode}${target ? ` with ${target}` : ""}.`, true);
  }

  /** Requests the running task to stop and returns the companion to idle. */
  async halt(reason: string): Promise<{ ok: boolean; message: string }> {
    this.options.requestTaskStop(reason);
    await this.transition("idle", null, "Explicit stop: task interruption requested and autonomous companion actions disabled.");
    return this.log("mode", "Stopped. The companion will not start another action until instructed.", true);
  }

  async saveHomepoint(rawName: string): Promise<{ ok: boolean; message: string }> {
    const name = normalizeHomepointName(rawName);
    if (!name) {
      return this.log("homepoint", "Invalid homepoint name. Use 1–32 lowercase letters, numbers, '_' or '-', starting with a letter.", false);
    }
    const location = this.currentLocation();
    if (!location) return this.log("homepoint", "Cannot save a homepoint without a current observation and position.", false);
    const saved = await this.options.companionMemory.createHomepoint(name, location);
    if (!saved.ok) return this.log("homepoint", saved.reason, false);
    return this.log("homepoint", `Homepoint '${name}' saved at ${location.x.toFixed(1)}, ${location.y.toFixed(1)}, ${location.z.toFixed(1)} in ${location.dimension ?? "unknown dimension"}.`, true);
  }

  async goHomepoint(rawName: string): Promise<{ ok: boolean; message: string }> {
    const name = normalizeHomepointName(rawName);
    if (!name) {
      return this.log("homepoint", "Invalid homepoint name. Use 1–32 lowercase letters, numbers, '_' or '-', starting with a letter.", false);
    }
    const entry = this.options.companionMemory.homepoint(name);
    if (!entry) return this.log("homepoint", `Homepoint '${name}' does not exist. List saved destinations from the Library.`, false);
    const currentDimension = this.options.runtime.currentWorldState?.state.player.dimension ?? null;
    if (entry.location.dimension === null || currentDimension === null) {
      return this.log("homepoint", `Cannot navigate to '${name}' because its dimension or the current dimension is unknown.`, false);
    }
    if (entry.location.dimension !== currentDimension) {
      return this.log("homepoint", `Homepoint '${name}' is in ${entry.location.dimension}, but I am in ${currentDimension}. No verified cross-dimension route is available.`, false);
    }
    if (this.options.taskRunning()) this.options.requestTaskStop(`interrupted by homepoint navigation to ${name}`);
    this.activeHomepoint = name;
    this.anchor = entry.location;
    await this.transition("return", null, `Navigating to homepoint '${name}'; arrival will be revalidated from a fresh observation.`);
    const stale = Date.now() - Date.parse(entry.location.savedAt) > homepointStaleMs ? " The saved coordinates are stale and require revalidation." : "";
    return this.log("homepoint", `Navigating to homepoint '${name}' in ${currentDimension}.${stale}`, true);
  }

  async listHomepoints(): Promise<{ ok: boolean; message: string }> {
    const homes = this.snapshot().homepoints;
    if (!homes.length) return this.log("homepoint", "No homepoints are saved.", true);
    return this.log("homepoint", homes.map((entry) => `${entry.name}: ${entry.location.dimension ?? "unknown dimension"} ${entry.location.x.toFixed(1)}, ${entry.location.y.toFixed(1)}, ${entry.location.z.toFixed(1)} [${entry.availability}]`).join("; "), true);
  }

  async deleteHomepoint(rawName: string): Promise<{ ok: boolean; message: string }> {
    const name = normalizeHomepointName(rawName);
    if (!name) {
      return this.log("homepoint", "Invalid homepoint name. Use 1–32 lowercase letters, numbers, '_' or '-', starting with a letter.", false);
    }
    const deleted = await this.options.companionMemory.deleteHomepoint(name);
    if (!deleted) return this.log("homepoint", `Homepoint '${name}' does not exist.`, false);
    if (this.activeHomepoint === name) {
      this.activeHomepoint = null;
      await this.transition("idle", null, `Active homepoint '${name}' was deleted; navigation stopped.`);
    }
    return this.log("homepoint", `Homepoint '${name}' deleted.`, true);
  }

  async startGather(
    resource: (typeof minecraftLogNames)[number],
    count: number,
  ): Promise<{ ok: boolean; message: string; taskId?: string }> {
    if (!(minecraftLogNames as readonly string[]).includes(resource)) {
      return { ok: false, message: `Unknown gather resource '${resource}'. Supported: ${minecraftLogNames.join(", ")}.` };
    }
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      return { ok: false, message: "Gather count must be a whole number from 1 through 64." };
    }
    const separation = this.currentTargetSeparation();
    if (this.mode === "follow" && separation !== null && separation >= catchUpDistance) {
      return this.logTask(`Cannot start ordinary work while ${this.targetPlayer} is ${separation.toFixed(1)} blocks away; safe catch-up has priority.`, false);
    }
    if (this.options.taskRunning()) return this.logTask("A verified task is already running. Stop the companion before replacing it.", false);
    const task = gatherResourceTaskSchema.parse({ id: `companion-gather-${resource}`, resourceName: resource, targetCount: count, maxActions: Math.min(100, Math.max(16, count * 6)) });
    return this.startCompanionTask(task);
  }

  async startBuildShelter(): Promise<{ ok: boolean; message: string; taskId?: string }> {
    const separation = this.currentTargetSeparation();
    if (this.mode === "follow" && separation !== null && separation >= catchUpDistance) {
      return this.logTask(`Cannot start ordinary work while ${this.targetPlayer} is ${separation.toFixed(1)} blocks away; safe catch-up has priority.`, false);
    }
    if (this.options.taskRunning()) return this.logTask("A verified task is already running. Stop the companion before replacing it.", false);
    const task = buildShelterTaskSchema.parse({ id: "companion-build-shelter", mode: "cardinal", maxBlocks: 4, maxActions: 30 });
    return this.startCompanionTask(task);
  }

  async getStatus(): Promise<{ ok: boolean; message: string }> {
    return this.log("status", this.statusText(), true);
  }

  private async startCompanionTask(task: MinecraftTask): Promise<{ ok: boolean; message: string; taskId: string }> {
    await this.transition("task", this.targetPlayer, `Running verified ${task.kind} objective '${task.id}'.`);
    void this.options.runTask(task).then(async (result) => {
      const message = result.status === "succeeded"
        ? `${task.id} completed from verified game state.`
        : `${task.id} ended ${result.status}: ${result.failure?.code ?? "no code"} — ${result.failure?.message ?? "no reason reported"}`;
      this.lastOutcome = message;
      await this.options.companionMemory.update({ lastTask: { id: task.id, status: result.status, at: new Date().toISOString(), failureCode: result.failure?.code ?? null } });
      if (this.mode === "task") await this.transition("idle", null, message);
      this.record({ kind: "task", text: message, ok: result.status === "succeeded" });
    }).catch(async (error: unknown) => {
      const message = `Task failed to start or crashed: ${error instanceof Error ? error.message : String(error)}`;
      this.lastOutcome = message;
      if (this.mode === "task") await this.transition("idle", null, message);
    });
    const message = `Started ${task.id}; progress and verified outcomes are now tracked.`;
    this.record({ kind: "task", text: message, ok: true });
    return { ok: true, message, taskId: task.id };
  }

  private log(kind: CompanionHistoryEntry["kind"], message: string, ok: boolean): { ok: boolean; message: string } {
    this.record({ kind, text: message, ok });
    return { ok, message };
  }

  private logTask(message: string, ok: boolean): { ok: boolean; message: string } {
    return this.log("task", message, ok);
  }

  private async transition(mode: CompanionMode, targetPlayer: string | null, reason: string): Promise<void> {
    this.mode = mode;
    this.targetPlayer = targetPlayer;
    this.reason = reason;
    this.lastTransitionAt = new Date().toISOString();
    this.explorationLegs = 0;
    if (mode !== "return") this.activeHomepoint = null;
    // Every transition ends the current target-tracking stint: absence counters and the remembered
    // target dimension belong to the stint that collected them, never to the next instruction.
    this.missingTargetCycles = 0;
    this.targetLastSeenAt = null;
    this.lastTargetDimension = null;
    if (mode !== "follow" && mode !== "come" && mode !== "afk") {
      this.measuredSeparation = null;
      this.followState = mode === "hold" && (reason.includes("absent") || reason.includes("wandering")) ? "holding-lost" : "inactive";
    }
    await this.options.companionMemory.rememberMode(mode, targetPlayer);
  }

  private currentLocation(): CompanionLocation | null {
    const world = this.options.runtime.currentWorldState;
    if (!world) return null;
    return {
      ...world.state.player.position,
      dimension: world.state.player.dimension,
      savedAt: new Date().toISOString(),
      observationSequence: world.sequence,
    };
  }

  private currentTargetSeparation(): number | null {
    const state = this.options.runtime.currentWorldState?.state;
    if (!state || !this.targetPlayer) return null;
    const player = state.entities.find((entity) => entity.type === "player" && entity.name === this.targetPlayer);
    return player ? measuredDistance(state.player.position, player.position) : null;
  }

  private get observationIntervalMs(): number {
    return Math.max(1, this.options.intervalMs ?? 1_000);
  }

  /**
   * Observation cycles the follow target has been missing for. Timer callbacks that the event loop
   * delays or skips (CPU contention, slow awaits, GC pauses) must still count as failed observation
   * cycles, so the time elapsed since the target was last seen — or since the follow instruction was
   * issued, when it was never seen — is converted into the scheduled cycles it stands for. The larger
   * of the executed and scheduled counts is the honest absence budget.
   */
  private effectiveMissingTargetCycles(): number {
    const missingSinceMs = this.targetLastSeenAt ?? Date.parse(this.lastTransitionAt);
    const scheduledCycles = Number.isFinite(missingSinceMs)
      ? Math.floor((Date.now() - missingSinceMs) / this.observationIntervalMs)
      : 0;
    return Math.max(this.missingTargetCycles, scheduledCycles);
  }

  private statusText(): string {
    const world = this.options.runtime.currentWorldState?.state;
    if (!world) return `Mode ${this.mode}; world state unavailable.`;
    const blocker = this.lastOutcome ? ` Last outcome: ${this.lastOutcome}` : "";
    const health = world.player.health === null ? "unknown" : Number(world.player.health.toFixed(1));
    const food = world.player.food === null ? "unknown" : Number(world.player.food.toFixed(1));
    return `Mode ${this.mode}; health ${health}/20; hunger ${food}/20; game mode ${world.player.gameMode ?? "unknown"}; position ${world.player.position.x.toFixed(1)}, ${world.player.position.y.toFixed(1)}, ${world.player.position.z.toFixed(1)}; ${itemSummary(world)}.${blocker}`;
  }

  private record(entry: Omit<CompanionHistoryEntry, "at">): void {
    this.history.push({ at: new Date().toISOString(), ...entry });
    if (this.history.length > 80) this.history.splice(0, this.history.length - 80);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.executing || this.mode === "task" || this.options.taskRunning()) return;
    if (this.options.runtime.status().adapterStatus !== "connected") {
      this.lastOutcome = "Waiting: Minecraft adapter is disconnected.";
      return;
    }
    this.executing = true;
    try {
      await this.options.runtime.observeIfStale(1_000);
      const world = this.options.runtime.currentWorldState;
      if (!world || world.state.player.alive === false) {
        this.lastOutcome = "Waiting for a confirmed live player state after death or respawn.";
        return;
      }
      const state = world.state;
      const storage = state.nearbyBlocks
        .filter((block) => block.name === "chest" || block.name === "trapped_chest" || block.name === "barrel" || block.name.endsWith("shulker_box"))
        .map((block) => ({
          blockName: block.name, ...block.position, dimension: state.player.dimension,
          lastSeenAt: world.observedAt, lastSeenSequence: world.sequence,
        }));
      await this.options.companionMemory.rememberStorage(storage);
      if (this.mode === "idle") return;
      const hostile = state.entities
        .filter((entity) => isHostileMinecraftEntity(entity.name, entity.type))
        .sort((a, b) => a.distance - b.distance)[0];
      if (hostile && hostile.distance <= 6 && (state.player.health === null || state.player.health < 10)) {
        const dx = state.player.position.x - hostile.position.x;
        const dz = state.player.position.z - hostile.position.z;
        const magnitude = Math.max(0.1, Math.hypot(dx, dz));
        const retreat = {
          x: Math.round(state.player.position.x + (dx / magnitude) * 8),
          y: Math.floor(state.player.position.y),
          z: Math.round(state.player.position.z + (dz / magnitude) * 8),
          range: 1,
        };
        const result = await this.options.skills.run("minecraft.navigate", retreat, { source: `companion:${this.mode}:survival-retreat` });
        this.lastOutcome = `Survival retreat ${result.action.status}: health ${state.player.health ?? "unknown"}, hostile ${hostile.name} at ${hostile.distance.toFixed(1)} blocks.`;
        return;
      }
      if (["combat", "afk", "guard"].includes(this.mode) && hostile && hostile.distance <= 4 && (state.player.health ?? 0) >= 10) {
        const result = await this.options.skills.run("minecraft.attack-hostile", {
          entityId: hostile.id, maxHits: 4, dangerRadius: 6, minHealth: 10, retreatHealth: 6, requiredDamage: 4,
        }, { source: `companion:${this.mode}:defend` });
        this.lastOutcome = `Defence ${result.action.status}: ${result.action.failure?.message ?? result.action.confirmation ?? "no evidence"}`;
        return;
      }
      if (this.mode === "follow" || this.mode === "come" || this.mode === "afk") {
        const observationAge = Date.now() - Date.parse(world.observedAt);
        if (!Number.isFinite(observationAge) || observationAge > 3_000) {
          this.followState = "observation-stale";
          this.lastOutcome = `Stopped follow movement: the latest player observation is ${Number.isFinite(observationAge) ? `${Math.round(observationAge / 1_000)} seconds old` : "invalid"}.`;
          return;
        }
        const player = state.entities.find((entity) => entity.type === "player" && entity.name === this.targetPlayer);
        if (!player) {
          this.measuredSeparation = null;
          this.missingTargetCycles += 1;
          this.followState = "target-missing";
          if (this.lastTargetDimension && state.player.dimension && this.lastTargetDimension !== state.player.dimension) {
            this.followState = "dimension-mismatch";
            this.anchor = this.currentLocation();
            await this.transition("hold", null, `Target '${this.targetPlayer}' was last observed in ${this.lastTargetDimension}, but I am in ${state.player.dimension}; holding instead of wandering.`);
            this.lastOutcome = this.reason;
          } else {
            const missingCycles = this.effectiveMissingTargetCycles();
            if (missingCycles >= targetMissingCycleLimit) {
              const missingTarget = this.targetPlayer;
              this.anchor = this.currentLocation();
              await this.transition("hold", null, `Target '${missingTarget}' was absent for ${targetMissingCycleLimit} fresh observations; holding the current position. The player may be out of range or disconnected.`);
              this.lastOutcome = this.reason;
            } else {
              this.lastOutcome = `Target '${this.targetPlayer}' is absent from fresh observation ${missingCycles}/${targetMissingCycleLimit}; waiting without moving.`;
            }
          }
          return;
        }
        this.missingTargetCycles = 0;
        this.targetLastSeenAt = Date.now();
        this.lastTargetDimension = state.player.dimension;
        const separation = measuredDistance(state.player.position, player.position);
        this.measuredSeparation = separation;
        if (separation <= followStopDistance) {
          this.followState = "close";
          this.lastOutcome = `Holding movement at a measured ${separation.toFixed(1)} blocks from ${this.targetPlayer}; preferred distance is ${preferredFollowDistance} blocks.`;
          if (this.mode === "come") {
            this.anchor = this.currentLocation();
            await this.transition("hold", null, `Reached ${this.targetPlayer} within ${separation.toFixed(1)} measured blocks; holding the verified arrival position.`);
          }
          return;
        }
        if (separation < followResumeDistance && this.followState === "close") return;
        this.followState = separation >= catchUpDistance ? "catching-up" : "following";
        const result = await this.options.skills.run("minecraft.navigate", { ...player.position, range: preferredFollowDistance }, { source: `companion:${this.mode}:${this.targetPlayer}:${this.followState}` });
        if (result.action.status !== "succeeded") this.followState = "blocked";
        const limitEvidence = separation > normalMaximumSeparation
          ? ` Observed separation exceeds the normal ${normalMaximumSeparation}-block target; no claim of maintaining the limit is made.`
          : "";
        this.lastOutcome = `${this.followState === "catching-up" ? "Catch-up" : "Follow"} ${result.action.status} from a measured ${separation.toFixed(1)} blocks toward the latest observed position; ${result.action.confirmation ?? result.action.failure?.message ?? "outcome unverified"}.${limitEvidence}`;
        return;
      }
      const destination = this.mode === "return" ? (this.activeHomepoint ? this.options.companionMemory.homepoint(this.activeHomepoint)?.location ?? null : null) : this.anchor;
      if (this.mode === "hold" && this.followState === "holding-lost") {
        this.lastOutcome = this.reason;
        return;
      }
      if ((this.mode === "hold" || this.mode === "guard" || this.mode === "return") && destination) {
        if (destination.dimension && state.player.dimension && destination.dimension !== state.player.dimension) {
          const name = this.activeHomepoint;
          this.anchor = this.currentLocation();
          await this.transition("hold", null, `Navigation stopped: ${name ? `homepoint '${name}'` : "anchor"} is in ${destination.dimension}, while the observed player is in ${state.player.dimension}.`);
          this.lastOutcome = this.reason;
          return;
        }
        const distance = measuredDistance(state.player.position, destination);
        if (distance > 2.5) {
          const result = await this.options.skills.run("minecraft.navigate", { x: destination.x, y: destination.y, z: destination.z, range: 1 }, { source: `companion:${this.mode}${this.activeHomepoint ? `:${this.activeHomepoint}` : ""}` });
          this.lastOutcome = `Return ${result.action.status}; ${result.action.confirmation ?? result.action.failure?.message ?? "unverified"}.`;
          if (this.mode === "return" && result.action.status === "succeeded" && result.action.confirmed) {
            await this.options.runtime.observeIfStale(0);
            const verifiedWorld = this.options.runtime.currentWorldState;
            const verifiedDistance = verifiedWorld ? measuredDistance(verifiedWorld.state.player.position, destination) : Number.POSITIVE_INFINITY;
            if (verifiedWorld && verifiedDistance <= 2.5 && (!destination.dimension || verifiedWorld.state.player.dimension === destination.dimension)) {
              const name = this.activeHomepoint ?? "default";
              await this.options.companionMemory.revalidateHomepoint(name, verifiedWorld.observedAt, verifiedWorld.sequence);
              this.anchor = destination;
              await this.transition("hold", null, `Fresh observation revalidated arrival within ${verifiedDistance.toFixed(1)} blocks of homepoint '${name}'; holding there.`);
            } else {
              this.lastOutcome = `Navigation reported success, but a fresh observation has not yet revalidated arrival at homepoint '${this.activeHomepoint ?? "default"}'.`;
            }
          }
        } else {
          const name = this.activeHomepoint;
          this.lastOutcome = `Fresh observation places me ${distance.toFixed(1)} blocks from ${name ? `homepoint '${name}'` : `the ${this.mode} anchor`}.`;
          if (this.mode === "return") {
            if (name) await this.options.companionMemory.revalidateHomepoint(name, world.observedAt, world.sequence);
            this.anchor = destination;
            await this.transition("hold", null, this.lastOutcome);
          }
        }
        return;
      }
      if (this.mode === "explore") {
        if (this.explorationLegs >= 12) {
          await this.transition("idle", null, "Exploration stopped after its bounded 12-leg budget.");
          this.lastOutcome = this.reason;
          return;
        }
        const terrain = buildLocalTerrainModel(state);
        const origin = this.anchor ?? this.currentLocation();
        if (!origin) return;
        this.anchor ??= origin;
        const waypoint = chooseExplorationWaypoint(this.options.memory, {
          from: state.player.position,
          origin,
          maxRadius: 64,
          minLeg: 8,
          maxLeg: 32,
          hostileAvoidRadius: 10,
          excludedKeys: new Set<string>(),
          destinationUnsafe: (x, z) => terrain.destinationUnsafe(x, z),
        });
        if (!waypoint) {
          await this.transition("idle", null, "No unexplored frontier remains inside the 64-block exploration radius.");
          this.lastOutcome = this.reason;
          return;
        }
        const result = await this.options.skills.run("minecraft.navigate", { x: waypoint.x, y: Math.floor(state.player.position.y), z: waypoint.z, range: 3 }, { source: `companion:explore:${waypoint.key}` });
        this.explorationLegs += 1;
        this.lastOutcome = `Exploration leg ${this.explorationLegs} ${result.action.status}: ${waypoint.key}.`;
        return;
      }
      if (this.mode === "unstuck") {
        const candidates = [[4, 0], [-4, 0], [0, 4], [0, -4]] as const;
        const terrain = buildLocalTerrainModel(state);
        const candidate = candidates
          .map(([dx, dz]) => ({ x: Math.floor(state.player.position.x) + dx, z: Math.floor(state.player.position.z) + dz }))
          .find((point) => !terrain.destinationUnsafe(point.x, point.z));
        if (!candidate) {
          await this.transition("idle", null, "Unstuck failed: every observed sidestep destination is unsafe.");
          this.lastOutcome = this.reason;
          return;
        }
        const result = await this.options.skills.run("minecraft.navigate", { ...candidate, y: Math.floor(state.player.position.y), range: 1 }, { source: "companion:unstuck" });
        this.lastOutcome = `Unstuck ${result.action.status}: ${result.action.confirmation ?? result.action.failure?.message ?? "unverified"}.`;
        await this.transition(result.action.status === "succeeded" && result.action.confirmed ? "hold" : "idle", null, this.lastOutcome);
      }
    } catch (error) {
      this.lastOutcome = `Companion cycle failed: ${error instanceof Error ? error.message : String(error)}`;
      this.options.logger.warn({ err: error, mode: this.mode }, "Companion cycle failed; next observation will retry if the mode remains active");
    } finally {
      this.executing = false;
    }
  }
}
