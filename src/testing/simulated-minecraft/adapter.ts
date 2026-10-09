import { randomUUID } from "node:crypto";
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
import {
  minecraftCapabilities,
  MINECRAFT_COLLECT_BLOCK_CAPABILITY,
  MINECRAFT_CRAFT_CAPABILITY,
  MINECRAFT_EAT_CAPABILITY,
  MINECRAFT_EQUIP_CAPABILITY,
  MINECRAFT_HARVEST_BERRIES_CAPABILITY,
  MINECRAFT_INSPECT_BLOCK_CAPABILITY,
  MINECRAFT_LOOK_CAPABILITY,
  MINECRAFT_NAVIGATE_CAPABILITY,
  MINECRAFT_PICKUP_ITEM_CAPABILITY,
  MINECRAFT_PLACE_TABLE_CAPABILITY,
  MINECRAFT_REST_CAPABILITY,
  MINECRAFT_MINE_BLOCK_CAPABILITY,
  MINECRAFT_PLACE_BLOCK_CAPABILITY,
  MINECRAFT_BUILD_SHELTER_CAPABILITY,
  MINECRAFT_ATTACK_HOSTILE_CAPABILITY,
  MINECRAFT_DROP_ITEM_CAPABILITY,
  minecraftCollectBlockInputSchema,
  minecraftCraftItemInputSchema,
  minecraftEatFoodInputSchema,
  minecraftEquipInputSchema,
  minecraftHarvestBerriesInputSchema,
  minecraftInspectBlockInputSchema,
  minecraftLookInputSchema,
  minecraftNavigateInputSchema,
  minecraftPickupItemInputSchema,
  minecraftPlaceTableInputSchema,
  minecraftRestInputSchema,
  minecraftMineBlockInputSchema,
  minecraftPlaceBlockInputSchema,
  minecraftBuildShelterInputSchema,
  minecraftAttackHostileInputSchema,
  minecraftDropItemInputSchema,
} from "../../games/minecraft/capabilities.js";
import {
  minecraftFoodNutrition,
  minecraftWoodRecipePlans,
  type CraftableMinecraftItem,
} from "../../games/minecraft/recipes.js";
import { blockObservationPriority, isInterestingBlockName } from "../../games/minecraft/block-classes.js";
import {
  bestPickaxeTier,
  canMineWithTier,
  estimatedDigSeconds,
  isMineableBlockName,
  minecraftMiningRequirements,
} from "../../games/minecraft/mining.js";
import { UNARMED_DAMAGE, weaponDamageFor, combatIsAllowed } from "../../games/minecraft/combat.js";
import { SHELTER_DIRECTIONS, SHELTER_CARDINAL_DIRECTIONS } from "../../games/minecraft/shelter.js";
import { minecraftObservationSchema, type MinecraftObservation } from "../../games/minecraft/observation.js";
import {
  SimulatedActionError,
  SimulatedMinecraftWorld,
  type SimWorldDefinition,
} from "./world.js";

/** Virtual milliseconds a player-tossed item stays uncollectable (Java uses a short pickup delay). */
const PLAYER_DROP_PICKUP_DELAY_MS = 1_000;


const MAX_OBSERVED_BLOCKS = 64;
const MAX_NAVIGATION_DISTANCE = 48;
const MAX_RESOURCE_GATHER_DISTANCE = 24;
const MAX_CRAFTING_TABLE_DISTANCE = 4.5;
const MAX_PLACEMENT_DISTANCE = 4.5;

function cardinalSolidCount(world: { playerX: number; playerY: number; playerZ: number; blockAt(x: number, y: number, z: number): { boundingBox: string } | null }): number {
  const feetX = Math.floor(world.playerX);
  const feetY = Math.floor(world.playerY);
  const feetZ = Math.floor(world.playerZ);
  return SHELTER_CARDINAL_DIRECTIONS.filter(([dx, dz]) => world.blockAt(feetX + dx, feetY, feetZ + dz)?.boundingBox === "block").length;
}
const UNSAFE_SUPPORT_NAMES = new Set(["lava", "water", "fire", "soul_fire", "magma_block", "cactus"]);

export interface SimulatedAdapterOptions {
  readonly definition: SimWorldDefinition;
  readonly gameVersion?: string;
  /** Capabilities to hide, to model adapters that lack a skill (e.g. no rest support). */
  readonly omitCapabilities?: readonly string[];
  /** Mirrors the live adapter's operator switch: attacks are refused unless this is true. */
  readonly allowCombat?: boolean;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Simulated action aborted.");
}

function distance3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * A GameAdapter over {@link SimulatedMinecraftWorld}. It advertises the same capability names,
 * validates inputs with the same schemas, and reports the same error codes as the live adapter, so
 * control logic can be exercised against realistic failures. It does not model the protocol.
 */
export class SimulatedMinecraftAdapter implements GameAdapter<MinecraftObservation> {
  readonly gameId = "minecraft-java";
  readonly capabilities: readonly CapabilityDefinition[];
  readonly combatEnabled: boolean;
  readonly world: SimulatedMinecraftWorld;

  private statusValue: AdapterStatus = "disconnected";
  private sessionValue: GameSession | null = null;
  private sequence = 0;
  private connectionCount = 0;
  private yaw = 0;
  private pitch = 0;
  private readonly equipment: Record<string, { name: string; type: number; count: number; slot: number } | null> = {
    hand: null,
    offhand: null,
    head: null,
    torso: null,
    legs: null,
    feet: null,
  };
  private readonly listeners = new Set<(change: AdapterStatusChange) => void>();
  private activeActionId: string | null = null;

  constructor(private readonly options: SimulatedAdapterOptions) {
    this.combatEnabled = options.allowCombat ?? false;
    const omitted = new Set(options.omitCapabilities ?? []);
    this.capabilities = minecraftCapabilities.filter((capability) => !omitted.has(capability.name));
    this.world = new SimulatedMinecraftWorld(options.definition);
  }

  get status(): AdapterStatus {
    return this.statusValue;
  }

  get session(): GameSession | null {
    return this.statusValue === "connected" ? this.sessionValue : null;
  }

  /** Virtual game time in milliseconds; used as the task clock in offline evaluation. */
  get simulatedNowMs(): number {
    return this.world.nowMs;
  }

  onStatusChange(listener: (change: AdapterStatusChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<GameSession> {
    if (this.session) return this.session;
    this.transition("connecting", null);
    this.connectionCount += 1;
    this.sequence = 0;
    const session: GameSession = {
      id: `sim-${this.options.definition.seed}-${this.connectionCount}-${randomUUID().slice(0, 8)}`,
      gameId: this.gameId,
      gameVersion: this.options.gameVersion ?? "1.20.4",
      connectedAt: new Date().toISOString(),
    };
    this.sessionValue = session;
    this.transition("connected", null);
    return session;
  }

  async observe(): Promise<GameObservation<MinecraftObservation>> {
    const session = this.session;
    if (!session) throw new Error("Simulated Minecraft adapter is not connected.");
    return {
      schemaVersion: 1,
      gameId: this.gameId,
      gameVersion: session.gameVersion,
      sessionId: session.id,
      sequence: this.sequence++,
      observedAt: new Date().toISOString(),
      state: this.snapshot(),
    };
  }

  async executeAction(action: AdapterAction, signal: AbortSignal): Promise<AdapterActionOutcome> {
    if (this.statusValue !== "connected" || this.sessionValue?.id !== action.sessionId) {
      throw Object.assign(new Error("Simulated adapter received an action for a disconnected session."), {
        code: "STALE_SESSION",
      });
    }
    if (this.activeActionId) {
      throw Object.assign(new Error("Simulated adapter already has an active action."), { code: "ACTION_BUSY" });
    }
    this.activeActionId = action.actionId;
    try {
      if (signal.aborted) throw abortError(signal);
      const check = (): void => {
        if (signal.aborted) throw abortError(signal);
      };
      switch (action.capability) {
        case MINECRAFT_LOOK_CAPABILITY:
          return this.look(action.input);
        case MINECRAFT_INSPECT_BLOCK_CAPABILITY:
          return this.inspect(action.input);
        case MINECRAFT_NAVIGATE_CAPABILITY:
          return this.navigate(action.input, check);
        case MINECRAFT_COLLECT_BLOCK_CAPABILITY:
          return this.collect(action.input, check);
        case MINECRAFT_EQUIP_CAPABILITY:
          return this.equip(action.input);
        case MINECRAFT_CRAFT_CAPABILITY:
          return this.craft(action.input, check);
        case MINECRAFT_EAT_CAPABILITY:
          return this.eat(action.input, check);
        case MINECRAFT_PLACE_TABLE_CAPABILITY:
          return this.placeTable(action.input, check);
        case MINECRAFT_PICKUP_ITEM_CAPABILITY:
          return this.pickup(action.input, check);
        case MINECRAFT_HARVEST_BERRIES_CAPABILITY:
          return this.harvest(action.input, check);
        case MINECRAFT_REST_CAPABILITY:
          return this.rest(action.input, check);
        case MINECRAFT_MINE_BLOCK_CAPABILITY:
          return this.mine(action.input, check);
        case MINECRAFT_PLACE_BLOCK_CAPABILITY:
          return this.placeBlock(action.input, check);
        case MINECRAFT_BUILD_SHELTER_CAPABILITY:
          return this.buildShelter(action.input, check);
        case MINECRAFT_ATTACK_HOSTILE_CAPABILITY:
          return this.attack(action.input, check);
        case MINECRAFT_DROP_ITEM_CAPABILITY:
          return this.dropItem(action.input, check);
        default:
          throw Object.assign(new Error(`Simulated adapter does not support '${action.capability}'.`), {
            code: "UNSUPPORTED_CAPABILITY",
          });
      }
    } finally {
      this.activeActionId = null;
    }
  }

  async cancelActiveAction(actionId: string, _reason: string): Promise<void> {
    if (this.activeActionId === actionId) this.activeActionId = null;
  }

  async disconnect(reason = "simulated adapter shutdown"): Promise<void> {
    const endedSessionId = this.sessionValue?.id ?? null;
    this.sessionValue = null;
    if (this.statusValue !== "disconnected") this.transition("disconnected", reason, endedSessionId);
  }

  /** Observation composition mirrors the live adapter: capped local cube, wide scan, drops. */
  private snapshot(): MinecraftObservation {
    const world = this.world;
    const localCube = world.localCube();
    const center = {
      x: Math.floor(world.playerX),
      y: Math.floor(world.playerY),
      z: Math.floor(world.playerZ),
    };
    const nearbyBlocks = localCube.blocks
      .map((block) => ({ block, distance: distance3(block.position, center) }))
      .sort((left, right) => {
        const interest = blockObservationPriority(right.block.name) - blockObservationPriority(left.block.name);
        return interest || left.distance - right.distance;
      })
      .slice(0, MAX_OBSERVED_BLOCKS)
      .map(({ block }) => block);
    const resources = world.resourceSightings(MAX_OBSERVED_BLOCKS);
    const mineable = world.minableSightings(MAX_OBSERVED_BLOCKS);
    const equipmentSnapshot = (key: string) => {
      const stack = this.equipment[key];
      return stack
        ? { slot: stack.slot, name: stack.name, type: stack.type, count: stack.count, metadata: null, durabilityUsed: null }
        : null;
    };
    const state = minecraftObservationSchema.parse({
      player: {
        username: "GameMind",
        position: { x: world.playerX, y: world.playerY, z: world.playerZ },
        orientation: { yaw: this.yaw, pitch: this.pitch },
        dimension: world.dimension,
        gameMode: world.gameMode,
        health: world.health,
        food: world.food,
        foodSaturation: 0,
        oxygenLevel: 300,
        onGround: true,
        inventoryFull: world.inventory.length >= world.maxInventoryStacks,
      },
      inventory: world.inventory.map((stack) => ({ ...stack })),
      equipment: {
        hand: equipmentSnapshot("hand"),
        offhand: equipmentSnapshot("offhand"),
        head: equipmentSnapshot("head"),
        torso: equipmentSnapshot("torso"),
        legs: equipmentSnapshot("legs"),
        feet: equipmentSnapshot("feet"),
      },
      entities: world.entityList(),
      nearbyBlocks,
      resourceSightings: resources.blocks,
      resourceScan: {
        radius: 24,
        limit: MAX_OBSERVED_BLOCKS,
        center,
        truncated: resources.truncated,
      },
      minableSightings: mineable.blocks,
      minableScan: {
        radius: 24,
        limit: MAX_OBSERVED_BLOCKS,
        center,
        truncated: mineable.truncated,
      },
      time: {
        dayTicks: world.dayTicks,
        day: world.dayNumber,
        isNight: world.isNight,
      },
      itemDrops: world.itemDropList(),
      sampledRegion: {
        radius: 3,
        verticalRadius: 2,
        center,
        sampledCells: localCube.sampledCells,
        unknownCells: localCube.unknownCells,
        truncated: localCube.blocks.length > MAX_OBSERVED_BLOCKS,
      },
    });
    return state;
  }

  private look(input: unknown): AdapterActionOutcome {
    const parsed = minecraftLookInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid look parameters.", "INVALID_ACTION_INPUT");
    this.yaw = parsed.data.yaw;
    this.pitch = parsed.data.pitch;
    return { confirmed: true, confirmation: "simulated_orientation_updated", details: { yaw: this.yaw, pitch: this.pitch } };
  }

  private inspect(input: unknown): AdapterActionOutcome {
    const parsed = minecraftInspectBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid block coordinates.", "INVALID_ACTION_INPUT");
    const block = this.world.blockAt(parsed.data.x, parsed.data.y, parsed.data.z);
    if (!block) throw new SimulatedActionError("Block is not loaded/observed by the client.", "BLOCK_UNKNOWN");
    return {
      confirmed: true,
      confirmation: "simulated_block_state_read",
      details: { name: block.name, boundingBox: block.boundingBox },
    };
  }

  /** Path to any standable cell within `range` of the target, using the world's BFS. */
  private pathNear(target: { x: number; y: number; z: number }, range: number) {
    return this.world.findPath(
      (x, z) =>
        Math.hypot(x + 0.5 - (target.x + 0.5), z + 0.5 - (target.z + 0.5)) <= range &&
        Math.abs(this.world.standingY - target.y) <= 2,
    );
  }

  private walkPath(path: readonly { x: number; z: number }[], check: () => void): void {
    const { stalledAt } = this.world.walk(path, check);
    if (stalledAt) {
      throw new SimulatedActionError(
        `Player made no movement progress for ${this.world.navigationStuckTimeoutMs} ms during navigation at ${stalledAt.x},${stalledAt.z}.`,
        "NAVIGATION_STUCK",
      );
    }
  }

  private navigate(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftNavigateInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid navigation target.", "INVALID_ACTION_INPUT");
    const { x, y, z, range } = parsed.data;
    const from = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    const targetDistance = distance3(from, { x: x + 0.5, y, z: z + 0.5 });
    if (targetDistance > MAX_NAVIGATION_DISTANCE) {
      throw new SimulatedActionError(
        `Navigation target is ${targetDistance.toFixed(1)} blocks away; limit is ${MAX_NAVIGATION_DISTANCE}.`,
        "NAVIGATION_TARGET_TOO_FAR",
      );
    }
    const path = this.pathNear({ x, y, z }, range);
    if (!path) {
      throw new SimulatedActionError(`No path to the goal near ${x},${y},${z}.`, "PATH_NOT_FOUND");
    }
    this.walkPath(path, check);
    const to = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    const horizontalDistance = Math.hypot(to.x - (x + 0.5), to.z - (z + 0.5));
    const verticalDistance = Math.abs(to.y - y);
    const confirmed = horizontalDistance <= range + 1.25 && verticalDistance <= 2;
    return {
      confirmed,
      confirmation: "simulated_goal_reached_and_position_checked",
      details: { from, to, target: { x, y, z }, range, horizontalDistance, verticalDistance },
    };
  }

  private collect(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftCollectBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid collection target.", "INVALID_ACTION_INPUT");
    const { x, y, z, blockName, dangerRadius } = parsed.data;
    const block = this.world.blockAt(x, y, z);
    if (!block || block.name !== blockName) {
      throw new SimulatedActionError("The requested resource block is unknown or different.", "RESOURCE_TARGET_CHANGED");
    }
    if (this.world.dimension !== "overworld") {
      throw new SimulatedActionError("Log collection is overworld-only.", "UNSUPPORTED_DIMENSION");
    }
    if (this.world.gameMode !== "survival") {
      throw new SimulatedActionError(`Log collection requires survival mode; current mode is '${this.world.gameMode}'.`, "GAME_MODE_BLOCKS_COLLECTION");
    }
    const playerTarget = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    const distance = distance3(playerTarget, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    if (distance > MAX_RESOURCE_GATHER_DISTANCE) {
      throw new SimulatedActionError(
        `Resource is ${distance.toFixed(1)} blocks away; limit is ${MAX_RESOURCE_GATHER_DISTANCE}.`,
        "RESOURCE_TARGET_TOO_FAR",
      );
    }
    if (this.world.hostilesNear(x + 0.5, y + 0.5, z + 0.5, dangerRadius)) {
      throw new SimulatedActionError(
        `A currently visible hostile is within ${dangerRadius} blocks of the resource target.`,
        "RESOURCE_TARGET_THREATENED",
      );
    }
    const path = this.pathNear({ x, y, z }, 1.5);
    if (!path) throw new SimulatedActionError("No path to a cell adjacent to the resource.", "PATH_NOT_FOUND");
    const before = this.world.countItem(blockName);
    this.walkPath(path, check);
    check();
    this.world.advance(600, check);
    // The block may have been removed while walking; like collectBlock, nothing is gained then.
    if (this.world.blockAt(x, y, z)?.name === blockName) {
      this.world.setBlock(x, y, z, null);
      this.world.addToInventory(blockName, 1);
    }
    const after = this.world.countItem(blockName);
    return {
      confirmed: after > before,
      confirmation: "simulated_collection_inventory_delta_checked",
      details: { blockName, coordinates: { x, y, z }, inventoryBefore: before, inventoryAfter: after },
    };
  }

  private equip(input: unknown): AdapterActionOutcome {
    const parsed = minecraftEquipInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid equipment request.", "INVALID_ACTION_INPUT");
    const stack = this.world.inventory.find((candidate) => candidate.name === parsed.data.item);
    if (!stack) throw new SimulatedActionError(`Inventory does not contain '${parsed.data.item}'.`, "ITEM_NOT_IN_INVENTORY");
    this.world.removeFromInventory(parsed.data.item, 1);
    const key = parsed.data.destination === "off-hand" ? "offhand" : parsed.data.destination;
    const slot = { hand: 36, "off-hand": 45, head: 5, torso: 6, legs: 7, feet: 8 }[parsed.data.destination];
    this.equipment[key] = { name: parsed.data.item, type: stack.type, count: 1, slot };
    return {
      confirmed: this.equipment[key]?.name === parsed.data.item,
      confirmation: "simulated_equipment_slot_matches",
      details: { item: parsed.data.item, destination: parsed.data.destination },
    };
  }

  private craft(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftCraftItemInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid craft request.", "INVALID_ACTION_INPUT");
    const { item, count, craftingTable } = parsed.data;
    if (this.world.gameMode !== "survival") {
      throw new SimulatedActionError("Crafting requires survival mode.", "GAME_MODE_BLOCKS_CRAFTING");
    }
    const before = this.world.countItem(item);
    if (before >= count) {
      return { confirmed: true, confirmation: "requested_item_count_already_in_inventory", details: { item, inventoryBefore: before, inventoryAfter: before } };
    }
    const plan = minecraftWoodRecipePlans[item as CraftableMinecraftItem];
    if (!plan) throw new SimulatedActionError(`No recipe for '${item}'.`, "CRAFT_ITEM_UNAVAILABLE");
    if (plan.requiresCraftingTable) {
      if (!craftingTable || this.world.blockAt(craftingTable.x, craftingTable.y, craftingTable.z)?.name !== "crafting_table") {
        throw new SimulatedActionError("The observed crafting table is no longer present.", "CRAFTING_TABLE_CHANGED");
      }
      const player = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
      if (distance3(player, craftingTable) > MAX_CRAFTING_TABLE_DISTANCE) {
        throw new SimulatedActionError("Crafting table is out of reach.", "CRAFTING_TABLE_TOO_FAR");
      }
    }
    const runs = Math.ceil((count - before) / plan.outputCount);
    const planks = this.world.inventory.filter((stack) => stack.name.endsWith("_planks")).reduce((sum, stack) => sum + stack.count, 0);
    for (const [ingredient, quantity] of Object.entries(plan.ingredients)) {
      const needed = quantity * runs;
      const available = ingredient === "any_planks" ? planks : this.world.countItem(ingredient);
      if (available < needed) {
        throw new SimulatedActionError(`Missing ${needed - available} ${ingredient} for '${item}'.`, "CRAFTING_PREREQUISITES_UNAVAILABLE");
      }
    }
    check();
    this.world.advance(500, check);
    for (const [ingredient, quantity] of Object.entries(plan.ingredients)) {
      const needed = quantity * runs;
      if (ingredient === "any_planks") {
        let remaining = needed;
        for (const stack of [...this.world.inventory].filter((candidate) => candidate.name.endsWith("_planks"))) {
          const take = Math.min(remaining, stack.count);
          if (take > 0) this.world.removeFromInventory(stack.name, take);
          remaining -= take;
          if (remaining === 0) break;
        }
      } else {
        this.world.removeFromInventory(ingredient, needed);
      }
    }
    this.world.addToInventory(item, plan.outputCount * runs);
    const after = this.world.countItem(item);
    return {
      confirmed: after >= count,
      confirmation: "simulated_craft_inventory_delta_checked",
      details: { item, requestedCount: count, inventoryBefore: before, inventoryAfter: after, runs },
    };
  }

  private eat(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftEatFoodInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid food request.", "INVALID_ACTION_INPUT");
    if (this.world.gameMode !== "survival") throw new SimulatedActionError("Eating requires survival mode.", "GAME_MODE_BLOCKS_EATING");
    const hungerBefore = this.world.food;
    if (hungerBefore >= 20) throw new SimulatedActionError("Player hunger is full; eating is not needed.", "FOOD_NOT_NEEDED");
    const countBefore = this.world.countItem(parsed.data.item);
    if (countBefore < 1) throw new SimulatedActionError(`Inventory does not contain '${parsed.data.item}'.`, "FOOD_NOT_IN_INVENTORY");
    check();
    this.world.advance(1_600, check);
    this.world.removeFromInventory(parsed.data.item, 1);
    const nutrition = minecraftFoodNutrition[parsed.data.item] ?? 0;
    this.world.food = Math.min(20, this.world.food + nutrition);
    const hungerAfter = this.world.food;
    const countAfter = this.world.countItem(parsed.data.item);
    return {
      confirmed: hungerAfter > hungerBefore && countAfter < countBefore,
      confirmation: "simulated_hunger_and_inventory_delta_checked",
      details: { item: parsed.data.item, hungerBefore, hungerAfter, foodCountBefore: countBefore, foodCountAfter: countAfter },
    };
  }

  private placeTable(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftPlaceTableInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid crafting-table placement target.", "INVALID_ACTION_INPUT");
    const { x, y, z, dangerRadius } = parsed.data;
    if (this.world.gameMode !== "survival") throw new SimulatedActionError("Placing a crafting table requires survival mode.", "GAME_MODE_BLOCKS_PLACEMENT");
    if (this.world.countItem("crafting_table") < 1) throw new SimulatedActionError("Inventory does not contain a crafting table.", "CRAFTING_TABLE_NOT_IN_INVENTORY");
    const destination = this.world.blockAt(x, y, z);
    if (!destination || destination.name !== "air") {
      throw new SimulatedActionError("Crafting-table destination is unknown or occupied.", "PLACEMENT_CELL_NOT_EMPTY");
    }
    const support = this.world.blockAt(x, y - 1, z);
    if (!support || support.boundingBox !== "block" || UNSAFE_SUPPORT_NAMES.has(support.name)) {
      throw new SimulatedActionError("Crafting-table destination has no safe solid support block.", "PLACEMENT_SUPPORT_UNSAFE");
    }
    const player = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    if (distance3(player, { x: x + 0.5, y: y + 0.5, z: z + 0.5 }) > MAX_CRAFTING_TABLE_DISTANCE) {
      throw new SimulatedActionError("Crafting-table placement is out of reach.", "PLACEMENT_TARGET_TOO_FAR");
    }
    if (this.world.hostilesNear(x + 0.5, y + 0.5, z + 0.5, dangerRadius)) {
      throw new SimulatedActionError(
        `A currently visible hostile is within ${dangerRadius} blocks of the crafting-table destination.`,
        "PLACEMENT_TARGET_THREATENED",
      );
    }
    if (Math.hypot(player.x - (x + 0.5), player.z - (z + 0.5)) < 0.9 && Math.abs(player.y - y) < 2) {
      throw new SimulatedActionError("Crafting-table placement would intersect the player.", "PLACEMENT_INTERSECTS_PLAYER");
    }
    check();
    this.world.advance(300, check);
    this.world.removeFromInventory("crafting_table", 1);
    this.world.setBlock(x, y, z, "crafting_table");
    return {
      confirmed: this.world.blockAt(x, y, z)?.name === "crafting_table",
      confirmation: "simulated_table_block_and_inventory_delta_checked",
      details: { position: { x, y, z } },
    };
  }

  private pickup(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftPickupItemInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid pickup request.", "INVALID_ACTION_INPUT");
    const { x, y, z, itemName, dangerRadius } = parsed.data;
    if (this.world.gameMode !== "survival") throw new SimulatedActionError("Item pickup requires survival mode.", "GAME_MODE_BLOCKS_PICKUP");
    if (!this.world.findDropNear(itemName, x + 0.5, z + 0.5, 1.5)) {
      throw new SimulatedActionError(`No dropped '${itemName}' is observed at the requested position.`, "ITEM_DROP_NOT_FOUND");
    }
    const player = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    if (distance3(player, { x: x + 0.5, y: y + 0.5, z: z + 0.5 }) > MAX_RESOURCE_GATHER_DISTANCE) {
      throw new SimulatedActionError("Dropped item is out of range.", "PICKUP_TARGET_TOO_FAR");
    }
    if (this.world.hostilesNear(x + 0.5, y + 0.5, z + 0.5, dangerRadius)) {
      throw new SimulatedActionError(
        `A currently visible hostile is within ${dangerRadius} blocks of the dropped item.`,
        "PICKUP_TARGET_THREATENED",
      );
    }
    const path = this.world.findPath((cellX, cellZ) => cellX === x && cellZ === z);
    if (!path) throw new SimulatedActionError("No path to the dropped item.", "PATH_NOT_FOUND");
    const before = this.world.countItem(itemName);
    this.walkPath(path, check);
    this.world.advance(250, check);
    const after = this.world.countItem(itemName);
    return {
      confirmed: after > before,
      confirmation: "dropped_item_entered_inventory_delta_checked",
      details: { itemName, inventoryBefore: before, inventoryAfter: after },
    };
  }

  private harvest(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftHarvestBerriesInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid berry harvest request.", "INVALID_ACTION_INPUT");
    const { x, y, z, dangerRadius } = parsed.data;
    if (this.world.gameMode !== "survival") throw new SimulatedActionError("Berry harvesting requires survival mode.", "GAME_MODE_BLOCKS_HARVEST");
    const block = this.world.blockAt(x, y, z);
    if (!block || block.name !== "sweet_berry_bush") {
      throw new SimulatedActionError("Expected a sweet berry bush at the requested position.", "RESOURCE_TARGET_CHANGED");
    }
    if (!(Number(block.properties.age) >= 2)) throw new SimulatedActionError("The sweet berry bush is not ripe yet.", "BERRY_NOT_RIPE");
    const center = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    const player = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    if (distance3(player, center) > MAX_RESOURCE_GATHER_DISTANCE) {
      throw new SimulatedActionError("Berry bush is out of range.", "RESOURCE_TARGET_TOO_FAR");
    }
    if (this.world.hostilesNear(center.x, center.y, center.z, dangerRadius)) {
      throw new SimulatedActionError(
        `A currently visible hostile is within ${dangerRadius} blocks of the berry bush.`,
        "RESOURCE_TARGET_THREATENED",
      );
    }
    const before = this.world.countItem("sweet_berries");
    if (distance3(player, center) > 3) {
      const path = this.pathNear({ x, y, z }, 2);
      if (!path) throw new SimulatedActionError("No path within reach of the berry bush.", "PATH_NOT_FOUND");
      this.walkPath(path, check);
    }
    if (distance3({ x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ }, center) > 4.2) {
      throw new SimulatedActionError("The berry bush is outside reach after navigation.", "BERRY_OUT_OF_REACH");
    }
    check();
    this.world.advance(300, check);
    const berries = 2 + Math.floor(this.world.nextRandom() * 2);
    this.world.addToInventory("sweet_berries", berries);
    this.world.setBlockAge(x, y, z, 1);
    const after = this.world.countItem("sweet_berries");
    return {
      confirmed: after > before,
      confirmation: "simulated_berries_inventory_delta_checked",
      details: { coordinates: { x, y, z }, berriesBefore: before, berriesAfter: after },
    };
  }

  private rest(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftRestInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid rest request.", "INVALID_ACTION_INPUT");
    const { durationMs, targetHealth, dangerRadius } = parsed.data;
    if (this.world.gameMode !== "survival") throw new SimulatedActionError("Resting is only modelled in survival mode.", "GAME_MODE_BLOCKS_REST");
    const healthBefore = this.world.health;
    let elapsed = 0;
    let stopReason: "target" | "duration" = "duration";
    while (elapsed < durationMs) {
      if (this.world.hostilesNear(this.world.playerX, this.world.playerY, this.world.playerZ, dangerRadius)) {
        throw new SimulatedActionError(`A visible hostile entered the ${dangerRadius}-block rest radius.`, "REST_INTERRUPTED_BY_THREAT");
      }
      if (this.world.health < healthBefore) {
        throw new SimulatedActionError("The player took damage while resting.", "REST_INTERRUPTED_BY_DAMAGE");
      }
      if (this.world.health >= targetHealth) {
        stopReason = "target";
        break;
      }
      check();
      const step = Math.min(250, durationMs - elapsed);
      this.world.advance(step, check);
      elapsed += step;
    }
    const healthAfter = this.world.health;
    return {
      confirmed: healthAfter > healthBefore,
      confirmation: "simulated_health_increase_observed_during_rest",
      details: { stopReason, healthBefore, healthAfter, elapsedMs: elapsed },
    };
  }

  /** Equipped or carried pickaxe tier, so the tool check matches what the live adapter reads. */
  private heldPickaxeTier(): { tier: 0 | 1 | 2 | 3 | 4; name: string | null } {
    const items: { name: string }[] = [...this.world.inventory];
    for (const stack of Object.values(this.equipment)) if (stack) items.push({ name: stack.name });
    return bestPickaxeTier(items);
  }

  private mine(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftMineBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid mining target.", "INVALID_ACTION_INPUT");
    const { x, y, z, blockName, dangerRadius } = parsed.data;
    if (this.world.gameMode !== "survival") {
      throw new SimulatedActionError("Mining requires survival mode.", "GAME_MODE_BLOCKS_MINING");
    }
    const requirement = canMineWithTier(blockName, this.heldPickaxeTier().tier);
    const observed = this.world.blockAt(x, y, z);
    if (!observed || observed.name !== blockName) {
      throw new SimulatedActionError("The requested block is unknown or has changed.", "RESOURCE_TARGET_CHANGED");
    }
    if (!requirement.mineable) {
      throw new SimulatedActionError(requirement.reason, requirement.code);
    }
    const player = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    const centre = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    if (distance3(player, centre) > MAX_RESOURCE_GATHER_DISTANCE) {
      throw new SimulatedActionError("The block is out of the mining range.", "RESOURCE_TARGET_TOO_FAR");
    }
    if (this.world.hostilesNear(centre.x, centre.y, centre.z, dangerRadius)) {
      throw new SimulatedActionError(
        `A currently visible hostile is within ${dangerRadius} blocks of the mining target.`,
        "RESOURCE_TARGET_THREATENED",
      );
    }
    const drop = minecraftMiningRequirements[blockName].drop;
    if (this.world.isInventoryFull(this.world.countItem(drop) > 0 ? drop : undefined)) {
      throw new SimulatedActionError("The inventory has no slot for the mined drop.", "INVENTORY_FULL");
    }
    if (distance3(player, centre) > 4) {
      const path = this.pathNear({ x, y, z }, 1.5);
      if (!path) throw new SimulatedActionError("No path to a cell adjacent to the block.", "PATH_NOT_FOUND");
      this.walkPath(path, check);
    }
    if (distance3({ x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ }, centre) > 5.5) {
      throw new SimulatedActionError("The block is outside reach after navigation.", "BLOCK_OUT_OF_REACH");
    }
    check();
    const digMs = Math.round(estimatedDigSeconds(blockName, this.heldPickaxeTier().tier) * 1_000);
    this.world.advance(digMs, check);
    const before = this.world.countItem(drop);
    if (this.world.blockAt(x, y, z)?.name === blockName) {
      this.world.setBlock(x, y, z, null);
      try {
        this.world.addToInventory(drop, 1);
      } catch (error) {
        if (error instanceof SimulatedActionError && error.code === "INVENTORY_FULL") {
          this.world.addItem(drop, 1, Math.floor(x), Math.floor(z));
        } else {
          throw error;
        }
      }
    }
    const after = this.world.countItem(drop);
    return {
      confirmed: after > before,
      confirmation: "simulated_mined_drop_inventory_delta_checked",
      details: { blockName, drop, coordinates: { x, y, z }, inventoryBefore: before, inventoryAfter: after, digMs },
    };
  }

  private placeBlock(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftPlaceBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid block placement target.", "INVALID_ACTION_INPUT");
    const { x, y, z, blockName, dangerRadius } = parsed.data;
    return this.placeOne(x, y, z, blockName, dangerRadius, check);
  }

  /** Shared placement rules; the crafting-table skill uses the same safety checks. */
  private placeOne(
    x: number,
    y: number,
    z: number,
    blockName: string,
    dangerRadius: number,
    check: () => void,
  ): AdapterActionOutcome {
    if (this.world.gameMode !== "survival") {
      throw new SimulatedActionError(`Placing ${blockName} requires survival mode.`, "GAME_MODE_BLOCKS_PLACEMENT");
    }
    if (this.world.countItem(blockName) < 1) {
      throw new SimulatedActionError(`Inventory does not contain ${blockName}.`, "PLACEMENT_BLOCK_NOT_IN_INVENTORY");
    }
    const destination = this.world.blockAt(x, y, z);
    if (!destination || destination.name !== "air") {
      throw new SimulatedActionError("Placement destination is unknown or occupied.", "PLACEMENT_CELL_NOT_EMPTY");
    }
    const support = this.world.blockAt(x, y - 1, z);
    if (!support || support.boundingBox !== "block" || UNSAFE_SUPPORT_NAMES.has(support.name)) {
      throw new SimulatedActionError("Placement destination has no safe solid support block.", "PLACEMENT_SUPPORT_UNSAFE");
    }
    const player = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    if (distance3(player, { x: x + 0.5, y: y + 0.5, z: z + 0.5 }) > MAX_PLACEMENT_DISTANCE) {
      throw new SimulatedActionError("Placement target is out of reach.", "PLACEMENT_TARGET_TOO_FAR");
    }
    if (Math.hypot(player.x - (x + 0.5), player.z - (z + 0.5)) < 0.9 && Math.abs(player.y - y) < 2) {
      throw new SimulatedActionError(`Placing ${blockName} here would intersect the player.`, "PLACEMENT_INTERSECTS_PLAYER");
    }
    if (this.world.hostilesNear(x + 0.5, y + 0.5, z + 0.5, dangerRadius)) {
      throw new SimulatedActionError(
        `A currently visible hostile is within ${dangerRadius} blocks of the placement cell.`,
        "PLACEMENT_TARGET_THREATENED",
      );
    }
    check();
    this.world.advance(200, check);
    this.world.removeFromInventory(blockName, 1);
    this.world.setBlock(x, y, z, blockName);
    const placed = this.world.blockAt(x, y, z)?.name === blockName;
    return {
      confirmed: placed,
      confirmation: "simulated_block_read_back_after_placement",
      details: { position: { x, y, z }, blockName },
    };
  }

  private buildShelter(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftBuildShelterInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid shelter request.", "INVALID_ACTION_INPUT");
    const { mode, maxBlocks, dangerRadius } = parsed.data;
    if (this.world.gameMode !== "survival") {
      throw new SimulatedActionError("Building a shelter requires survival mode.", "GAME_MODE_BLOCKS_PLACEMENT");
    }
    const placeable = this.placeableCounts();
    if (placeable.size === 0) {
      throw new SimulatedActionError("No placeable blocks are in the inventory.", "SHELTER_NO_BLOCKS");
    }
    const directions = mode === "cardinal" ? SHELTER_CARDINAL_DIRECTIONS : SHELTER_DIRECTIONS;
    const feetX = Math.floor(this.world.playerX);
    const feetY = Math.floor(this.world.playerY);
    const feetZ = Math.floor(this.world.playerZ);
    const placed: Array<{ x: number; y: number; z: number; blockName: string }> = [];
    const skipped: Array<{ x: number; y: number; z: number; reason: string }> = [];
    for (const [dx, dz] of directions) {
      if (placed.length >= maxBlocks) break;
      const x = feetX + dx;
      const z = feetZ + dz;
      const y = feetY;
      const cell = this.world.blockAt(x, y, z);
      if (!cell) {
        skipped.push({ x, y, z, reason: "unknown" });
        continue;
      }
      if (cell.boundingBox === "block") {
        skipped.push({ x, y, z, reason: "occupied" });
        continue;
      }
      const support = this.world.blockAt(x, y - 1, z);
      if (!support || support.boundingBox !== "block" || UNSAFE_SUPPORT_NAMES.has(support.name)) {
        skipped.push({ x, y, z, reason: "no-support" });
        continue;
      }
      if (this.world.hostilesNear(x + 0.5, y + 0.5, z + 0.5, dangerRadius)) {
        skipped.push({ x, y, z, reason: "threatened" });
        continue;
      }
      const blockName = [...placeable.entries()].find(([, count]) => count > 0)?.[0];
      if (!blockName) {
        skipped.push({ x, y, z, reason: "no-blocks-left" });
        break;
      }
      try {
        this.placeOne(x, y, z, blockName, dangerRadius, check);
        placeable.set(blockName, (placeable.get(blockName) ?? 1) - 1);
        placed.push({ x, y, z, blockName });
      } catch (error) {
        skipped.push({
          x,
          y,
          z,
          reason: error instanceof SimulatedActionError ? error.code : "placement-failed",
        });
      }
    }
    const solidCardinal = cardinalSolidCount(this.world);
    return {
      confirmed: placed.length > 0,
      confirmation: "simulated_shelter_blocks_read_back",
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

  private placeableCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const name of ["dirt", "cobblestone", "granite", "andesite", "diorite", "cobbled_deepslate", "oak_planks", "birch_planks", "spruce_planks"]) {
      const count = this.world.countItem(name);
      if (count > 0) counts.set(name, count);
    }
    return counts;
  }

  private attack(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftAttackHostileInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid attack request.", "INVALID_ACTION_INPUT");
    const { entityId, maxHits, dangerRadius, minHealth, retreatHealth, requiredDamage } = parsed.data;
    if (!this.combatEnabled) {
      throw new SimulatedActionError(
        "Combat is disabled for this run; the safety broker must opt the capability in explicitly.",
        "COMBAT_DISABLED",
      );
    }
    const hostile = this.world.hostileById(entityId);
    if (!hostile) throw new SimulatedActionError("The target entity is no longer observed.", "COMBAT_TARGET_GONE");
    const player = { x: this.world.playerX, y: this.world.playerY, z: this.world.playerZ };
    const targetDistance = Math.hypot(hostile.x - player.x, player.y - this.world.standingY, hostile.z - player.z);
    const nearby = this.world.hostileCountNear(player.x, this.world.standingY, player.z, dangerRadius * 1.5);
    const hand = this.equipment.hand;
    const weaponName = hand?.name ?? null;
    const verdict = combatIsAllowed({
      enabled: true,
      health: this.world.health,
      minHealth,
      retreatHealth,
      hostileCountNearby: nearby,
      maxEngageableHostiles: 1,
      weapon: weaponName === null ? null : { name: weaponName, damage: weaponDamageFor(weaponName) },
      requiredDamage,
      targetDistance,
      maxTargetDistance: 4,
      hitsAlreadyAttempted: 0,
      maxHits,
      hostileName: hostile.name,
      hostileType: "hostile",
      hunger: this.world.food,
    });
    if (!verdict.allowed) throw new SimulatedActionError(verdict.reason, verdict.code);

    let hits = 0;
    let health = hostile.health;
    let killed = false;
    while (hits < maxHits) {
      check();
      if (this.world.health <= retreatHealth) {
        throw new SimulatedActionError(
          `Health fell to ${this.world.health.toFixed(1)} while fighting; withdrawing instead of swinging again.`,
          "COMBAT_WITHDRAWN",
        );
      }
      const current = this.world.hostileById(entityId);
      if (!current) {
        killed = true;
        break;
      }
      if (Math.hypot(current.x - this.world.playerX, current.z - this.world.playerZ) > 4) {
        throw new SimulatedActionError("The hostile left melee range; the fight is broken off.", "COMBAT_TARGET_OUT_OF_RANGE");
      }
      this.world.advance(250, check);
      hits += 1;
      const result = this.world.damageHostile(entityId, weaponDamageFor(weaponName));
      if (!result) {
        killed = true;
        break;
      }
      health = result.health;
      if (result.died) {
        killed = true;
        break;
      }
    }
    return {
      confirmed: killed,
      confirmation: killed
        ? "simulated_hostile_removed_from_entity_list"
        : "simulated_hostile_still_present",
      details: { entityId, hits, healthAfter: health, killed },
    };
  }

  private dropItem(input: unknown, check: () => void): AdapterActionOutcome {
    const parsed = minecraftDropItemInputSchema.safeParse(input);
    if (!parsed.success) throw new SimulatedActionError("Invalid drop request.", "INVALID_ACTION_INPUT");
    const { itemName, count } = parsed.data;
    const before = this.world.countItem(itemName);
    if (before < count) {
      throw new SimulatedActionError(`Inventory holds ${before} ${itemName}, fewer than the ${count} requested.`, "ITEM_NOT_IN_INVENTORY");
    }
    check();
    this.world.removeFromInventory(itemName, count);
    // Thrown toward the player's facing, and held out of reach for a moment so the drop is observable
    // instead of being collected again inside the same tick.
    const ahead = this.dropTarget();
    this.world.addItem(itemName, count, ahead.x, ahead.z, PLAYER_DROP_PICKUP_DELAY_MS);
    this.world.advance(160, check);
    const after = this.world.countItem(itemName);
    return {
      confirmed: after === before - count,
      confirmation: "simulated_inventory_decrease_and_ground_drop_observed",
      details: { itemName, before, after, dropped: count },
    };
  }

  /** Where a tossed item lands: one block ahead of the player's facing. */
  private dropTarget(): { x: number; z: number } {
    const yaw = (this.yaw ?? 0) * (Math.PI / 180);
    return {
      x: Math.floor(this.world.playerX + Math.sin(yaw)),
      z: Math.floor(this.world.playerZ + Math.cos(yaw)),
    };
  }

  private transition(status: AdapterStatus, reason: string | null, sessionIdOverride?: string | null): void {
    this.statusValue = status;
    const change: AdapterStatusChange = {
      status,
      at: new Date().toISOString(),
      sessionId: sessionIdOverride === undefined ? this.sessionValue?.id ?? null : sessionIdOverride,
      reason,
    };
    for (const listener of this.listeners) listener(change);
  }
}
