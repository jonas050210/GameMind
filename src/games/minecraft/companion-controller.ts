import type { Logger } from "pino";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import type { MinecraftObservation } from "./observation.js";
import type { MinecraftTask } from "./task.js";
import type { MinecraftTaskResult } from "./task-runner.js";
import { buildShelterTaskSchema, gatherResourceTaskSchema } from "./task.js";
import { parseCompanionCommand, type CompanionMode } from "./companion-command.js";
import { CompanionMemory, type CompanionLocation } from "./companion-memory.js";
import type { WorldMemory } from "./world-memory.js";
import { chooseExplorationWaypoint } from "./exploration.js";
import { buildLocalTerrainModel } from "./terrain-model.js";
import { isHostileMinecraftEntity } from "./threats.js";

export interface CompanionMessage {
  readonly at: string;
  readonly direction: "in" | "out";
  readonly source: "control-center" | "minecraft" | "agent";
  readonly speaker: string | null;
  readonly text: string;
  readonly ok: boolean | null;
}

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
  readonly history: readonly CompanionMessage[];
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
  readonly replyMinecraft?: (message: string, recipient: string | null) => void;
}

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

/** Persistent companion-mode coordinator over the same runtime and skills used by autonomous tasks. */
export class CompanionController {
  private mode: CompanionMode = "idle";
  private targetPlayer: string | null = null;
  private anchor: CompanionLocation | null = null;
  private lastTransitionAt = new Date().toISOString();
  private reason = "No companion instruction has been issued.";
  private executing = false;
  private lastOutcome: string | null = null;
  private history: CompanionMessage[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private explorationLegs = 0;
  private activeHomepoint: string | null = null;
  private measuredSeparation: number | null = null;
  private followState: FollowRecoveryState = "inactive";
  private missingTargetCycles = 0;
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
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 1_000);
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

  async submit(text: string, source: "control-center" | "minecraft", speaker: string | null = null): Promise<{ ok: boolean; message: string }> {
    this.record({ direction: "in", source, speaker, text, ok: null });
    const parsed = parseCompanionCommand(text, speaker);
    if (!parsed.command) return this.respond(parsed.error ?? "Command was not understood.", false, source, speaker);
    const command = parsed.command;
    if (command.type === "help") {
      return this.respond("Commands: #follow, #come, #hold, #combat, #afk, #guard, #sethome <name>, #home [name], #homes, #delhome <name>, #return, #gather <log> <count>, #explore, #status, #unstuck, #stop.", true, source, speaker);
    }
    if (command.type === "status") return this.respond(this.statusText(), true, source, speaker);
    if (command.type === "stop") {
      this.options.requestTaskStop(`stopped by ${speaker ?? source}`);
      await this.transition("idle", null, "Explicit stop: task interruption requested and autonomous companion actions disabled.");
      return this.respond("Stopped. I will not start another action until instructed.", true, source, speaker);
    }
    if (command.type === "save-home") {
      const location = this.currentLocation();
      if (!location) return this.respond("I cannot save a homepoint without a current observation and position.", false, source, speaker);
      const saved = await this.options.companionMemory.createHomepoint(command.name, location);
      if (!saved.ok) return this.respond(saved.reason, false, source, speaker);
      return this.respond(`Homepoint '${command.name}' saved at ${location.x.toFixed(1)}, ${location.y.toFixed(1)}, ${location.z.toFixed(1)} in ${location.dimension ?? "unknown dimension"}.`, true, source, speaker);
    }
    if (command.type === "list-homes") {
      const homes = this.snapshot().homepoints;
      if (!homes.length) return this.respond("No homepoints are saved.", true, source, speaker);
      return this.respond(homes.map((entry) => `${entry.name}: ${entry.location.dimension ?? "unknown dimension"} ${entry.location.x.toFixed(1)}, ${entry.location.y.toFixed(1)}, ${entry.location.z.toFixed(1)} [${entry.availability}]`).join("; "), true, source, speaker);
    }
    if (command.type === "delete-home") {
      const deleted = await this.options.companionMemory.deleteHomepoint(command.name);
      if (!deleted) return this.respond(`Homepoint '${command.name}' does not exist.`, false, source, speaker);
      if (this.activeHomepoint === command.name) {
        this.activeHomepoint = null;
        await this.transition("idle", null, `Active homepoint '${command.name}' was deleted; navigation stopped.`);
      }
      return this.respond(`Homepoint '${command.name}' deleted.`, true, source, speaker);
    }
    if (command.type === "go-home") {
      const entry = this.options.companionMemory.homepoint(command.name);
      if (!entry) return this.respond(`Homepoint '${command.name}' does not exist. Use #homes to list saved destinations.`, false, source, speaker);
      const currentDimension = this.options.runtime.currentWorldState?.state.player.dimension ?? null;
      if (entry.location.dimension === null || currentDimension === null) {
        return this.respond(`Cannot navigate to '${command.name}' because its dimension or the current dimension is unknown.`, false, source, speaker);
      }
      if (entry.location.dimension !== currentDimension) {
        return this.respond(`Homepoint '${command.name}' is in ${entry.location.dimension}, but I am in ${currentDimension}. No verified cross-dimension route is available.`, false, source, speaker);
      }
      if (this.options.taskRunning()) this.options.requestTaskStop(`interrupted by homepoint navigation to ${command.name}`);
      this.activeHomepoint = command.name;
      this.anchor = entry.location;
      await this.transition("return", null, `Navigating to homepoint '${command.name}'; arrival will be revalidated from a fresh observation.`);
      const stale = Date.now() - Date.parse(entry.location.savedAt) > homepointStaleMs ? " The saved coordinates are stale and require revalidation." : "";
      return this.respond(`Navigating to homepoint '${command.name}' in ${currentDimension}.${stale}`, true, source, speaker);
    }
    if (command.type === "gather" || command.type === "build-shelter") {
      const separation = this.currentTargetSeparation();
      if (this.mode === "follow" && separation !== null && separation >= catchUpDistance) {
        return this.respond(`Cannot start ordinary work while ${this.targetPlayer} is ${separation.toFixed(1)} blocks away; safe catch-up has priority.`, false, source, speaker);
      }
      if (this.options.taskRunning()) return this.respond("A verified task is already running. Use #stop before replacing it.", false, source, speaker);
      const task = command.type === "gather"
        ? gatherResourceTaskSchema.parse({ id: `companion-gather-${command.resource}`, resourceName: command.resource, targetCount: command.count, maxActions: Math.min(100, Math.max(16, command.count * 6)) })
        : buildShelterTaskSchema.parse({ id: "companion-build-shelter", mode: "cardinal", maxBlocks: 4, maxActions: 30 });
      await this.transition("task", speaker, `Running verified ${task.kind} objective '${task.id}'.`);
      void this.options.runTask(task).then(async (result) => {
        const message = result.status === "succeeded"
          ? `${task.id} completed from verified game state.`
          : `${task.id} ended ${result.status}: ${result.failure?.code ?? "no code"} — ${result.failure?.message ?? "no reason reported"}`;
        this.lastOutcome = message;
        await this.options.companionMemory.update({ lastTask: { id: task.id, status: result.status, at: new Date().toISOString(), failureCode: result.failure?.code ?? null } });
        if (this.mode === "task") await this.transition("idle", null, message);
        this.record({ direction: "out", source: "agent", speaker: null, text: message, ok: result.status === "succeeded" });
        this.options.replyMinecraft?.(message, speaker);
      }).catch(async (error: unknown) => {
        const message = `Task failed to start or crashed: ${error instanceof Error ? error.message : String(error)}`;
        this.lastOutcome = message;
        if (this.mode === "task") await this.transition("idle", null, message);
      });
      return this.respond(`Accepted ${task.id}; progress and verified outcomes are now tracked.`, true, source, speaker);
    }

    const target = command.targetPlayer;
    const currentSeparation = this.currentTargetSeparation();
    if (command.mode === "explore" && this.mode === "follow" && currentSeparation !== null && currentSeparation >= catchUpDistance) {
      return this.respond(`Cannot explore while ${this.targetPlayer} is ${currentSeparation.toFixed(1)} blocks away; safe catch-up has priority.`, false, source, speaker);
    }
    if ((command.mode === "follow" || command.mode === "come" || command.mode === "afk") && !target) {
      return this.respond(`${command.mode} needs a player name. Use #${command.mode} <player> or issue it from authorized Minecraft chat.`, false, source, speaker);
    }
    if (this.options.taskRunning()) {
      this.options.requestTaskStop(`interrupted by companion mode ${command.mode}`);
    }
    if (command.mode === "combat") {
      const armed = this.options.setCombatAllowed(true);
      if (!armed.ok) return this.respond(armed.message, false, source, speaker);
    }
    let anchor: CompanionLocation | null = null;
    if (command.mode === "hold" || command.mode === "guard") {
      anchor = this.currentLocation();
      if (!anchor) return this.respond(`Cannot enter ${command.mode} without a current position.`, false, source, speaker);
      await this.options.companionMemory.update(command.mode === "hold" ? { hold: anchor } : { guard: anchor });
    }
    if (command.mode === "return") {
      const defaultHome = this.options.companionMemory.homepoint("default");
      if (!defaultHome) return this.respond("No default home is saved. Use #home at a confirmed location first.", false, source, speaker);
      const dimension = this.options.runtime.currentWorldState?.state.player.dimension ?? null;
      if (!dimension || !defaultHome.location.dimension || dimension !== defaultHome.location.dimension) {
        return this.respond(`Default home is in ${defaultHome.location.dimension ?? "an unknown dimension"}, but the current dimension is ${dimension ?? "unknown"}; no verified route is available.`, false, source, speaker);
      }
      this.activeHomepoint = "default";
      anchor = defaultHome.location;
    }
    this.anchor = anchor;
    await this.transition(command.mode, target, `Mode selected by ${speaker ?? source}.`);
    return this.respond(`Mode is now ${command.mode}${target ? ` with ${target}` : ""}.`, true, source, speaker);
  }

  private async transition(mode: CompanionMode, targetPlayer: string | null, reason: string): Promise<void> {
    this.mode = mode;
    this.targetPlayer = targetPlayer;
    this.reason = reason;
    this.lastTransitionAt = new Date().toISOString();
    this.explorationLegs = 0;
    if (mode !== "return") this.activeHomepoint = null;
    if (mode !== "follow" && mode !== "come" && mode !== "afk") {
      this.measuredSeparation = null;
      this.followState = mode === "hold" && (reason.includes("absent") || reason.includes("wandering")) ? "holding-lost" : "inactive";
      this.missingTargetCycles = 0;
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

  private statusText(): string {
    const world = this.options.runtime.currentWorldState?.state;
    if (!world) return `Mode ${this.mode}; world state unavailable.`;
    const blocker = this.lastOutcome ? ` Last outcome: ${this.lastOutcome}` : "";
    const health = world.player.health === null ? "unknown" : Number(world.player.health.toFixed(1));
    const food = world.player.food === null ? "unknown" : Number(world.player.food.toFixed(1));
    return `Mode ${this.mode}; health ${health}/20; hunger ${food}/20; game mode ${world.player.gameMode ?? "unknown"}; position ${world.player.position.x.toFixed(1)}, ${world.player.position.y.toFixed(1)}, ${world.player.position.z.toFixed(1)}; ${itemSummary(world)}.${blocker}`;
  }

  private record(entry: Omit<CompanionMessage, "at">): void {
    this.history.push({ at: new Date().toISOString(), ...entry });
    if (this.history.length > 80) this.history.splice(0, this.history.length - 80);
  }

  private respond(message: string, ok: boolean, source: "control-center" | "minecraft", speaker: string | null): { ok: boolean; message: string } {
    this.record({ direction: "out", source: "agent", speaker: null, text: message, ok });
    if (source === "minecraft") this.options.replyMinecraft?.(message, speaker);
    return { ok, message };
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
          } else if (this.missingTargetCycles >= targetMissingCycleLimit) {
            const missingTarget = this.targetPlayer;
            this.anchor = this.currentLocation();
            await this.transition("hold", null, `Target '${missingTarget}' was absent for ${targetMissingCycleLimit} fresh observations; holding the current position. The player may be out of range or disconnected.`);
            this.lastOutcome = this.reason;
          } else {
            this.lastOutcome = `Target '${this.targetPlayer}' is absent from fresh observation ${this.missingTargetCycles}/${targetMissingCycleLimit}; waiting without moving.`;
          }
          return;
        }
        this.missingTargetCycles = 0;
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
