import type {
  AdapterAction,
  AdapterActionOutcome,
  AdapterStatus,
  AdapterStatusChange,
  CapabilityDefinition,
  GameAdapter,
  GameObservation,
  GameSession,
} from "../core/types.js";
import type { MinecraftObservation } from "../games/minecraft/observation.js";
import { minecraftObservationSchema } from "../games/minecraft/observation.js";
import { isHostileMinecraftEntity } from "../games/minecraft/threats.js";
import {
  legacyMinecraftCapabilities,
  MINECRAFT_COLLECT_BLOCK_CAPABILITY,
  MINECRAFT_CRAFT_CAPABILITY,
  MINECRAFT_EAT_CAPABILITY,
  MINECRAFT_PLACE_TABLE_CAPABILITY,
  MINECRAFT_EQUIP_CAPABILITY,
  MINECRAFT_INSPECT_BLOCK_CAPABILITY,
  MINECRAFT_LOOK_CAPABILITY,
  MINECRAFT_NAVIGATE_CAPABILITY,
  minecraftCollectBlockInputSchema,
  minecraftCraftItemInputSchema,
  minecraftEatFoodInputSchema,
  minecraftPlaceTableInputSchema,
  minecraftEquipInputSchema,
  minecraftInspectBlockInputSchema,
  minecraftLookInputSchema,
  minecraftNavigateInputSchema,
} from "../games/minecraft/capabilities.js";

export interface FakeMinecraftAdapterOptions {
  readonly seed: number;
  readonly gameVersion?: string;
  readonly actionDelayMs?: number;
  readonly connectError?: Error;
  readonly initialObservation?: MinecraftObservation;
  /** Exact x,y,z navigation destinations that model walls or unavailable paths. */
  readonly unreachableNavigationTargets?: readonly string[];
  /** Test-only respawn after this many observations of a dead player. */
  readonly autoRespawnAfterObservations?: number;
}

function errorFromAbort(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Fake action aborted.");
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(errorFromAbort(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(errorFromAbort(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createFakeMinecraftFixture(seed: number): MinecraftObservation {
  const normalizedSeed = Math.abs(Math.trunc(seed));
  const x = (normalizedSeed % 13) - 6;
  const z = (Math.floor(normalizedSeed / 13) % 13) - 6;
  return {
    player: {
      username: "GameMind",
      position: { x: x + 0.5, y: 64, z: z + 0.5 },
      orientation: { yaw: 0, pitch: 0 },
      dimension: "overworld",
      gameMode: "survival",
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 300,
      onGround: true,
    },
    inventory: [],
    equipment: {
      hand: null,
      offhand: null,
      head: null,
      torso: null,
      legs: null,
      feet: null,
    },
    entities: [
      {
        id: `fixture-cow-${normalizedSeed}`,
        name: "cow",
        type: "mob",
        position: { x: x + 3, y: 64, z: z + 0.5 },
        distance: 2.5,
        health: null,
      },
    ],
    nearbyBlocks: [
      ...Array.from({ length: 25 }, (_, index) => {
        const dx = (index % 5) - 2;
        const dz = Math.floor(index / 5) - 2;
        return {
          position: { x: x + dx, y: 63, z: z + dz },
          name: "grass_block",
          type: 2,
          boundingBox: "block",
        };
      }),
      {
        position: { x: x + 1, y: 64, z },
        name: "oak_log",
        type: 17,
        boundingBox: "block",
      },
    ],
    resourceSightings: [],
    resourceScan: {
      radius: 24,
      limit: 64,
      center: { x: Math.floor(x + 0.5), y: 64, z: Math.floor(z + 0.5) },
      truncated: false,
    },
    itemDrops: [],
    sampledRegion: {
      radius: 3,
      verticalRadius: 2,
      center: { x: Math.floor(x + 0.5), y: 64, z: Math.floor(z + 0.5) },
      sampledCells: 245,
      unknownCells: 0,
      truncated: false,
    },
  };
}

function inventoryCount(state: MinecraftObservation, itemName: string): number {
  return state.inventory
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

function sameBlockPosition(
  block: MinecraftObservation["nearbyBlocks"][number],
  x: number,
  y: number,
  z: number,
): boolean {
  return block.position.x === x && block.position.y === y && block.position.z === z;
}


const fakeItemTypes: Record<string, number> = {
  oak_log: 17,
  birch_log: 17,
  spruce_log: 17,
  jungle_log: 17,
  acacia_log: 162,
  dark_oak_log: 162,
  mangrove_log:  17,
  cherry_log:  17,
  pale_oak_log:  17,
  oak_planks: 5,
  birch_planks: 5,
  spruce_planks: 5,
  jungle_planks: 5,
  acacia_planks: 5,
  dark_oak_planks: 5,
  mangrove_planks: 5,
  cherry_planks: 5,
  pale_oak_planks: 5,
  stick: 280,
  crafting_table: 58,
  wooden_pickaxe: 270,
  wooden_axe: 271,
  wooden_shovel: 269,
  wooden_sword: 268,
};

const fakeRecipes: Record<string, { outputCount: number; ingredients: Record<string, number>; requiresCraftingTable: boolean }> = {
  oak_planks: { outputCount: 4, ingredients: { oak_log: 1 }, requiresCraftingTable: false },
  birch_planks: { outputCount: 4, ingredients: { birch_log: 1 }, requiresCraftingTable: false },
  spruce_planks: { outputCount: 4, ingredients: { spruce_log: 1 }, requiresCraftingTable: false },
  jungle_planks: { outputCount: 4, ingredients: { jungle_log: 1 }, requiresCraftingTable: false },
  acacia_planks: { outputCount: 4, ingredients: { acacia_log: 1 }, requiresCraftingTable: false },
  dark_oak_planks: { outputCount: 4, ingredients: { dark_oak_log: 1 }, requiresCraftingTable: false },
  mangrove_planks: { outputCount: 4, ingredients: { mangrove_log: 1 }, requiresCraftingTable: false },
  cherry_planks: { outputCount: 4, ingredients: { cherry_log: 1 }, requiresCraftingTable: false },
  pale_oak_planks: { outputCount: 4, ingredients: { pale_oak_log: 1 }, requiresCraftingTable: false },
  stick: { outputCount: 4, ingredients: { any_planks: 2 }, requiresCraftingTable: false },
  crafting_table: { outputCount: 1, ingredients: { any_planks: 4 }, requiresCraftingTable: false },
  wooden_pickaxe: { outputCount: 1, ingredients: { any_planks: 3, stick: 2 }, requiresCraftingTable: true },
  wooden_axe: { outputCount: 1, ingredients: { any_planks: 3, stick: 2 }, requiresCraftingTable: true },
  wooden_shovel: { outputCount: 1, ingredients: { any_planks: 1, stick: 2 }, requiresCraftingTable: true },
  wooden_sword: { outputCount: 1, ingredients: { any_planks: 2, stick: 1 }, requiresCraftingTable: true },
};

const fakeFoodNutrition: Record<string, number> = {
  apple: 4,
  baked_potato: 5,
  bread: 5,
  carrot: 3,
  cooked_beef: 8,
  cooked_chicken: 6,
  cooked_cod: 5,
  cooked_mutton: 6,
  cooked_porkchop: 8,
  cooked_rabbit: 5,
  cooked_salmon: 6,
  cookie: 2,
  dried_kelp: 1,
  glow_berries: 2,
  golden_apple: 4,
  melon_slice: 2,
  mushroom_stew: 6,
  pumpkin_pie: 8,
  sweet_berries: 2,
};

function consumeStack(
  inventory: MinecraftObservation["inventory"],
  name: string,
  count: number,
): MinecraftObservation["inventory"] {
  let remaining = count;
  const result: MinecraftObservation["inventory"][number][] = [];
  for (const stack of inventory) {
    if (stack.name !== name || remaining <= 0) {
      result.push(stack);
      continue;
    }
    const take = Math.min(stack.count, remaining);
    remaining -= take;
    if (stack.count > take) result.push({ ...stack, count: stack.count - take });
  }
  if (remaining > 0) throw new Error(`Fake inventory is missing ${remaining} '${name}'.`);
  return result;
}

function addStack(
  inventory: MinecraftObservation["inventory"],
  name: string,
  type: number,
  count: number,
): MinecraftObservation["inventory"] {
  const result = [...inventory];
  const existing = result.findIndex((stack) => stack.name === name);
  if (existing >= 0) {
    const stack = result[existing];
    if (stack) result[existing] = { ...stack, count: stack.count + count };
  } else {
    result.push({
      slot: Math.max(8, ...result.map((stack) => stack.slot)) + 1,
      name,
      type,
      count,
      metadata: null,
      durabilityUsed: null,
    });
  }
  return result;
}

export class FakeMinecraftAdapter implements GameAdapter<MinecraftObservation> {
  readonly gameId = "minecraft-java";
  /** The legacy fixture implements only the original capability surface. */
  readonly capabilities: readonly CapabilityDefinition[] = legacyMinecraftCapabilities;

  private statusValue: AdapterStatus = "disconnected";
  private sessionValue: GameSession | null = null;
  private stateValue: MinecraftObservation;
  private sequence = 0;
  private deadObservationCount = 0;
  private connectionCount = 0;
  private activeActionId: string | null = null;
  private activeActionWaiters: Array<() => void> = [];
  private nextActionError: Error | null = null;
  private nextNavigationError: Error | null = null;
  private readonly listeners = new Set<(change: AdapterStatusChange) => void>();

  constructor(private readonly options: FakeMinecraftAdapterOptions) {
    this.stateValue = minecraftObservationSchema.parse(
      structuredClone(options.initialObservation ?? createFakeMinecraftFixture(options.seed)),
    );
  }

  get status(): AdapterStatus {
    return this.statusValue;
  }

  get session(): GameSession | null {
    return this.statusValue === "connected" ? this.sessionValue : null;
  }

  onStatusChange(listener: (change: AdapterStatusChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<GameSession> {
    if (this.session && this.statusValue === "connected") return this.session;
    this.transition("connecting", null);
    if (this.options.connectError) {
      this.transition("failed", this.options.connectError.message);
      throw this.options.connectError;
    }

    this.sequence = 0;
    this.connectionCount += 1;
    const session: GameSession = {
      id: `fake-${this.options.seed}-${this.connectionCount}`,
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
    if (!session) throw new Error("Fake Minecraft adapter is not connected.");
    if (this.stateValue.player.alive === false || (this.stateValue.player.health ?? 0) <= 0) {
      this.deadObservationCount += 1;
      const respawnAfter = this.options.autoRespawnAfterObservations;
      if (respawnAfter !== undefined && this.deadObservationCount >= respawnAfter) {
        this.stateValue = {
          ...this.stateValue,
          player: { ...this.stateValue.player, alive: true, health: 20 },
        };
      }
    }
    return {
      schemaVersion: 1,
      gameId: this.gameId,
      gameVersion: session.gameVersion,
      sessionId: session.id,
      sequence: this.sequence++,
      observedAt: new Date().toISOString(),
      state: structuredClone(this.stateValue),
    };
  }

  async executeAction(
    action: AdapterAction,
    signal: AbortSignal,
  ): Promise<AdapterActionOutcome> {
    if (this.statusValue !== "connected" || this.sessionValue?.id !== action.sessionId) {
      throw new Error("Fake adapter received an action for a disconnected session.");
    }
    if (this.activeActionId && this.activeActionId !== action.actionId) {
      throw new Error("Fake adapter already has an active action.");
    }

    this.activeActionId = action.actionId;
    for (const resolve of this.activeActionWaiters.splice(0)) resolve();
    try {
      if ((this.options.actionDelayMs ?? 0) > 0) {
        await waitWithAbort(this.options.actionDelayMs ?? 0, signal);
      }
      if (signal.aborted) throw errorFromAbort(signal);
      if (this.nextActionError) {
        const failure = this.nextActionError;
        this.nextActionError = null;
        throw failure;
      }

      switch (action.capability) {
        case MINECRAFT_LOOK_CAPABILITY:
          return this.look(action.input);
        case MINECRAFT_INSPECT_BLOCK_CAPABILITY:
          return this.inspectBlock(action.input);
        case MINECRAFT_NAVIGATE_CAPABILITY:
          return this.navigate(action.input);
        case MINECRAFT_COLLECT_BLOCK_CAPABILITY:
          return this.collectBlock(action.input);
        case MINECRAFT_EQUIP_CAPABILITY:
          return this.equipItem(action.input);
        case MINECRAFT_CRAFT_CAPABILITY:
          return this.craftItem(action.input);
        case MINECRAFT_EAT_CAPABILITY:
          return this.eatFood(action.input);
        case MINECRAFT_PLACE_TABLE_CAPABILITY:
          return this.placeCraftingTable(action.input);
        default:
          throw new Error(`Fake adapter does not support '${action.capability}'.`);
      }
    } finally {
      if (this.activeActionId === action.actionId) this.activeActionId = null;
    }
  }

  failNextAction(error = new Error("Injected deterministic action failure.")): void {
    this.nextActionError = error;
  }

  failNextNavigation(error?: Error): void {
    this.nextNavigationError = error ?? Object.assign(
      new Error("Injected navigation made no progress."),
      { code: "NAVIGATION_STUCK" },
    );
  }

  waitForActionStart(timeoutMs = 2_000): Promise<void> {
    if (this.activeActionId) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.activeActionWaiters.indexOf(waiter);
        if (index >= 0) this.activeActionWaiters.splice(index, 1);
        reject(new Error("Timed out waiting for the fake adapter action to start."));
      }, timeoutMs);
      this.activeActionWaiters.push(waiter);
    });
  }

  async cancelActiveAction(actionId: string, _reason: string): Promise<void> {
    if (this.activeActionId === actionId) this.activeActionId = null;
  }

  async disconnect(reason = "fake adapter shutdown"): Promise<void> {
    const endedSessionId = this.sessionValue?.id ?? null;
    this.sessionValue = null;
    if (this.statusValue !== "disconnected") {
      this.transition("disconnected", reason, endedSessionId);
    }
  }

  private look(input: unknown): AdapterActionOutcome {
    const parsed = minecraftLookInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid look input.");
    this.stateValue = {
      ...this.stateValue,
      player: {
        ...this.stateValue.player,
        orientation: { yaw: parsed.data.yaw, pitch: parsed.data.pitch },
      },
    };
    return {
      confirmed: true,
      confirmation: "fake_world_state_updated",
      details: { requestedYaw: parsed.data.yaw, requestedPitch: parsed.data.pitch },
    };
  }

  private inspectBlock(input: unknown): AdapterActionOutcome {
    const parsed = minecraftInspectBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid block coordinates.");
    const block = this.stateValue.nearbyBlocks.find((candidate) =>
      sameBlockPosition(candidate, parsed.data.x, parsed.data.y, parsed.data.z),
    );
    if (!block) throw new Error("Fake fixture has no known block at that coordinate.");
    return {
      confirmed: true,
      confirmation: "fixture_block_observation",
      details: { block },
    };
  }

  private navigate(input: unknown): AdapterActionOutcome {
    const parsed = minecraftNavigateInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid navigation input.");
    if (this.nextNavigationError) {
      const failure = this.nextNavigationError;
      this.nextNavigationError = null;
      throw failure;
    }
    const before = this.stateValue.player.position;
    const targetKey = `${parsed.data.x},${parsed.data.y},${parsed.data.z}`;
    if (this.options.unreachableNavigationTargets?.includes(targetKey)) {
      throw Object.assign(new Error(`Fixture obstacle prevents navigation to ${targetKey}.`), {
        code: "PATH_NOT_FOUND",
      });
    }
    const distance = Math.hypot(
      before.x - (parsed.data.x + 0.5),
      before.y - parsed.data.y,
      before.z - (parsed.data.z + 0.5),
    );
    if (distance > 48) throw new Error("Fake navigation target exceeded the safe distance limit.");
    this.stateValue = {
      ...this.stateValue,
      player: {
        ...this.stateValue.player,
        position: { x: parsed.data.x + 0.5, y: parsed.data.y, z: parsed.data.z + 0.5 },
      },
    };
    return {
      confirmed: true,
      confirmation: "fixture_position_reached",
      details: { from: before, to: this.stateValue.player.position },
    };
  }

  private collectBlock(input: unknown): AdapterActionOutcome {
    const parsed = minecraftCollectBlockInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid resource target.");
    const index = this.stateValue.nearbyBlocks.findIndex((candidate) =>
      sameBlockPosition(candidate, parsed.data.x, parsed.data.y, parsed.data.z),
    );
    const block = this.stateValue.nearbyBlocks[index];
    if (!block || block.name !== parsed.data.blockName) {
      throw new Error("The requested resource block is not present in the fixture.");
    }
    if (this.stateValue.player.dimension !== "overworld") throw new Error("Fake log collection is overworld-only.");
    if (this.stateValue.player.gameMode !== "survival") throw new Error("Fake log collection requires survival mode.");
    if (Math.hypot(
      this.stateValue.player.position.x - (block.position.x + 0.5),
      this.stateValue.player.position.y - (block.position.y + 0.5),
      this.stateValue.player.position.z - (block.position.z + 0.5),
    ) > 24) throw new Error("Fake log is outside the resource-gather distance limit.");
    const targetCenter = {
      x: block.position.x + 0.5,
      y: block.position.y + 0.5,
      z: block.position.z + 0.5,
    };
    if (this.stateValue.entities.some((entity) =>
      isHostileMinecraftEntity(entity.name, entity.type) &&
      Math.hypot(
        entity.position.x - targetCenter.x,
        entity.position.y - targetCenter.y,
        entity.position.z - targetCenter.z,
      ) <= parsed.data.dangerRadius,
    )) {
      throw Object.assign(new Error("A hostile is too close to the requested resource block."), {
        code: "RESOURCE_TARGET_THREATENED",
      });
    }
    const beforeCount = inventoryCount(this.stateValue, block.name);
    const inventory = [...this.stateValue.inventory];
    const existing = inventory.find((item) => item.name === block.name);
    if (existing) {
      const slot = inventory.indexOf(existing);
      inventory[slot] = { ...existing, count: existing.count + 1 };
    } else {
      inventory.push({
        slot: inventory.length,
        name: block.name,
        type: block.type,
        count: 1,
        metadata: null,
        durabilityUsed: null,
      });
    }
    this.stateValue = {
      ...this.stateValue,
      inventory,
      nearbyBlocks: this.stateValue.nearbyBlocks.filter((_, blockIndex) => blockIndex !== index),
      player: {
        ...this.stateValue.player,
        position: {
          x: parsed.data.x + 0.5,
          y: Math.max(this.stateValue.player.position.y, parsed.data.y + 1),
          z: parsed.data.z + 0.5,
        },
      },
    };
    return {
      confirmed: inventoryCount(this.stateValue, block.name) > beforeCount,
      confirmation: "fixture_inventory_delta_and_block_removed",
      details: {
        blockName: block.name,
        coordinates: block.position,
        inventoryBefore: beforeCount,
        inventoryAfter: inventoryCount(this.stateValue, block.name),
      },
    };
  }

  private craftItem(input: unknown): AdapterActionOutcome {
    const parsed = minecraftCraftItemInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid craft request.");
    const { item, count, craftingTable } = parsed.data;
    if (this.stateValue.player.gameMode !== "survival") throw new Error("Fake crafting requires survival mode.");
    const rule = fakeRecipes[item];
    if (!rule) throw new Error(`Fake recipe '${item}' is unsupported.`);
    const before = inventoryCount(this.stateValue, item);
    if (before >= count) {
      return {
        confirmed: true,
        confirmation: "fake_requested_craft_count_already_present",
        details: { item, requestedCount: count, inventoryBefore: before, inventoryAfter: before },
      };
    }
    if (rule.requiresCraftingTable) {
      const table = craftingTable && this.stateValue.nearbyBlocks.find((block) =>
        sameBlockPosition(block, craftingTable.x, craftingTable.y, craftingTable.z) && block.name === "crafting_table",
      );
      if (!table) throw new Error("Fake recipe requires an observed nearby crafting table.");
      const distance = Math.hypot(
        this.stateValue.player.position.x - table.position.x,
        this.stateValue.player.position.y - table.position.y,
        this.stateValue.player.position.z - table.position.z,
      );
      if (distance > 4.5) throw new Error("Fake crafting table is too far away.");
    }
    const runs = Math.ceil((count - before) / rule.outputCount);
    let inventory = [...this.stateValue.inventory];
    const consumed: Record<string, number> = {};
    for (const [ingredient, quantity] of Object.entries(rule.ingredients)) {
      const total = quantity * runs;
      if (ingredient === "any_planks") {
        let remaining = total;
        for (const plank of [...inventory].filter((stack) => stack.name.endsWith("_planks"))) {
          const take = Math.min(remaining, plank.count);
          if (take <= 0) continue;
          inventory = consumeStack(inventory, plank.name, take);
          consumed[plank.name] = (consumed[plank.name] ?? 0) + take;
          remaining -= take;
          if (remaining === 0) break;
        }
        if (remaining > 0) throw new Error("Fake recipe is missing plank ingredients.");
      } else {
        if (inventoryCount({ ...this.stateValue, inventory } as MinecraftObservation, ingredient) < total) {
          throw new Error(`Fake recipe is missing '${ingredient}'.`);
        }
        inventory = consumeStack(inventory, ingredient, total);
        consumed[ingredient] = (consumed[ingredient] ?? 0) + total;
      }
    }
    inventory = addStack(inventory, item, fakeItemTypes[item]!, rule.outputCount * runs);
    const after = inventoryCount({ ...this.stateValue, inventory } as MinecraftObservation, item);
    this.stateValue = { ...this.stateValue, inventory };
    return {
      confirmed: after >= count,
      confirmation: "fake_crafting_inventory_delta_checked",
      details: { item, requestedCount: count, inventoryBefore: before, inventoryAfter: after, runs, consumed, craftingTable },
    };
  }

  private eatFood(input: unknown): AdapterActionOutcome {
    const parsed = minecraftEatFoodInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid food request.");
    if (this.stateValue.player.gameMode !== "survival") throw new Error("Fake eating requires survival mode.");
    if (this.stateValue.player.food === null || this.stateValue.player.food >= 20) {
      throw new Error("Fake player hunger is full or unknown.");
    }
    const before = this.stateValue.player.food;
    const countBefore = inventoryCount(this.stateValue, parsed.data.item);
    if (countBefore < 1) throw new Error(`Fake inventory does not contain '${parsed.data.item}'.`);
    const nutrition = fakeFoodNutrition[parsed.data.item]!;
    const inventory = consumeStack(this.stateValue.inventory, parsed.data.item, 1);
    const after = Math.min(20, before + nutrition);
    this.stateValue = {
      ...this.stateValue,
      inventory,
      player: { ...this.stateValue.player, food: after },
    };
    const countAfter = inventoryCount(this.stateValue, parsed.data.item);
    return {
      confirmed: after > before && countAfter < countBefore,
      confirmation: "fake_hunger_and_inventory_delta_checked",
      details: { item: parsed.data.item, hungerBefore: before, hungerAfter: after, countBefore, countAfter },
    };
  }

  private placeCraftingTable(input: unknown): AdapterActionOutcome {
    const parsed = minecraftPlaceTableInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid table placement request.");
    const { x, y, z } = parsed.data;
    if (this.stateValue.player.gameMode !== "survival") throw new Error("Fake table placement requires survival mode.");
    const target = this.stateValue.nearbyBlocks.find((block) => sameBlockPosition(block, x, y, z));
    if (target) throw new Error("Fake crafting-table destination is occupied.");
    const support = this.stateValue.nearbyBlocks.find((block) => sameBlockPosition(block, x, y - 1, z));
    if (
      !support ||
      support.boundingBox !== "block" ||
      ["lava", "water", "fire", "soul_fire", "magma_block", "cactus"].includes(support.name)
    ) throw new Error("Fake placement support is not safe and solid.");
    if (inventoryCount(this.stateValue, "crafting_table") < 1) throw new Error("Fake inventory has no crafting table.");
    const targetCenter = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    if (this.stateValue.entities.some((entity) =>
      isHostileMinecraftEntity(entity.name, entity.type) &&
      Math.hypot(
        entity.position.x - targetCenter.x,
        entity.position.y - targetCenter.y,
        entity.position.z - targetCenter.z,
      ) <= parsed.data.dangerRadius,
    )) throw new Error("Fake crafting-table destination is too close to a hostile.");
    const player = this.stateValue.player.position;
    if (Math.hypot(player.x - (x + 0.5), player.y - (y + 0.5), player.z - (z + 0.5)) > 4.5) {
      throw new Error("Fake crafting-table target is too far away.");
    }
    if (Math.hypot(player.x - (x + 0.5), player.z - (z + 0.5)) < 0.9) {
      throw new Error("Fake table placement intersects the player.");
    }
    const inventory = consumeStack(this.stateValue.inventory, "crafting_table", 1);
    this.stateValue = {
      ...this.stateValue,
      inventory,
      nearbyBlocks: [
        ...this.stateValue.nearbyBlocks,
        { position: { x, y, z }, name: "crafting_table", type: fakeItemTypes.crafting_table!, boundingBox: "block" },
      ],
    };
    return {
      confirmed: true,
      confirmation: "fake_table_block_and_inventory_delta_checked",
      details: { position: { x, y, z }, inventoryAfter: inventoryCount(this.stateValue, "crafting_table") },
    };
  }

  private equipItem(input: unknown): AdapterActionOutcome {
    const parsed = minecraftEquipInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Fake adapter rejected invalid equipment request.");
    const itemIndex = this.stateValue.inventory.findIndex((item) => item.name === parsed.data.item);
    if (itemIndex < 0) throw new Error(`Inventory does not contain '${parsed.data.item}'.`);
    const inventory = [...this.stateValue.inventory];
    const selected = inventory[itemIndex];
    if (!selected) throw new Error("Selected inventory item disappeared.");
    const equipmentKey = parsed.data.destination === "off-hand" ? "offhand" : parsed.data.destination;
    const previous = this.stateValue.equipment[equipmentKey];
    if (selected.count === 1) inventory.splice(itemIndex, 1);
    else inventory[itemIndex] = { ...selected, count: selected.count - 1 };
    if (previous) {
      const existing = inventory.find((item) => item.name === previous.name);
      if (existing) {
        const slot = inventory.indexOf(existing);
        inventory[slot] = { ...existing, count: existing.count + previous.count };
      } else inventory.push(previous);
    }
    const equipment = {
      ...this.stateValue.equipment,
      [equipmentKey]: {
        ...selected,
        slot: ({ hand: 0, "off-hand": 45, head: 5, torso: 6, legs: 7, feet: 8 } as const)[parsed.data.destination],
        count: 1,
      },
    };
    this.stateValue = { ...this.stateValue, inventory, equipment };
    return {
      confirmed: this.stateValue.equipment[equipmentKey]?.name === parsed.data.item,
      confirmation: "fixture_equipment_slot_matches",
      details: { item: parsed.data.item, destination: parsed.data.destination },
    };
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
          ? this.sessionValue?.id ?? null
          : sessionIdOverride,
      reason,
    };
    for (const listener of this.listeners) listener(change);
  }
}
