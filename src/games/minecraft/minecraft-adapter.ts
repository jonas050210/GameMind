import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createBot,
  type Bot,
  type BotOptions,
  type EquipmentDestination,
} from "mineflayer";
import { plugin as collectBlockPlugin } from "mineflayer-collectblock";
import type { Movements as PathfinderMovements } from "mineflayer-pathfinder";
import type { Logger } from "pino";
import {
  minecraftCapabilities,
  MINECRAFT_COLLECT_BLOCK_CAPABILITY,
  MINECRAFT_CRAFT_CAPABILITY,
  MINECRAFT_EAT_CAPABILITY,
  MINECRAFT_HARVEST_BERRIES_CAPABILITY,
  MINECRAFT_PICKUP_ITEM_CAPABILITY,
  MINECRAFT_PLACE_TABLE_CAPABILITY,
  MINECRAFT_REST_CAPABILITY,
  MINECRAFT_MINE_BLOCK_CAPABILITY,
  MINECRAFT_PLACE_BLOCK_CAPABILITY,
  MINECRAFT_BUILD_SHELTER_CAPABILITY,
  MINECRAFT_ATTACK_HOSTILE_CAPABILITY,
  MINECRAFT_DROP_ITEM_CAPABILITY,
  MINECRAFT_EQUIP_CAPABILITY,
  MINECRAFT_INSPECT_BLOCK_CAPABILITY,
  MINECRAFT_LOOK_CAPABILITY,
  MINECRAFT_NAVIGATE_CAPABILITY,
  minecraftCollectBlockInputSchema,
  minecraftCraftItemInputSchema,
  minecraftEatFoodInputSchema,
  minecraftHarvestBerriesInputSchema,
  minecraftPickupItemInputSchema,
  minecraftPlaceTableInputSchema,
  minecraftRestInputSchema,
  minecraftMineBlockInputSchema,
  minecraftPlaceBlockInputSchema,
  minecraftBuildShelterInputSchema,
  minecraftAttackHostileInputSchema,
  minecraftDropItemInputSchema,
  minecraftEquipInputSchema,
  minecraftInspectBlockInputSchema,
  minecraftLookInputSchema,
  minecraftNavigateInputSchema,
} from "./capabilities.js";
import {
  blockProperties,
  distanceBetween,
  isInterestingBlockName,
  isResourceBlockName,
  blockObservationPriority,
  isRipeBerryBush,
} from "./block-classes.js";
import type { MinecraftObservation } from "./observation.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { isMineableBlockName, minecraftMiningRequirements, estimatedDigSeconds, bestPickaxeTier, canMineWithTier } from "./mining.js";
import { bestWeapon, combatIsAllowed, weaponDamageFor } from "./combat.js";
import { SHELTER_CARDINAL_DIRECTIONS, SHELTER_DIRECTIONS } from "./shelter.js";
import { minecraftObservationSchema } from "./observation.js";
import type {
  AdapterAction,
  AdapterActionOutcome,
  AdapterStatus,
  AdapterStatusChange,
  CapabilityDefinition,
  GameAdapter,
  GameObservation,
  GameSession,
} from "../../core/types.js";

const require = createRequire(import.meta.url);
const unsafePlacementSupportNames = new Set([
  "lava",
  "water",
  "fire",
  "soul_fire",
  "magma_block",
  "cactus",
]);
type BotPosition = Bot["entity"]["position"];
const pathfinderApi = require("mineflayer-pathfinder") as typeof import("mineflayer-pathfinder");
const toolApi = require("mineflayer-tool") as typeof import("mineflayer-tool");

export interface MinecraftAdapterConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly version: string;
  readonly auth: "offline" | "microsoft";
  readonly connectTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly viewDistance: "tiny" | "short" | "normal" | "far";
  readonly observationRadius: number;
  readonly maxObservedBlocks: number;
  readonly entityRadius: number;
  readonly maxNavigationDistance: number;
  readonly maxResourceGatherDistance: number;
  readonly maxCraftingTableDistance: number;
  /** Reach used by block placement (shelter and table). */
  readonly maxPlacementDistance: number;
  /**
   * When false the adapter refuses every attack request outright, regardless of what the planner or
   * the safety broker allows. Combat is opt-in at three independent layers on purpose.
   */
  readonly allowCombat: boolean;
  /** How long a mined drop may take to appear in the inventory after the block breaks. */
  readonly dropSettleMs: number;
  /** Extra seconds a dig may take over Mineflayer's own estimate before the action is cancelled. */
  readonly digTimeoutSlackMs: number;
  readonly navigationStuckTimeoutMs: number;
  readonly resourceScanRadius: number;
  readonly resourceScanLimit: number;
}

export const DEFAULT_MINECRAFT_CONFIG: MinecraftAdapterConfig = {
  host: "127.0.0.1",
  port: 25565,
  username: "GameMind",
  version: "1.20.4",
  auth: "offline",
  connectTimeoutMs: 15_000,
  shutdownTimeoutMs: 2_000,
  viewDistance: "short",
  observationRadius: 3,
  maxObservedBlocks: 64,
  entityRadius: 16,
  maxNavigationDistance: 48,
  maxResourceGatherDistance: 24,
  maxCraftingTableDistance: 4.5,
  maxPlacementDistance: 4.5,
  allowCombat: false,
  dropSettleMs: 2_000,
  digTimeoutSlackMs: 5_000,
  navigationStuckTimeoutMs: 10_000,
  resourceScanRadius: 24,
  resourceScanLimit: 64,
};

export type MinecraftBotFactory = (options: BotOptions) => Bot;

export interface MinecraftAdapterDependencies {
  readonly botFactory?: MinecraftBotFactory;
  readonly installPlugins?: (bot: Bot) => void;
  readonly configureSafeMovements?: (bot: Bot) => void;
}

class MinecraftAdapterError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MinecraftAdapterError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Day-cycle facts from Mineflayer. `timeOfDay` is a 0..1 fraction of the cycle and `isDay` is the
 * server's own judgement; when the server does not send them the agent reports "day, unknown source"
 * rather than guessing night, because night is only used to *add* caution.
 */
function minecraftTimeInfo(bot: Bot): { dayTicks: number; day: number; isNight: boolean } {
  const fraction = typeof bot.time?.timeOfDay === "number" ? bot.time.timeOfDay : Number.NaN;
  const dayTicks = Number.isFinite(fraction)
    ? Math.min(23_999, Math.max(0, Math.round(fraction * 24_000)))
    : 0;
  const day = Number.isFinite(bot.time?.day) ? Math.max(0, Math.trunc(bot.time.day)) : 0;
  const isNight = typeof bot.time?.isDay === "boolean" ? !bot.time.isDay : dayTicks >= 13_000 && dayTicks < 23_000;
  return { dayTicks, day, isNight };
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function angleDifference(left: number, right: number): number {
  let difference = (left - right) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return Math.abs(difference);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Action aborted.");
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function inventoryCount(bot: Bot, itemName: string): number {
  return bot.inventory.items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

function hasVisibleHostileNear(bot: Bot, position: { x: number; y: number; z: number }, radius: number): boolean {
  const playerEntityId = bot.entity.id;
  return Object.values(bot.entities).some((entity) => {
    if (entity.id === playerEntityId) return false;
    const name = entity.name ?? entity.displayName ?? entity.username ?? entity.type;
    const separation = Math.hypot(
      entity.position.x - position.x,
      entity.position.y - position.y,
      entity.position.z - position.z,
    );
    return isHostileMinecraftEntity(name, entity.type) && separation <= radius;
  });
}

const pathfinderErrorCodes: Readonly<Record<string, string>> = {
  NoPath: "PATH_NOT_FOUND",
  Timeout: "PATH_PLANNING_TIMEOUT",
  PathStopped: "PATH_STOPPED",
  GoalChanged: "PATH_GOAL_CHANGED",
};

/** Mineflayer pathfinder errors carry their class in `name`; expose them as stable action codes. */
function classifyMovementError(error: unknown): unknown {
  if (error instanceof MinecraftAdapterError) return error;
  if (error instanceof Error && Object.prototype.hasOwnProperty.call(pathfinderErrorCodes, error.name)) {
    return new MinecraftAdapterError(error.message, pathfinderErrorCodes[error.name] ?? "PATH_FAILED");
  }
  return error;
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return raceWithAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

/** Reads a dropped item's stack, or null when the entity is not an item or its metadata is unreadable. */
function readDroppedItem(entity: { getDroppedItem?: () => { name: string; count: number } | null }) {
  if (typeof entity.getDroppedItem !== "function") return null;
  try {
    return entity.getDroppedItem() ?? null;
  } catch {
    return null;
  }
}

function findDroppedItemNear(
  bot: Bot,
  point: { x: number; y: number; z: number },
  itemName: string,
  radius: number,
): { id: number } | null {
  for (const entity of Object.values(bot.entities)) {
    if (entity.id === bot.entity.id) continue;
    if (readDroppedItem(entity)?.name !== itemName) continue;
    if (distanceBetween(entity.position, point) <= radius) return { id: entity.id };
  }
  return null;
}

const minecraftPlaceableNames = [
  "dirt",
  "cobblestone",
  "granite",
  "andesite",
  "diorite",
  "cobbled_deepslate",
  "oak_planks",
  "birch_planks",
  "spruce_planks",
] as const;

function countHostilesNear(
  bot: Bot,
  point: { x: number; y: number; z: number },
  radius: number,
): number {
  let count = 0;
  for (const entity of Object.values(bot.entities)) {
    if (entity.id === bot.entity.id) continue;
    const name = String((entity as { name?: string }).name ?? entity.type ?? "");
    if (!isHostileMinecraftEntity(name, entity.type)) continue;
    if (entity.position.distanceTo(bot.entity.position.clone().set(point.x, point.y, point.z)) <= radius) count += 1;
  }
  return count;
}

function cardinalShelterCount(bot: Bot, feet: { x: number; y: number; z: number }): number {
  let solid = 0;
  for (const [dx, dz] of SHELTER_CARDINAL_DIRECTIONS) {
    const block = bot.blockAt(bot.entity.position.offset(dx, 0, dz).floor());
    if (block && block.boundingBox === "block") solid += 1;
  }
  return solid;
}

/** Mineflayer's 0..10 air gauge converted to Minecraft air ticks (300 = full lungs). */
function oxygenTicksFromLevel(level: number | null | undefined): number {
  if (typeof level !== "number" || !Number.isFinite(level)) return 300;
  return Math.max(0, Math.min(300, Math.round(level * 30)));
}

function clampFinite(value: number | undefined, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function safeInstallPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinderApi.pathfinder);
  bot.loadPlugin(toolApi.plugin);
  bot.loadPlugin(collectBlockPlugin);
}

function configureConservativeMovements(bot: Bot): void {
  if (!bot.pathfinder || !bot.collectBlock) {
    throw new MinecraftAdapterError(
      "Navigation and collection plugins were not installed on the Mineflayer bot.",
      "MINECRAFT_PLUGIN_UNAVAILABLE",
    );
  }
  const movements: PathfinderMovements = new pathfinderApi.Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.allowFreeMotion = false;
  movements.allowEntityDetection = true;
  movements.maxDropDown = 1;
  movements.infiniteLiquidDropdownDistance = false;
  (movements as PathfinderMovements & { liquidCost: number }).liquidCost = 100;
  movements.entityCost = 50;
  movements.scafoldingBlocks.length = 0;
  for (const name of [
    "creeper",
    "zombie",
    "skeleton",
    "spider",
    "witch",
    "enderman",
    "husk",
    "stray",
    "drowned",
    "pillager",
    "vindicator",
    "ravager",
    "phantom",
    "slime",
    "magma_cube",
    "blaze",
    "ghast",
    "hoglin",
    "piglin_brute",
    "warden",
  ]) {
    movements.entitiesToAvoid.add(name);
  }
  for (const name of ["lava", "fire", "soul_fire", "magma_block", "cactus", "sweet_berry_bush"] as const) {
    const block = bot.registry.blocksByName[name];
    if (block) movements.blocksToAvoid.add(block.id);
  }
  (bot.pathfinder as typeof bot.pathfinder & { searchRadius: number }).searchRadius = 64;
  bot.pathfinder.thinkTimeout = 5_000;
  bot.pathfinder.setMovements(movements);
  bot.collectBlock.movements = movements;
}

export class MinecraftAdapter implements GameAdapter<MinecraftObservation> {
  readonly gameId = "minecraft-java";
  readonly capabilities: readonly CapabilityDefinition[] = minecraftCapabilities;

  private statusValue: AdapterStatus = "disconnected";
  private sessionValue: GameSession | null = null;
  private pendingSessionId: string | null = null;
  private bot: Bot | null = null;
  private sequence = 0;
  private activeActionId: string | null = null;
  private activeCapability: string | null = null;
  private readonly statusListeners = new Set<(change: AdapterStatusChange) => void>();
  private readonly botFactory: MinecraftBotFactory;
  private readonly installPlugins: (bot: Bot) => void;
  private readonly configureSafeMovements: (bot: Bot) => void;

  /**
   * Combat is switched through this field rather than the config object, so an operator can arm or
   * disarm it while the agent is connected. Both gates have to be open: this one and the safety
   * policy's capability opt-in. The default always comes from the immutable startup configuration.
   */
  private combatAllowedValue = false;

  constructor(
    private readonly logger: Logger,
    private readonly config: MinecraftAdapterConfig = DEFAULT_MINECRAFT_CONFIG,
    dependencies: MinecraftAdapterDependencies = {},
  ) {
    this.combatAllowedValue = config.allowCombat;
    this.botFactory = dependencies.botFactory ?? createBot;
    this.installPlugins = dependencies.installPlugins ?? safeInstallPlugins;
    this.configureSafeMovements = dependencies.configureSafeMovements ?? configureConservativeMovements;

    if (!config.host.trim()) throw new Error("Minecraft host must not be empty.");
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
      throw new Error("Minecraft port must be an integer from 1 through 65535.");
    }
    if (!config.username.trim()) throw new Error("Minecraft username must not be empty.");
    if (!config.version.trim()) throw new Error("Minecraft version must not be empty.");
    if (!Number.isInteger(config.connectTimeoutMs) || config.connectTimeoutMs <= 0) {
      throw new Error("Minecraft connection timeout must be a positive integer.");
    }
    if (!Number.isInteger(config.shutdownTimeoutMs) || config.shutdownTimeoutMs <= 0) {
      throw new Error("Minecraft shutdown timeout must be a positive integer.");
    }
    if (!Number.isFinite(config.entityRadius) || config.entityRadius <= 0) {
      throw new Error("Minecraft entity observation radius must be positive.");
    }
    if (!Number.isInteger(config.observationRadius) || config.observationRadius < 1) {
      throw new Error("Minecraft observation radius must be a positive integer.");
    }
    if (!Number.isInteger(config.maxObservedBlocks) || config.maxObservedBlocks < 1) {
      throw new Error("Maximum observed block count must be a positive integer.");
    }
    if (!Number.isFinite(config.maxNavigationDistance) || config.maxNavigationDistance < 1) {
      throw new Error("Maximum navigation distance must be at least one block.");
    }
    if (!Number.isFinite(config.maxResourceGatherDistance) || config.maxResourceGatherDistance < 1) {
      throw new Error("Maximum resource-gather distance must be at least one block.");
    }
    if (!Number.isFinite(config.maxCraftingTableDistance) || config.maxCraftingTableDistance < 1) {
      throw new Error("Maximum crafting-table distance must be at least one block.");
    }
    if (!Number.isInteger(config.navigationStuckTimeoutMs) || config.navigationStuckTimeoutMs < 1_000) {
      throw new Error("Navigation stuck timeout must be an integer of at least 1000 ms.");
    }
    if (!Number.isFinite(config.resourceScanRadius) || config.resourceScanRadius < config.observationRadius) {
      throw new Error("Resource scan radius must be finite and at least the local observation radius.");
    }
    if (!Number.isFinite(config.maxPlacementDistance) || config.maxPlacementDistance < 1) {
      throw new Error("Maximum placement distance must be at least one block.");
    }
    if (!Number.isInteger(config.dropSettleMs) || config.dropSettleMs < 0 || config.dropSettleMs > 30_000) {
      throw new Error("Drop settle window must be an integer between 0 and 30000 ms.");
    }
    if (typeof config.allowCombat !== "boolean") {
      throw new Error("allowCombat must be a boolean.");
    }
    if (!Number.isInteger(config.resourceScanLimit) || config.resourceScanLimit < 1 || config.resourceScanLimit > 256) {
      throw new Error("Resource scan limit must be an integer from 1 through 256.");
    }
  }

  get status(): AdapterStatus {
    return this.statusValue;
  }

  get session(): GameSession | null {
    return this.statusValue === "connected" ? this.sessionValue : null;
  }

  onStatusChange(listener: (change: AdapterStatusChange) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async connect(): Promise<GameSession> {
    if (this.statusValue === "connecting" || this.statusValue === "connected") {
      if (this.sessionValue && this.statusValue === "connected") return this.sessionValue;
      throw new Error(`Cannot connect while adapter is ${this.statusValue}.`);
    }
    if (this.statusValue === "stopping") {
      throw new Error("Cannot connect while the previous Minecraft session is stopping.");
    }
    if (this.bot) await this.disconnect("closing stale Minecraft connection before reconnect");

    const sessionId = randomUUID();
    this.sequence = 0;
    this.pendingSessionId = sessionId;
    this.transition("connecting", null);

    let bot: Bot;
    try {
      bot = this.botFactory({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        auth: this.config.auth,
        version: this.config.version,
        viewDistance: this.config.viewDistance,
        hideErrors: true,
        logErrors: false,
      });
      this.bot = bot;
      this.installPlugins(bot);
    } catch (error) {
      const failedBot = this.bot;
      this.bot = null;
      this.pendingSessionId = null;
      this.sessionValue = null;
      this.transition("failed", errorMessage(error), sessionId);
      if (failedBot) void this.quitAfterConnectFailure(failedBot, errorMessage(error));
      throw error;
    }

    return new Promise<GameSession>((resolve, reject) => {
      let settled = false;
      const finishFailure = (error: Error, status: "failed" | "disconnected" = "failed") => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.pendingSessionId = null;
        this.sessionValue = null;
        this.transition(status, error.message, sessionId);
        reject(error);
      };

      const onSpawn = (): void => {
        if (settled || this.bot !== bot) return;
        try {
          this.configureSafeMovements(bot);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          finishFailure(failure);
          void this.quitAfterConnectFailure(bot, failure.message);
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        const session: GameSession = {
          id: sessionId,
          gameId: this.gameId,
          gameVersion: bot.version || this.config.version,
          connectedAt: new Date().toISOString(),
        };
        this.sessionValue = session;
        this.pendingSessionId = null;
        this.transition("connected", null);
        resolve(session);
      };

      const onError = (error: Error): void => {
        this.logger.error({ err: error, sessionId }, "Minecraft client emitted an error");
        if (!settled) {
          finishFailure(error);
          void this.quitAfterConnectFailure(bot, error.message);
        } else if (this.statusValue === "connected") {
          this.sessionValue = null;
          this.transition("failed", error.message, sessionId);
          void this.quitAfterConnectFailure(bot, error.message);
        }
      };

      const onKicked = (reason: string): void => {
        const message = `Minecraft server kicked the bot: ${reason}`;
        if (!settled) finishFailure(new Error(message), "disconnected");
        else {
          this.pendingSessionId = null;
          this.sessionValue = null;
          this.transition("disconnected", message, sessionId);
        }
      };

      const onEnd = (reason: string): void => {
        const message = reason || "Minecraft client connection ended.";
        if (!settled) finishFailure(new Error(message), "disconnected");
        this.pendingSessionId = null;
        this.sessionValue = null;
        if (this.bot === bot) this.bot = null;
        this.transition("disconnected", message, sessionId);
      };

      bot.on("spawn", onSpawn);
      bot.on("error", onError);
      bot.on("kicked", onKicked);
      bot.on("end", onEnd);

      const connectTimer = setTimeout(() => {
        const error = new Error(
          `Timed out after ${this.config.connectTimeoutMs} ms waiting for Minecraft spawn.`,
        );
        finishFailure(error);
        void this.quitAfterConnectFailure(bot, error.message);
      }, this.config.connectTimeoutMs);
    });
  }

  async observe(): Promise<GameObservation<MinecraftObservation>> {
    const bot = this.requireConnectedBot();
    const session = this.sessionValue;
    if (!session) throw new MinecraftAdapterError("No active session.", "NO_ACTIVE_SESSION");

    const position = bot.entity.position;
    const center = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    const radius = this.config.observationRadius;
    const verticalRadius = 2;
    const cube: MinecraftObservation["nearbyBlocks"][number][] = [];
    let sampledCells = 0;
    let unknownCells = 0;

    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dy = -verticalRadius; dy <= verticalRadius; dy += 1) {
          sampledCells += 1;
          const block = bot.blockAt(position.offset(dx, dy, dz));
          if (!block) {
            unknownCells += 1;
            continue;
          }
          if (block.name.endsWith("_air") || block.name === "air") continue;
          cube.push({
            position: {
              x: Math.floor(block.position.x),
              y: Math.floor(block.position.y),
              z: Math.floor(block.position.z),
            },
            name: block.name,
            type: block.type,
            boundingBox: block.boundingBox,
          });
        }
      }
    }
    // Keep the cap predictable: resource and table blocks first, then the nearest blocks. A plain
    // iteration-order cut used to drop resource blocks on one side of the cube silently.
    const cubeTruncated = cube.length > this.config.maxObservedBlocks;
    const nearbyBlocks = cube
      .map((block) => ({ block, distance: distanceBetween(block.position, center) }))
      .sort((left, right) => {
        const interest = blockObservationPriority(right.block.name) - blockObservationPriority(left.block.name);
        return interest || left.distance - right.distance;
      })
      .slice(0, this.config.maxObservedBlocks)
      .map(({ block }) => block);

    const resourceSightings = this.scanResourceSightings(bot, position);
    const minableSightings = this.scanMineableSightings(bot, position);
    const itemDrops = this.scanItemDrops(bot, position);

    const playerEntityId = bot.entity.id;
    const entities = Object.values(bot.entities)
      .filter((entity) => entity.id !== playerEntityId)
      .map((entity) => ({ entity, distance: entity.position.distanceTo(position) }))
      .filter(({ distance }) => Number.isFinite(distance) && distance <= this.config.entityRadius)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 64)
      .map(({ entity, distance }) => ({
        id: String(entity.id),
        name: entity.name ?? entity.displayName ?? entity.username ?? entity.type,
        type: entity.type,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        distance,
        health: finiteOrNull(entity.health),
      }));

    const equipmentSlot = (destination: EquipmentDestination) => {
      const slot = bot.getEquipmentDestSlot(destination);
      return bot.inventory.slots[slot] ?? null;
    };
    const state = minecraftObservationSchema.parse({
      player: {
        username: bot.username,
        position: { x: position.x, y: position.y, z: position.z },
        orientation: { yaw: bot.entity.yaw, pitch: bot.entity.pitch },
        dimension: bot.game.dimension,
        gameMode: bot.game.gameMode,
        health: finiteOrNull(bot.health),
        food: finiteOrNull(bot.food),
        foodSaturation: finiteOrNull(bot.foodSaturation),
        // Mineflayer reports 0..10; the observation contract speaks air ticks like the game logic does.
        oxygenLevel: oxygenTicksFromLevel(bot.oxygenLevel),
        onGround: bot.entity.onGround,
        // `items()` covers the 27 main-inventory slots; a full one cannot accept a new stack name.
        inventoryFull: bot.inventory.items().length >= 27,
      },
      inventory: bot.inventory.items().map((item) => ({
        slot: item.slot,
        name: item.name,
        type: item.type,
        count: item.count,
        metadata: Number.isInteger(item.metadata) ? item.metadata : null,
        durabilityUsed: finiteOrNull(item.durabilityUsed),
      })),
      equipment: {
        hand: this.serializeItem(equipmentSlot("hand")),
        "offhand": this.serializeItem(equipmentSlot("off-hand")),
        head: this.serializeItem(equipmentSlot("head")),
        torso: this.serializeItem(equipmentSlot("torso")),
        legs: this.serializeItem(equipmentSlot("legs")),
        feet: this.serializeItem(equipmentSlot("feet")),
      },
      entities,
      nearbyBlocks,
      resourceSightings: resourceSightings.blocks,
      resourceScan: {
        radius: this.config.resourceScanRadius,
        limit: this.config.resourceScanLimit,
        center,
        truncated: resourceSightings.truncated,
      },
      itemDrops,
      sampledRegion: {
        radius,
        verticalRadius,
        center,
        sampledCells,
        unknownCells,
        truncated: cubeTruncated,
      },
      time: minecraftTimeInfo(bot),
      minableSightings: minableSightings.blocks,
      minableScan: {
        radius: this.config.resourceScanRadius,
        limit: this.config.resourceScanLimit,
        center,
        truncated: minableSightings.truncated,
      },
    });

    return {
      schemaVersion: 1,
      gameId: this.gameId,
      gameVersion: session.gameVersion,
      sessionId: session.id,
      sequence: this.sequence++,
      observedAt: new Date().toISOString(),
      state,
    };
  }

  /** Wide, bounded search for resource-class blocks using Mineflayer's loaded-chunk index. */
  private scanResourceSightings(
    bot: Bot,
    position: BotPosition,
  ): { blocks: MinecraftObservation["resourceSightings"]; truncated: boolean } {
    return this.scanBlocks(bot, position, isResourceBlockName, true);
  }

  /** Second scan for mineable stone and ore blocks, so digging targets survive a full resource list. */
  private scanMineableSightings(
    bot: Bot,
    position: BotPosition,
  ): { blocks: MinecraftObservation["minableSightings"]; truncated: boolean } {
    return this.scanBlocks(bot, position, isMineableBlockName, false);
  }

  private scanBlocks(
    bot: Bot,
    position: BotPosition,
    matches: (name: string) => boolean,
    withProperties: boolean,
  ): { blocks: NonNullable<MinecraftObservation["minableSightings"]>; truncated: boolean } {
    if (typeof bot.findBlocks !== "function") return { blocks: [], truncated: false };
    const limit = this.config.resourceScanLimit;
    const found = bot.findBlocks({
      point: position,
      matching: (block: { name: string }) => matches(block.name),
      maxDistance: this.config.resourceScanRadius,
      count: limit,
    });
    const blocks: MinecraftObservation["resourceSightings"] = [];
    for (const blockPosition of found) {
      const block = bot.blockAt(blockPosition);
      if (!block || !isResourceBlockName(block.name)) continue;
      const sighting: MinecraftObservation["resourceSightings"][number] = {
        name: block.name,
        position: {
          x: Math.floor(block.position.x),
          y: Math.floor(block.position.y),
          z: Math.floor(block.position.z),
        },
        distance: block.position.distanceTo(position),
      };
      if (withProperties) {
        const properties = blockProperties(block);
        if (block.name === "sweet_berry_bush" && properties.age !== undefined) {
          sighting.properties = { age: properties.age };
        }
      }
      blocks.push(sighting);
    }
    return { blocks, truncated: found.length >= limit };
  }

  /** Dropped items are read from the entity metadata; nothing is inferred from names alone. */
  private scanItemDrops(
    bot: Bot,
    position: BotPosition,
  ): MinecraftObservation["itemDrops"] {
    const drops: MinecraftObservation["itemDrops"] = [];
    for (const entity of Object.values(bot.entities)) {
      if (entity.id === bot.entity.id) continue;
      const distance = entity.position.distanceTo(position);
      if (!Number.isFinite(distance) || distance > this.config.entityRadius) continue;
      const item = readDroppedItem(entity);
      if (!item || !Number.isInteger(item.count) || item.count < 1) continue;
      drops.push({
        id: String(entity.id),
        name: item.name,
        count: item.count,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        distance,
      });
    }
    return drops.sort((left, right) => left.distance - right.distance).slice(0, 32);
  }

  async executeAction(
    action: AdapterAction,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const bot = this.requireConnectedBot();
    if (!this.sessionValue || this.sessionValue.id !== action.sessionId) {
      throw new MinecraftAdapterError("Action belongs to an expired session.", "STALE_SESSION");
    }
    if (this.activeActionId && this.activeActionId !== action.actionId) {
      throw new MinecraftAdapterError("Minecraft adapter already has an active action.", "ACTION_BUSY");
    }

    this.activeActionId = action.actionId;
    this.activeCapability = action.capability;
    try {
      if (signal.aborted) throw abortError(signal);
      switch (action.capability) {
        case MINECRAFT_LOOK_CAPABILITY:
          return await this.executeLook(bot, action.input, signal);
        case MINECRAFT_INSPECT_BLOCK_CAPABILITY:
          return this.executeInspectBlock(bot, action.input);
        case MINECRAFT_NAVIGATE_CAPABILITY:
          return await this.executeNavigate(bot, action.input, signal);
        case MINECRAFT_COLLECT_BLOCK_CAPABILITY:
          return await this.executeCollectBlock(bot, action.input, signal);
        case MINECRAFT_EQUIP_CAPABILITY:
          return await this.executeEquip(bot, action.input, signal);
        case MINECRAFT_CRAFT_CAPABILITY:
          return await this.executeCraftItem(bot, action.input, signal);
        case MINECRAFT_EAT_CAPABILITY:
          return await this.executeEatFood(bot, action.input, signal);
        case MINECRAFT_PLACE_TABLE_CAPABILITY:
          return await this.executePlaceCraftingTable(bot, action.input, signal);
        case MINECRAFT_PICKUP_ITEM_CAPABILITY:
          return await this.executePickupItem(bot, action.input, signal);
        case MINECRAFT_HARVEST_BERRIES_CAPABILITY:
          return await this.executeHarvestBerries(bot, action.input, signal);
        case MINECRAFT_REST_CAPABILITY:
          return await this.executeRest(bot, action.input, signal);
        case MINECRAFT_MINE_BLOCK_CAPABILITY:
          return await this.executeMineBlock(bot, action.input, signal);
        case MINECRAFT_PLACE_BLOCK_CAPABILITY:
          return await this.executePlaceBlock(bot, action.input, signal);
        case MINECRAFT_BUILD_SHELTER_CAPABILITY:
          return await this.executeBuildShelter(bot, action.input, signal);
        case MINECRAFT_ATTACK_HOSTILE_CAPABILITY:
          return await this.executeAttackHostile(bot, action.input, signal);
        case MINECRAFT_DROP_ITEM_CAPABILITY:
          return await this.executeDropItem(bot, action.input, signal);
        default:
          throw new MinecraftAdapterError(
            `Unsupported Minecraft capability '${action.capability}'.`,
            "UNSUPPORTED_CAPABILITY",
          );
      }
    } catch (error) {
      if (signal.aborted) {
        await this.cancelCurrentAction(bot, action.capability);
        throw abortError(signal);
      }
      throw error;
    } finally {
      if (this.activeActionId === action.actionId) {
        this.activeActionId = null;
        this.activeCapability = null;
      }
    }
  }

  async cancelActiveAction(actionId: string, _reason: string): Promise<void> {
    if (this.activeActionId !== actionId || !this.bot || !this.activeCapability) return;
    await this.cancelCurrentAction(this.bot, this.activeCapability);
  }

  async disconnect(reason = "GameMind shutdown"): Promise<void> {
    const bot = this.bot;
    const disconnectSessionId = this.sessionValue?.id ?? this.pendingSessionId;
    if (!bot) {
      this.sessionValue = null;
      this.pendingSessionId = null;
      if (this.statusValue !== "disconnected") {
        this.transition("disconnected", reason, disconnectSessionId);
      }
      return;
    }

    if (this.statusValue !== "stopping") this.transition("stopping", reason);
    this.sessionValue = null;
    this.pendingSessionId = null;

    const ended = new Promise<void>((resolve) => {
      if (this.bot !== bot) {
        resolve();
        return;
      }
      bot.once("end", () => resolve());
    });
    try {
      bot.quit(reason);
    } catch (error) {
      this.logger.warn({ err: error, reason }, "Minecraft graceful quit failed; forcing socket close");
    }

    let shutdownTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      ended,
      new Promise<void>((resolve) => {
        shutdownTimer = setTimeout(resolve, this.config.shutdownTimeoutMs);
      }),
    ]);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    if (this.bot === bot) {
      try {
        bot.end(reason);
      } catch (error) {
        this.logger.warn({ err: error, reason }, "Minecraft forced socket close failed");
      }
      this.bot = null;
      this.transition("disconnected", reason, disconnectSessionId);
    }
  }

  private async executeLook(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftLookInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid look parameters.", "INVALID_ACTION_INPUT");
    const { yaw, pitch } = parsed.data;
    await raceWithAbort(bot.look(yaw, pitch, false), signal);
    const actualYaw = bot.entity.yaw;
    const actualPitch = bot.entity.pitch;
    const confirmed = angleDifference(actualYaw, yaw) <= 0.02 && Math.abs(actualPitch - pitch) <= 0.02;
    return {
      confirmed,
      confirmation: "mineflayer_client_rotation_matches_request",
      details: {
        requestedYaw: yaw,
        requestedPitch: pitch,
        observedYaw: actualYaw,
        observedPitch: actualPitch,
        evidence:
          "Mineflayer look operation completed and local client rotation matched; vanilla has no separate rotation acknowledgement packet.",
      },
    };
  }

  private executeInspectBlock(bot: Bot, input: unknown): AdapterActionOutcome {
    const parsed = minecraftInspectBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid block coordinates.", "INVALID_ACTION_INPUT");
    const block = this.blockAtCoordinates(bot, parsed.data.x, parsed.data.y, parsed.data.z);
    if (!block) {
      throw new MinecraftAdapterError("Block is not loaded/observed by the client.", "BLOCK_UNKNOWN");
    }
    const distance = block.position.distanceTo(bot.entity.position);
    if (distance > this.config.observationRadius + 2) {
      throw new MinecraftAdapterError("Block is outside the local inspection radius.", "BLOCK_OUT_OF_RANGE");
    }
    return {
      confirmed: true,
      confirmation: "local_block_state_read",
      details: {
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        name: block.name,
        type: block.type,
        boundingBox: block.boundingBox,
        hardness: finiteOrNull(block.hardness),
        canDig: bot.canDigBlock(block),
      },
    };
  }

  private async executeNavigate(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftNavigateInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid navigation target.", "INVALID_ACTION_INPUT");
    if (!bot.pathfinder) {
      throw new MinecraftAdapterError("Pathfinder plugin is unavailable.", "PATHFINDER_UNAVAILABLE");
    }
    const { x, y, z, range } = parsed.data;
    const from = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    const targetDistance = Math.hypot(from.x - x, from.y - y, from.z - z);
    if (targetDistance > this.config.maxNavigationDistance) {
      throw new MinecraftAdapterError(
        `Navigation target is ${targetDistance.toFixed(1)} blocks away; limit is ${this.config.maxNavigationDistance}.`,
        "NAVIGATION_TARGET_TOO_FAR",
      );
    }
    await this.navigateWithProgressWatchdog(
      bot,
      new pathfinderApi.goals.GoalNear(x, y, z, range),
      signal,
    );
    const to = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    const horizontalDistance = Math.hypot(to.x - (x + 0.5), to.z - (z + 0.5));
    const verticalDistance = Math.abs(to.y - y);
    const confirmed = horizontalDistance <= range + 1.25 && verticalDistance <= 2;
    return {
      confirmed,
      confirmation: "pathfinder_goal_reached_and_position_checked",
      details: {
        from,
        to,
        target: { x, y, z },
        range,
        horizontalDistance,
        verticalDistance,
        conservativeMovements: true,
      },
    };
  }

  private async navigateWithProgressWatchdog(
    bot: Bot,
    goal: InstanceType<typeof pathfinderApi.goals.GoalNear>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!bot.pathfinder) {
      throw new MinecraftAdapterError("Pathfinder plugin is unavailable.", "PATHFINDER_UNAVAILABLE");
    }
    await this.watchMovementProgress(
      bot,
      bot.pathfinder.goto(goal),
      signal,
      MINECRAFT_NAVIGATE_CAPABILITY,
    );
  }

  private async watchMovementProgress<T>(
    bot: Bot,
    operation: Promise<T>,
    signal: AbortSignal,
    capability: string,
  ): Promise<T> {
    let lastProgressAt = Date.now();
    let lastPosition = bot.entity.position.clone();
    let stuckTimer: NodeJS.Timeout | undefined;
    let stuckTriggered = false;
    const stuck = new Promise<never>((_resolve, reject) => {
      stuckTimer = setInterval(() => {
        const position = bot.entity.position;
        if (position.distanceTo(lastPosition) >= 0.2) {
          lastPosition = position.clone();
          lastProgressAt = Date.now();
          return;
        }
        if (!stuckTriggered && Date.now() - lastProgressAt >= this.config.navigationStuckTimeoutMs) {
          stuckTriggered = true;
          reject(
            new MinecraftAdapterError(
              `Player made no movement progress for ${this.config.navigationStuckTimeoutMs} ms during '${capability}'.`,
              "NAVIGATION_STUCK",
            ),
          );
        }
      }, Math.min(500, Math.max(100, this.config.navigationStuckTimeoutMs / 10)));
    });
    try {
      return await raceWithAbort(Promise.race([operation, stuck]), signal);
    } catch (error) {
      if (error instanceof MinecraftAdapterError && error.code === "NAVIGATION_STUCK") {
        await this.cancelCurrentAction(bot, capability);
      }
      if (signal.aborted) throw error;
      throw classifyMovementError(error);
    } finally {
      if (stuckTimer) clearInterval(stuckTimer);
    }
  }

  private async executeCollectBlock(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftCollectBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid collection target.", "INVALID_ACTION_INPUT");
    if (bot.game.dimension !== "overworld") {
      throw new MinecraftAdapterError("This initial collection skill only supports overworld logs.", "UNSUPPORTED_DIMENSION");
    }
    if (!bot.collectBlock) {
      throw new MinecraftAdapterError("Collect-block plugin is unavailable.", "COLLECTOR_UNAVAILABLE");
    }
    const block = this.blockAtCoordinates(bot, parsed.data.x, parsed.data.y, parsed.data.z);
    if (!block || block.name !== parsed.data.blockName) {
      throw new MinecraftAdapterError(
        `Expected ${parsed.data.blockName} at the requested position, but the block is unknown or different.`,
        "RESOURCE_TARGET_CHANGED",
      );
    }
    const distance = block.position.distanceTo(bot.entity.position);
    if (distance > this.config.maxResourceGatherDistance) {
      throw new MinecraftAdapterError(
        `Resource is ${distance.toFixed(1)} blocks away; limit is ${this.config.maxResourceGatherDistance}.`,
        "RESOURCE_TARGET_TOO_FAR",
      );
    }
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError(
        `Log collection requires survival mode; current mode is '${bot.game.gameMode}'.`,
        "GAME_MODE_BLOCKS_COLLECTION",
      );
    }
    if (!bot.canDigBlock(block)) {
      throw new MinecraftAdapterError("Minecraft client reports that this block cannot be harvested.", "BLOCK_NOT_HARVESTABLE");
    }
    if (hasVisibleHostileNear(bot, block.position.offset(0.5, 0.5, 0.5), parsed.data.dangerRadius)) {
      throw new MinecraftAdapterError(
        `A currently visible hostile is within ${parsed.data.dangerRadius} blocks of the resource target.`,
        "RESOURCE_TARGET_THREATENED",
      );
    }

    const itemName = parsed.data.blockName;
    const inventoryBefore = inventoryCount(bot, itemName);
    await this.watchMovementProgress(
      bot,
      bot.collectBlock.collect(block, { ignoreNoPath: false }),
      signal,
      MINECRAFT_COLLECT_BLOCK_CAPABILITY,
    );
    const inventoryAfter = inventoryCount(bot, itemName);
    const remainingBlock = this.blockAtCoordinates(bot, parsed.data.x, parsed.data.y, parsed.data.z);
    const blockRemoved = !remainingBlock || remainingBlock.name !== itemName;
    const confirmed = inventoryAfter > inventoryBefore;
    return {
      confirmed,
      confirmation: "collectblock_completed_and_inventory_delta_checked",
      details: {
        itemName,
        coordinates: { x: parsed.data.x, y: parsed.data.y, z: parsed.data.z },
        inventoryBefore,
        inventoryAfter,
        blockRemoved,
      },
    };
  }

  private async executeEquip(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftEquipInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid equipment request.", "INVALID_ACTION_INPUT");
    const item = bot.inventory.items().find((candidate) => candidate.name === parsed.data.item);
    if (!item) {
      throw new MinecraftAdapterError(`Inventory does not contain '${parsed.data.item}'.`, "ITEM_NOT_IN_INVENTORY");
    }
    const destination = parsed.data.destination as EquipmentDestination;
    await raceWithAbort(bot.equip(item, destination), signal);
    const slot = bot.getEquipmentDestSlot(destination);
    const equipped = bot.inventory.slots[slot] ?? null;
    const confirmed = equipped?.name === parsed.data.item;
    return {
      confirmed,
      confirmation: "equipment_slot_matches_requested_item",
      details: {
        item: parsed.data.item,
        destination,
        slot,
        observedItem: equipped?.name ?? null,
      },
    };
  }

  private async executeCraftItem(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftCraftItemInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid craft request.", "INVALID_ACTION_INPUT");
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError("Crafting task actions require survival mode.", "GAME_MODE_BLOCKS_CRAFTING");
    }
    const before = inventoryCount(bot, parsed.data.item);
    if (before >= parsed.data.count) {
      return {
        confirmed: true,
        confirmation: "requested_item_count_already_in_inventory",
        details: { item: parsed.data.item, requestedCount: parsed.data.count, inventoryBefore: before, inventoryAfter: before },
      };
    }
    const itemData = bot.registry.itemsByName[parsed.data.item];
    if (!itemData) {
      throw new MinecraftAdapterError(`Minecraft registry has no item '${parsed.data.item}'.`, "CRAFT_ITEM_UNAVAILABLE");
    }

    let craftingTable = null;
    if (parsed.data.craftingTable) {
      craftingTable = this.blockAtCoordinates(
        bot,
        parsed.data.craftingTable.x,
        parsed.data.craftingTable.y,
        parsed.data.craftingTable.z,
      );
      if (!craftingTable || craftingTable.name !== "crafting_table") {
        throw new MinecraftAdapterError("The observed crafting table is no longer present.", "CRAFTING_TABLE_CHANGED");
      }
      const distance = craftingTable.position.distanceTo(bot.entity.position);
      if (distance > this.config.maxCraftingTableDistance) {
        throw new MinecraftAdapterError(
          `Crafting table is ${distance.toFixed(1)} blocks away; limit is ${this.config.maxCraftingTableDistance}.`,
          "CRAFTING_TABLE_TOO_FAR",
        );
      }
      if (!bot.canSeeBlock(craftingTable)) {
        throw new MinecraftAdapterError("Crafting table is occluded from the client.", "CRAFTING_TABLE_NOT_VISIBLE");
      }
    }

    const deficit = parsed.data.count - before;
    const recipes = bot.recipesFor(itemData.id, null, deficit, craftingTable);
    const recipe = recipes.find((candidate) => !candidate.requiresTable || craftingTable !== null);
    if (!recipe) {
      throw new MinecraftAdapterError(
        `No recipe for '${parsed.data.item}' is currently craftable with the available inventory${craftingTable ? " and crafting table" : ""}.`,
        "CRAFTING_PREREQUISITES_UNAVAILABLE",
      );
    }
    const craftRuns = Math.max(1, Math.ceil(deficit / Math.max(1, recipe.result.count)));
    await raceWithAbort(bot.craft(recipe, craftRuns, craftingTable ?? undefined), signal);
    const after = inventoryCount(bot, parsed.data.item);
    return {
      confirmed: after >= parsed.data.count,
      confirmation: "mineflayer_craft_completed_and_inventory_delta_checked",
      details: {
        item: parsed.data.item,
        requestedCount: parsed.data.count,
        inventoryBefore: before,
        inventoryAfter: after,
        craftedCount: Math.max(0, after - before),
        craftRuns,
        usedCraftingTable: Boolean(craftingTable),
        craftingTablePosition: parsed.data.craftingTable ?? null,
      },
    };
  }

  private async executeEatFood(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftEatFoodInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid food request.", "INVALID_ACTION_INPUT");
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError("Eating task actions require survival mode.", "GAME_MODE_BLOCKS_EATING");
    }
    const hungerBefore = finiteOrNull(bot.food);
    if (hungerBefore === null || hungerBefore >= 20) {
      throw new MinecraftAdapterError("Player hunger is full or unavailable; eating is not needed.", "FOOD_NOT_NEEDED");
    }
    const item = bot.inventory.items().find((candidate) => candidate.name === parsed.data.item);
    if (!item) {
      throw new MinecraftAdapterError(`Inventory does not contain '${parsed.data.item}'.`, "FOOD_NOT_IN_INVENTORY");
    }
    const countBefore = inventoryCount(bot, parsed.data.item);
    await raceWithAbort(bot.equip(item, "hand"), signal);
    await raceWithAbort(bot.consume(), signal);
    const hungerAfter = finiteOrNull(bot.food);
    const countAfter = inventoryCount(bot, parsed.data.item);
    const confirmed = hungerAfter !== null && hungerAfter > hungerBefore && countAfter < countBefore;
    return {
      confirmed,
      confirmation: "consumption_completed_and_hunger_plus_inventory_checked",
      details: {
        item: parsed.data.item,
        hungerBefore,
        hungerAfter,
        foodCountBefore: countBefore,
        foodCountAfter: countAfter,
        evidence:
          "Mineflayer consume promise completed; confirmation requires both a server-observed hunger increase and a decrease in the selected inventory stack.",
      },
    };
  }

  private async executePickupItem(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftPickupItemInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid pickup request.", "INVALID_ACTION_INPUT");
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError(
        `Item pickup requires survival mode; current mode is '${bot.game.gameMode}'.`,
        "GAME_MODE_BLOCKS_PICKUP",
      );
    }
    if (!bot.pathfinder) {
      throw new MinecraftAdapterError("Pathfinder plugin is unavailable.", "PATHFINDER_UNAVAILABLE");
    }
    const { x, y, z, itemName, dangerRadius } = parsed.data;
    const point = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    if (!findDroppedItemNear(bot, point, itemName, 1.5)) {
      throw new MinecraftAdapterError(
        `No dropped '${itemName}' is observed at the requested position.`,
        "ITEM_DROP_NOT_FOUND",
      );
    }
    const distance = distanceBetween(bot.entity.position, point);
    if (distance > this.config.maxResourceGatherDistance) {
      throw new MinecraftAdapterError(
        `Dropped item is ${distance.toFixed(1)} blocks away; limit is ${this.config.maxResourceGatherDistance}.`,
        "PICKUP_TARGET_TOO_FAR",
      );
    }
    if (hasVisibleHostileNear(bot, point, dangerRadius)) {
      throw new MinecraftAdapterError(
        `A currently visible hostile is within ${dangerRadius} blocks of the dropped item.`,
        "PICKUP_TARGET_THREATENED",
      );
    }

    const before = inventoryCount(bot, itemName);
    await this.watchMovementProgress(
      bot,
      bot.pathfinder.goto(new pathfinderApi.goals.GoalBlock(x, y, z)),
      signal,
      MINECRAFT_PICKUP_ITEM_CAPABILITY,
    );
    const after = await this.waitForInventoryGain(bot, itemName, before, 1_500, signal);
    return {
      confirmed: after > before,
      confirmation: "dropped_item_entered_inventory_delta_checked",
      details: {
        itemName,
        coordinates: { x, y, z },
        inventoryBefore: before,
        inventoryAfter: after,
        evidence:
          "Vanilla picks up dropped items on contact; confirmation requires an inventory increase of the requested item.",
      },
    };
  }

  private async executeHarvestBerries(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftHarvestBerriesInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid berry harvest request.", "INVALID_ACTION_INPUT");
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError(
        `Berry harvesting requires survival mode; current mode is '${bot.game.gameMode}'.`,
        "GAME_MODE_BLOCKS_HARVEST",
      );
    }
    if (!bot.pathfinder) {
      throw new MinecraftAdapterError("Pathfinder plugin is unavailable.", "PATHFINDER_UNAVAILABLE");
    }
    const { x, y, z, dangerRadius } = parsed.data;
    const block = this.blockAtCoordinates(bot, x, y, z);
    if (!block || block.name !== "sweet_berry_bush") {
      throw new MinecraftAdapterError(
        "Expected a sweet berry bush at the requested position, but the block is unknown or different.",
        "RESOURCE_TARGET_CHANGED",
      );
    }
    const properties = blockProperties(block);
    if (!isRipeBerryBush(block.name, properties)) {
      throw new MinecraftAdapterError("The sweet berry bush is not ripe yet.", "BERRY_NOT_RIPE");
    }
    const center = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    const distance = distanceBetween(bot.entity.position, center);
    if (distance > this.config.maxResourceGatherDistance) {
      throw new MinecraftAdapterError(
        `Berry bush is ${distance.toFixed(1)} blocks away; limit is ${this.config.maxResourceGatherDistance}.`,
        "RESOURCE_TARGET_TOO_FAR",
      );
    }
    if (hasVisibleHostileNear(bot, center, dangerRadius)) {
      throw new MinecraftAdapterError(
        `A currently visible hostile is within ${dangerRadius} blocks of the berry bush.`,
        "RESOURCE_TARGET_THREATENED",
      );
    }

    const before = inventoryCount(bot, "sweet_berries");
    if (distance > 3) {
      await this.watchMovementProgress(
        bot,
        bot.pathfinder.goto(new pathfinderApi.goals.GoalNear(x, y, z, 2)),
        signal,
        MINECRAFT_HARVEST_BERRIES_CAPABILITY,
      );
    }
    const refreshed = this.blockAtCoordinates(bot, x, y, z);
    if (!refreshed || refreshed.name !== "sweet_berry_bush") {
      throw new MinecraftAdapterError("The berry bush changed before harvesting.", "RESOURCE_TARGET_CHANGED");
    }
    if (!isRipeBerryBush(refreshed.name, blockProperties(refreshed))) {
      throw new MinecraftAdapterError("The sweet berry bush is not ripe yet.", "BERRY_NOT_RIPE");
    }
    if (distanceBetween(bot.entity.position, center) > 4.2) {
      throw new MinecraftAdapterError("The berry bush is outside reach after navigation.", "BERRY_OUT_OF_REACH");
    }
    await raceWithAbort(bot.activateBlock(refreshed), signal);
    const after = await this.waitForInventoryGain(bot, "sweet_berries", before, 1_000, signal);
    const ageAfter = blockProperties(this.blockAtCoordinates(bot, x, y, z)).age ?? null;
    return {
      confirmed: after > before,
      confirmation: "sweet_berries_inventory_delta_checked",
      details: {
        coordinates: { x, y, z },
        ageBefore: properties.age ?? null,
        ageAfter,
        berriesBefore: before,
        berriesAfter: after,
      },
    };
  }

  private async executeRest(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftRestInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid rest request.", "INVALID_ACTION_INPUT");
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError(
        `Resting is only modelled for survival mode; current mode is '${bot.game.gameMode}'.`,
        "GAME_MODE_BLOCKS_REST",
      );
    }
    const healthBefore = finiteOrNull(bot.health);
    if (healthBefore === null) {
      throw new MinecraftAdapterError("Player health is unavailable; resting cannot be verified.", "HEALTH_UNKNOWN");
    }
    const { durationMs, targetHealth, dangerRadius } = parsed.data;
    const startedAt = Date.now();
    let stopReason: "target" | "duration" | "threat" | "damage" = "duration";
    for (;;) {
      if (signal.aborted) throw abortError(signal);
      if (hasVisibleHostileNear(bot, bot.entity.position, dangerRadius)) {
        stopReason = "threat";
        break;
      }
      const health = finiteOrNull(bot.health) ?? healthBefore;
      if (health < healthBefore) {
        stopReason = "damage";
        break;
      }
      if (health >= targetHealth) {
        stopReason = "target";
        break;
      }
      if (Date.now() - startedAt >= durationMs) break;
      await delayWithAbort(250, signal);
    }
    if (stopReason === "threat") {
      throw new MinecraftAdapterError(
        `A visible hostile entered the ${dangerRadius}-block rest radius; resting was interrupted.`,
        "REST_INTERRUPTED_BY_THREAT",
      );
    }
    if (stopReason === "damage") {
      throw new MinecraftAdapterError("The player took damage while resting; resting was interrupted.", "REST_INTERRUPTED_BY_DAMAGE");
    }
    const healthAfter = finiteOrNull(bot.health) ?? healthBefore;
    return {
      confirmed: healthAfter > healthBefore,
      confirmation: "health_increase_observed_during_rest",
      details: {
        stopReason,
        healthBefore,
        healthAfter,
        food: finiteOrNull(bot.food),
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  private async waitForInventoryGain(
    bot: Bot,
    itemName: string,
    before: number,
    settleMs: number,
    signal: AbortSignal,
  ): Promise<number> {
    const deadline = Date.now() + settleMs;
    let count = inventoryCount(bot, itemName);
    while (count <= before && Date.now() < deadline) {
      await delayWithAbort(100, signal);
      count = inventoryCount(bot, itemName);
    }
    return count;
  }

  private async executePlaceCraftingTable(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftPlaceTableInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid crafting-table placement target.", "INVALID_ACTION_INPUT");
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError("Placing a crafting table requires survival mode.", "GAME_MODE_BLOCKS_PLACEMENT");
    }
    const tableItem = bot.inventory.items().find((item) => item.name === "crafting_table");
    if (!tableItem) {
      throw new MinecraftAdapterError("Inventory does not contain a crafting table.", "CRAFTING_TABLE_NOT_IN_INVENTORY");
    }
    const { x, y, z } = parsed.data;
    const destination = this.blockAtCoordinates(bot, x, y, z);
    if (!destination || (destination.name !== "air" && !destination.name.endsWith("_air"))) {
      throw new MinecraftAdapterError("Crafting-table destination is unknown or occupied.", "PLACEMENT_CELL_NOT_EMPTY");
    }
    const support = this.blockAtCoordinates(bot, x, y - 1, z);
    if (
      !support ||
      support.boundingBox !== "block" ||
      unsafePlacementSupportNames.has(support.name) ||
      !bot.canSeeBlock(support)
    ) {
      throw new MinecraftAdapterError("Crafting-table destination has no visible safe solid support block.", "PLACEMENT_SUPPORT_UNSAFE");
    }
    const distance = destination.position.distanceTo(bot.entity.position);
    if (distance > this.config.maxCraftingTableDistance) {
      throw new MinecraftAdapterError(
        `Crafting-table placement is ${distance.toFixed(1)} blocks away; limit is ${this.config.maxCraftingTableDistance}.`,
        "PLACEMENT_TARGET_TOO_FAR",
      );
    }
    if (hasVisibleHostileNear(bot, destination.position.offset(0.5, 0.5, 0.5), parsed.data.dangerRadius)) {
      throw new MinecraftAdapterError(
        `A currently visible hostile is within ${parsed.data.dangerRadius} blocks of the crafting-table destination.`,
        "PLACEMENT_TARGET_THREATENED",
      );
    }
    const playerDistance = Math.hypot(bot.entity.position.x - (x + 0.5), bot.entity.position.z - (z + 0.5));
    if (playerDistance < 0.9 && Math.abs(bot.entity.position.y - y) < 2) {
      throw new MinecraftAdapterError("Crafting-table placement would intersect the player.", "PLACEMENT_INTERSECTS_PLAYER");
    }
    const nearbyEntity = Object.values(bot.entities).find(
      (entity) => entity.id !== bot.entity.id && entity.position.distanceTo(destination.position.offset(0.5, 0.5, 0.5)) < 1.1,
    );
    if (nearbyEntity) {
      throw new MinecraftAdapterError("Crafting-table placement cell is occupied by an entity.", "PLACEMENT_INTERSECTS_ENTITY");
    }

    const countBefore = inventoryCount(bot, "crafting_table");
    await raceWithAbort(bot.equip(tableItem, "hand"), signal);
    await raceWithAbort(bot.placeBlock(support, bot.entity.position.offset(0, 1, 0).subtract(bot.entity.position)), signal);
    const placed = this.blockAtCoordinates(bot, x, y, z);
    const countAfter = inventoryCount(bot, "crafting_table");
    const confirmed = placed?.name === "crafting_table" && countAfter < countBefore;
    return {
      confirmed,
      confirmation: "crafting_table_block_and_inventory_delta_checked",
      details: {
        position: { x, y, z },
        support: { x, y: y - 1, z, name: support.name },
        inventoryBefore: countBefore,
        inventoryAfter: countAfter,
        placedBlock: placed?.name ?? null,
      },
    };
  }

  private cancelCurrentAction(bot: Bot, capability: string): Promise<void> {
    const work: Promise<unknown>[] = [];
    try {
      if (capability === MINECRAFT_NAVIGATE_CAPABILITY && bot.pathfinder) {
        bot.pathfinder.setGoal(null);
      }
      if (capability === MINECRAFT_COLLECT_BLOCK_CAPABILITY || capability === MINECRAFT_MINE_BLOCK_CAPABILITY) {
        bot.pathfinder?.setGoal(null);
        if (bot.collectBlock) work.push(bot.collectBlock.cancelTask());
      }
      bot.clearControlStates();
      bot.stopDigging();
      if (capability === MINECRAFT_LOOK_CAPABILITY && bot.entity) {
        work.push(bot.look(bot.entity.yaw, bot.entity.pitch, true));
      }
    } catch (error) {
      this.logger.warn({ err: error, capability }, "Minecraft action cancellation command failed");
    }
    return Promise.allSettled(work).then(() => undefined);
  }


  /**
   * Digs one allowlisted block. The tool check is done here rather than trusted from the planner: the
   * adapter looks at what is actually held, equips the best carried pickaxe when the hand cannot
   * harvest the block, and refuses when nothing carried can. Confirmation is the drop entering the
   * inventory, so a block that broke but whose item was lost never counts as progress.
   */
  private async executeMineBlock(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftMineBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid mining target.", "INVALID_ACTION_INPUT");
    const { x, y, z, blockName, dangerRadius } = parsed.data;
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError(
        `Mining requires survival mode; current mode is '${bot.game.gameMode}'.`,
        "GAME_MODE_BLOCKS_MINING",
      );
    }
    const block = this.blockAtCoordinates(bot, x, y, z);
    if (!block || block.name !== blockName) {
      throw new MinecraftAdapterError(
        `Expected ${blockName} at the requested position, but the block is unknown or different.`,
        "RESOURCE_TARGET_CHANGED",
      );
    }
    if (block.position.distanceTo(bot.entity.position) > this.config.maxResourceGatherDistance) {
      throw new MinecraftAdapterError("The mining target is out of range.", "RESOURCE_TARGET_TOO_FAR");
    }
    if (hasVisibleHostileNear(bot, block.position.offset(0.5, 0.5, 0.5), dangerRadius)) {
      throw new MinecraftAdapterError(
        `A currently visible hostile is within ${dangerRadius} blocks of the mining target.`,
        "RESOURCE_TARGET_THREATENED",
      );
    }
    if (!block.diggable || !bot.canDigBlock(block)) {
      throw new MinecraftAdapterError("The client reports this block cannot be dug.", "BLOCK_NOT_DIGGABLE");
    }
    const drop = minecraftMiningRequirements[blockName]?.drop ?? blockName;
    if (!this.canAcceptItem(bot, drop)) {
      throw new MinecraftAdapterError(
        "The inventory has no room for the mined drop; free a slot before mining.",
        "INVENTORY_FULL",
      );
    }

    const handBefore = bot.heldItem?.name ?? null;
    if (!block.canHarvest(bot.heldItem?.type ?? null)) {
      const carried = bot.inventory.items().filter((item) => bestPickaxeTier([item]).tier > 0);
      const best = carried.sort(
        (left, right) => bestPickaxeTier([right]).tier - bestPickaxeTier([left]).tier,
      )[0];
      if (!best) {
        const verdict = canMineWithTier(blockName, 0);
        throw new MinecraftAdapterError(
          verdict.mineable ? "The client refuses to harvest this block with the current tool." : verdict.reason,
          "TOOL_TIER_INSUFFICIENT",
        );
      }
      await raceWithAbort(bot.equip(best, "hand"), signal);
      if (!block.canHarvest(bot.heldItem?.type ?? null)) {
        throw new MinecraftAdapterError(
          `Even with ${best.name} equipped the client reports ${blockName} cannot be harvested.`,
          "TOOL_TIER_INSUFFICIENT",
        );
      }
    }

    const reach = 4;
    if (block.position.distanceTo(bot.entity.position) > reach) {
      if (!bot.pathfinder) {
        throw new MinecraftAdapterError("Pathfinder plugin is unavailable.", "PATHFINDER_UNAVAILABLE");
      }
      await this.navigateWithProgressWatchdog(
        bot,
        new pathfinderApi.goals.GoalNear(x, y, z, 1.5),
        signal,
      );
    }
    if (block.position.distanceTo(bot.entity.position) > reach + 1) {
      throw new MinecraftAdapterError("The block is still out of reach after navigation.", "BLOCK_OUT_OF_REACH");
    }

    const inventoryBefore = inventoryCount(bot, drop);
    const tier = bestPickaxeTier([{ name: bot.heldItem?.name ?? "" }]).tier;
    const estimateMs =
      typeof bot.digTime === "function"
        ? bot.digTime(block)
        : estimatedDigSeconds(blockName, tier) * 1_000;
    const digDeadline = Math.max(5_000, Math.min(90_000, Math.round(estimateMs) + this.config.digTimeoutSlackMs));
    let digTimer: NodeJS.Timeout | undefined;
    try {
      await raceWithAbort(
        Promise.race([
          bot.dig(block, true),
          new Promise<never>((_resolve, reject) => {
            digTimer = setTimeout(() => {
              try {
                bot.stopDigging();
              } catch {
                // The client may already have finished; the dig result still decides.
              }
              reject(
                new MinecraftAdapterError(
                  `Digging ${blockName} exceeded ${digDeadline} ms and was aborted.`,
                  "DIG_TIMEOUT",
                ),
              );
            }, digDeadline);
          }),
        ]),
        signal,
      );
    } catch (error) {
      if (error instanceof MinecraftAdapterError) throw error;
      if (signal.aborted) throw error;
      throw new MinecraftAdapterError(
        `Digging failed: ${error instanceof Error ? error.message : String(error)}`,
        "DIG_FAILED",
      );
    } finally {
      if (digTimer) clearTimeout(digTimer);
    }

    const inventoryAfter = await this.waitForInventoryGain(bot, drop, inventoryBefore, this.config.dropSettleMs, signal);
    const remaining = this.blockAtCoordinates(bot, x, y, z);
    const blockRemoved = !remaining || remaining.name !== blockName;
    // Putting the previous hand back is best-effort; a failure there must not hide a successful dig.
    if (handBefore && bot.heldItem?.name !== handBefore) {
      const restore = bot.inventory.items().find((item) => item.name === handBefore);
      if (restore) {
        await bot.equip(restore, "hand").catch(() => undefined);
      }
    }
    return {
      confirmed: inventoryAfter > inventoryBefore && blockRemoved,
      confirmation: "dig_completed_and_drop_inventory_delta_checked",
      details: {
        blockName,
        drop,
        coordinates: { x, y, z },
        inventoryBefore,
        inventoryAfter,
        blockRemoved,
        tool: bot.heldItem?.name ?? null,
        digDeadlineMs: Math.round(digDeadline),
      },
    };
  }

  /** Places one allowlisted block onto an observed support block. Same safety checks as the table skill. */
  private async executePlaceBlock(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftPlaceBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid block placement target.", "INVALID_ACTION_INPUT");
    return await this.placeOneBlock(bot, parsed.data.x, parsed.data.y, parsed.data.z, parsed.data.blockName, parsed.data.dangerRadius, signal);
  }

  private async placeOneBlock(
    bot: Bot,
    x: number,
    y: number,
    z: number,
    blockName: string,
    dangerRadius: number,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    if (bot.game.gameMode !== "survival") {
      throw new MinecraftAdapterError(
        `Placing ${blockName} requires survival mode; current mode is '${bot.game.gameMode}'.`,
        "GAME_MODE_BLOCKS_PLACEMENT",
      );
    }
    const item = bot.inventory.items().find((candidate) => candidate.name === blockName);
    if (!item) {
      throw new MinecraftAdapterError(`Inventory does not contain ${blockName}.`, "PLACEMENT_BLOCK_NOT_IN_INVENTORY");
    }
    const destination = this.blockAtCoordinates(bot, x, y, z);
    if (!destination || (destination.name !== "air" && !destination.name.endsWith("_air"))) {
      throw new MinecraftAdapterError("Placement destination is unknown or occupied.", "PLACEMENT_CELL_NOT_EMPTY");
    }
    const support = this.blockAtCoordinates(bot, x, y - 1, z);
    if (
      !support ||
      support.boundingBox !== "block" ||
      unsafePlacementSupportNames.has(support.name) ||
      !bot.canSeeBlock(support)
    ) {
      throw new MinecraftAdapterError("Placement destination has no visible safe solid support block.", "PLACEMENT_SUPPORT_UNSAFE");
    }
    const distance = destination.position.distanceTo(bot.entity.position);
    if (distance > this.config.maxPlacementDistance) {
      throw new MinecraftAdapterError(
        `Placement is ${distance.toFixed(1)} blocks away; limit is ${this.config.maxPlacementDistance}.`,
        "PLACEMENT_TARGET_TOO_FAR",
      );
    }
    if (hasVisibleHostileNear(bot, destination.position.offset(0.5, 0.5, 0.5), dangerRadius)) {
      throw new MinecraftAdapterError(
        `A currently visible hostile is within ${dangerRadius} blocks of the placement cell.`,
        "PLACEMENT_TARGET_THREATENED",
      );
    }
    const playerDistance = Math.hypot(bot.entity.position.x - (x + 0.5), bot.entity.position.z - (z + 0.5));
    if (playerDistance < 0.9 && Math.abs(bot.entity.position.y - y) < 2) {
      throw new MinecraftAdapterError(`Placing ${blockName} here would intersect the player.`, "PLACEMENT_INTERSECTS_PLAYER");
    }
    const countBefore = inventoryCount(bot, blockName);
    await raceWithAbort(bot.equip(item, "hand"), signal);
    await raceWithAbort(
      bot.placeBlock(support, bot.entity.position.offset(0, 1, 0).subtract(bot.entity.position)),
      signal,
    );
    const placed = this.blockAtCoordinates(bot, x, y, z);
    const countAfter = inventoryCount(bot, blockName);
    return {
      confirmed: placed?.name === blockName && countAfter < countBefore,
      confirmation: "block_read_back_and_inventory_delta_checked",
      details: {
        position: { x, y, z },
        blockName,
        inventoryBefore: countBefore,
        inventoryAfter: countAfter,
        placedBlock: placed?.name ?? null,
      },
    };
  }

  /**
   * Closes the open sides around the player, one validated placement at a time. A cell is only ever
   * chosen when it is observed to be air, has an observed safe support block, and is clear of visible
   * entities, so an unknown region is never treated as "empty and therefore safe to fill".
   */
  private async executeBuildShelter(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftBuildShelterInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid shelter request.", "INVALID_ACTION_INPUT");
    const { mode, maxBlocks, dangerRadius } = parsed.data;
    const directions = mode === "cardinal" ? SHELTER_CARDINAL_DIRECTIONS : SHELTER_DIRECTIONS;
    const feet = {
      x: Math.floor(bot.entity.position.x),
      y: Math.floor(bot.entity.position.y),
      z: Math.floor(bot.entity.position.z),
    };
    const placed: Array<{ x: number; y: number; z: number; blockName: string }> = [];
    const skipped: Array<{ x: number; y: number; z: number; reason: string }> = [];
    for (const [dx, dz] of directions) {
      if (placed.length >= maxBlocks) break;
      const x = feet.x + dx;
      const z = feet.z + dz;
      const y = feet.y;
      const cell = this.blockAtCoordinates(bot, x, y, z);
      if (!cell) {
        skipped.push({ x, y, z, reason: "unknown-block" });
        continue;
      }
      if (cell.boundingBox !== "empty") {
        skipped.push({ x, y, z, reason: "occupied" });
        continue;
      }
      if (hasVisibleHostileNear(bot, cell.position.offset(0.5, 0.5, 0.5), dangerRadius)) {
        skipped.push({ x, y, z, reason: "threatened" });
        continue;
      }
      const blockItem = bot.inventory
        .items()
        .filter((item) => (minecraftPlaceableNames as readonly string[]).includes(item.name))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))[0];
      if (!blockItem) {
        skipped.push({ x, y, z, reason: "no-blocks-in-inventory" });
        break;
      }
      try {
        const outcome = await this.placeOneBlock(bot, x, y, z, blockItem.name, dangerRadius, signal);
        if (outcome.confirmed) {
          placed.push({ x, y, z, blockName: blockItem.name });
        } else {
          skipped.push({ x, y, z, reason: "placement-not-confirmed" });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        skipped.push({
          x,
          y,
          z,
          reason: error instanceof MinecraftAdapterError ? error.code : "placement-failed",
        });
      }
    }
    const solidCardinal = cardinalShelterCount(bot, feet);
    if (placed.length === 0) {
      throw new MinecraftAdapterError(
        `No shelter cell could be closed: ${skipped.map((entry) => `${entry.reason}@${entry.x},${entry.y},${entry.z}`).join(", ") || "no candidates"}.`,
        "SHELTER_NO_PLACEMENTS",
      );
    }
    return {
      confirmed: placed.length > 0,
      confirmation: "shelter_blocks_read_back_in_postcondition",
      details: {
        mode,
        placedCount: placed.length,
        placed,
        skipped,
        solidCardinalCells: solidCardinal,
        sheltered: solidCardinal >= SHELTER_CARDINAL_DIRECTIONS.length,
      },
    };
  }

  /**
   * Bounded engagement with one specific hostile. Refused outright unless the operator enabled
   * combat on this adapter *and* the safety broker allowed the capability; every swing re-checks
   * health, distance and how many hostiles are nearby, and the agent withdraws instead of fighting
   * to the death.
   */
  private async executeAttackHostile(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftAttackHostileInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid attack request.", "INVALID_ACTION_INPUT");
    if (!this.combatAllowedValue) {
      throw new MinecraftAdapterError(
        "Combat is not armed on this adapter (start with --allow-combat or arm it from the Control Center).",
        "COMBAT_DISABLED",
      );
    }
    const { entityId, maxHits, dangerRadius, minHealth, retreatHealth, requiredDamage } = parsed.data;
    const numericId = Number(entityId);
    const entity = Number.isFinite(numericId) ? bot.entities[entityId] : undefined;
    if (!entity) {
      throw new MinecraftAdapterError("The target entity is no longer in the client's entity list.", "COMBAT_TARGET_GONE");
    }
    const name = String((entity as { name?: string }).name ?? entity.type ?? "unknown");
    if (!isHostileMinecraftEntity(name, entity.type)) {
      throw new MinecraftAdapterError(`'${name}' is not on the hostile list; attacking is refused.`, "COMBAT_TARGET_INVALID");
    }
    const weapon = bestWeapon([
      ...(bot.heldItem?.name ? [{ name: bot.heldItem.name }] : []),
      ...bot.inventory.items().map((item) => ({ name: item.name })),
    ]);
    const verdict = combatIsAllowed({
      enabled: true,
      health: finiteOrNull(bot.health),
      minHealth,
      retreatHealth,
      hostileCountNearby: countHostilesNear(bot, bot.entity.position, dangerRadius * 1.5),
      maxEngageableHostiles: 1,
      weapon: weapon ? { name: weapon.name, damage: weapon.damage } : null,
      requiredDamage,
      targetDistance: entity.position.distanceTo(bot.entity.position),
      maxTargetDistance: 4,
      hitsAlreadyAttempted: 0,
      maxHits,
      hostileName: name,
      hostileType: entity.type,
      hunger: finiteOrNull(bot.food),
    });
    if (!verdict.allowed) {
      throw new MinecraftAdapterError(verdict.reason, verdict.code);
    }
    if (weapon) {
      const held = bot.inventory.items().find((item) => item.name === weapon.name);
      if (held && bot.heldItem?.name !== weapon.name) {
        await raceWithAbort(bot.equip(held, "hand"), signal);
      }
    }

    let hits = 0;
    let killed = false;
    let lastHealth = finiteOrNull((entity as { health?: number }).health);
    while (hits < maxHits) {
      if (signal.aborted) throw abortError(signal);
      const health = finiteOrNull(bot.health);
      if (health !== null && health <= retreatHealth) {
        throw new MinecraftAdapterError(
          `Health fell to ${health} while fighting; withdrawing instead of swinging again.`,
          "COMBAT_WITHDRAWN",
        );
      }
      const current = Number.isFinite(numericId) ? bot.entities[entityId] : undefined;
      if (!current) {
        killed = true;
        break;
      }
      if (current.position.distanceTo(bot.entity.position) > 4) {
        throw new MinecraftAdapterError("The hostile left melee range; the fight is broken off.", "COMBAT_TARGET_OUT_OF_RANGE");
      }
      // Facing the target is best effort: an interrupted look must not be reported as a failed swing.
      await raceWithAbort(bot.lookAt(current.position.offset(0, 1, 0), true), signal).catch(() => undefined);
      try {
        bot.attack(current);
      } catch (error) {
        throw new MinecraftAdapterError(
          `Attack failed: ${error instanceof Error ? error.message : String(error)}`,
          "COMBAT_ATTACK_FAILED",
        );
      }
      hits += 1;
      await delayWithAbort(700, signal);
      const updated = Number.isFinite(numericId) ? bot.entities[entityId] : undefined;
      if (!updated) {
        killed = true;
        break;
      }
      lastHealth = finiteOrNull((updated as { health?: number }).health);
    }
    return {
      confirmed: killed,
      confirmation: killed
        ? "target_entity_removed_from_client_entity_list"
        : "target_still_present_after_hit_budget",
      details: {
        entityId,
        hostileName: name,
        hits,
        weapon: weapon?.name ?? null,
        damagePerHit: weapon ? weaponDamageFor(weapon.name) : 1,
        targetHealthAfter: lastHealth,
        killed,
      },
    };
  }

  /** Drops a small amount of allowlisted terrain. Tools, food and resources are refused by the schema. */
  private async executeDropItem(
    bot: Bot,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    const parsed = minecraftDropItemInputSchema.safeParse(input);
    if (!parsed.success) throw new MinecraftAdapterError("Invalid drop request.", "INVALID_ACTION_INPUT");
    const { itemName, count } = parsed.data;
    const before = inventoryCount(bot, itemName);
    if (before < count) {
      throw new MinecraftAdapterError(
        `Inventory holds ${before} ${itemName}, fewer than the ${count} requested.`,
        "ITEM_NOT_IN_INVENTORY",
      );
    }
    const stacks = bot.inventory.items().filter((item) => item.name === itemName);
    const stack = stacks.sort((left, right) => left.slot - right.slot)[0];
    if (!stack) throw new MinecraftAdapterError(`${itemName} is not in the accessible inventory.`, "ITEM_NOT_IN_INVENTORY");
    await raceWithAbort(bot.toss(stack.type, stack.metadata, count), signal);
    const after = inventoryCount(bot, itemName);
    return {
      confirmed: after <= before - count,
      confirmation: "inventory_decrease_observed_after_toss",
      details: { itemName, before, after, requested: count },
    };
  }

  /**
   * Whether the mined or collected item could still enter the inventory: an existing stack with room
   * counts, otherwise a main-inventory slot has to be empty. Mineflayer exposes `slots` as a sparse
   * array over the whole player window, so the check is defensive about unknown layouts and reports
   * "unknown room" as room available.
   */
  private canAcceptItem(bot: Bot, itemName: string): boolean {
    try {
      const items = bot.inventory.items();
      if (items.some((item) => item.name === itemName && item.count < 64)) return true;
      const slots: unknown[] = Array.isArray(bot.inventory.slots) ? bot.inventory.slots : [];
      if (slots.length === 0) return true;
      // Player window slots 9..35 are the main inventory; 36..44 are the hotbar.
      for (let slot = 9; slot <= 44; slot += 1) {
        const existing = slots[slot];
        if (existing === undefined || existing === null) return true;
      }
      return false;
    } catch {
      // Never refuse a dig because the inventory layout could not be read; the drop check still applies.
      return true;
    }
  }

  /** Whether this adapter will execute an attack right now. */
  get combatAllowed(): boolean {
    return this.combatAllowedValue;
  }

  /**
   * Arming combat from the Control Center also requires the safety policy opt-in, so this alone cannot
   * enable fighting on an agent that was started without it: both layers must say yes.
   */
  setCombatAllowed(allowed: boolean): void {
    this.combatAllowedValue = allowed;
    this.logger.info({ combatAllowed: allowed }, allowed ? "Combat armed by operator" : "Combat disarmed by operator");
  }

  private blockAtCoordinates(bot: Bot, x: number, y: number, z: number) {
    return bot.blockAt(
      bot.entity.position.offset(x - bot.entity.position.x, y - bot.entity.position.y, z - bot.entity.position.z),
    );
  }

  private serializeItem(item: ReturnType<Bot["inventory"]["items"]>[number] | null) {
    if (!item) return null;
    return {
      slot: item.slot,
      name: item.name,
      type: item.type,
      count: item.count,
      metadata: Number.isInteger(item.metadata) ? item.metadata : null,
      durabilityUsed: finiteOrNull(item.durabilityUsed),
    };
  }

  private requireConnectedBot(): Bot {
    if (this.statusValue !== "connected" || !this.bot || !this.sessionValue) {
      throw new MinecraftAdapterError("Minecraft adapter is not connected.", "NOT_CONNECTED");
    }
    if (!this.bot.entity?.position) {
      throw new MinecraftAdapterError("Minecraft player entity is not ready.", "PLAYER_NOT_SPAWNED");
    }
    return this.bot;
  }

  private transition(
    status: AdapterStatus,
    reason: string | null,
    sessionIdOverride?: string | null,
  ): void {
    this.statusValue = status;
    const change: AdapterStatusChange = {
      status,
      at: new Date().toISOString(),
      sessionId:
        sessionIdOverride === undefined
          ? this.sessionValue?.id ?? this.pendingSessionId
          : sessionIdOverride,
      reason,
    };
    for (const listener of this.statusListeners) {
      try {
        listener(change);
      } catch (error) {
        this.logger.error({ err: error, status }, "GameMind adapter status listener failed");
      }
    }
  }

  private async quitAfterConnectFailure(bot: Bot, reason: string): Promise<void> {
    let settleEnd: ((outcome: "ended" | "timeout") => void) | undefined;
    const endOutcome = new Promise<"ended" | "timeout">((resolve) => {
      settleEnd = resolve;
    });
    const onEnd = (): void => settleEnd?.("ended");
    bot.once("end", onEnd);
    const timer = setTimeout(() => settleEnd?.("timeout"), this.config.shutdownTimeoutMs);
    try {
      bot.quit(reason);
    } catch (error) {
      this.logger.warn({ err: error }, "Graceful quit failed for an unsuccessful Minecraft connection");
      try {
        bot.end(reason);
      } catch (endError) {
        this.logger.warn({ err: endError }, "Could not force-close a failed Minecraft connection");
      }
    }
    const outcome = await endOutcome;
    clearTimeout(timer);
    bot.removeListener("end", onEnd);
    if (outcome === "timeout") {
      try {
        bot.end(reason);
      } catch (error) {
        this.logger.warn({ err: error }, "Timed-out Minecraft connection could not be force-closed");
      }
    }
  }
}

export function minecraftAdapterConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MinecraftAdapterConfig {
  const port = Number(env.MINECRAFT_PORT ?? DEFAULT_MINECRAFT_CONFIG.port);
  const connectTimeoutMs = Number(
    env.MINECRAFT_CONNECT_TIMEOUT_MS ?? DEFAULT_MINECRAFT_CONFIG.connectTimeoutMs,
  );
  const authValue = env.MINECRAFT_AUTH ?? DEFAULT_MINECRAFT_CONFIG.auth;
  if (authValue !== "offline" && authValue !== "microsoft") {
    throw new Error("MINECRAFT_AUTH must be either 'offline' or 'microsoft'.");
  }

  return {
    ...DEFAULT_MINECRAFT_CONFIG,
    host: env.MINECRAFT_HOST ?? DEFAULT_MINECRAFT_CONFIG.host,
    port,
    username: env.MINECRAFT_USERNAME ?? DEFAULT_MINECRAFT_CONFIG.username,
    version: env.MINECRAFT_VERSION ?? DEFAULT_MINECRAFT_CONFIG.version,
    auth: authValue,
    connectTimeoutMs,
  };
}
