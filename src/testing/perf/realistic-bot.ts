/**
 * Builds a real Mineflayer `Bot` object with a deterministic, populated world and no network connection.
 *
 * It is not a Minecraft server and it does not prove protocol behaviour. What it gives the performance
 * harness and the regression tests is the *real* Mineflayer block, raycast and findBlocks code running over
 * a world with realistic block density (hills, trees, a water pool, ore), so timings measured against it
 * reflect what the adapter pays per observation instead of what a flat test double would cost.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";

const require = createRequire(import.meta.url);

export interface RealisticWorldOptions {
  /** Chunks in each direction from the origin chunk (radius 2 = 5x5 chunks = 80 blocks wide). */
  readonly chunkRadius?: number;
  /** Seed for the deterministic terrain generator. */
  readonly seed?: number;
  /** Spawn position of the bot; defaults to the origin on the ground surface. */
  readonly spawn?: { readonly x: number; readonly y: number; readonly z: number };
}

/** Small deterministic PRNG so the same seed always produces the same world. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RealisticBot {
  readonly bot: Bot;
  /** Surface height at the spawn column, so callers can place the player on the ground. */
  readonly groundY: number;
  /** Number of block states written, for the benchmark report. */
  readonly blocksWritten: number;
}

/**
 * Creates the bot and fills its loaded chunks. Mineflayer's blocks plugin is injected directly because the
 * normal path only installs it after a login packet, which this offline bot never receives.
 */
export function createRealisticBot(options: RealisticWorldOptions = {}): RealisticBot {
  const chunkRadius = options.chunkRadius ?? 2;
  const seed = options.seed ?? 1337;
  const random = mulberry32(seed);
  // A socket-free bot: `mineflayer.createBot` would open a TCP connection to the port above and fail
  // asynchronously, which the adapter would then correctly report as a lost session. The emitter below has the
  // same surface the blocks plugin and the adapter touch, and nothing is ever sent over it.
  const registry = require("prismarine-registry")("1.20.4");
  const bot = Object.assign(new EventEmitter(), {
    version: "1.20.4",
    registry,
    _client: new EventEmitter(),
    supportFeature: () => false,
    _getDimensionName: () => "minecraft:overworld",
    end: () => undefined,
    quit: () => undefined,
    // Session vitals as the live session reports them once packets arrive; a healthy, fed, unburdened player.
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    isAlive: true,
    time: { timeOfDay: 6_000, day: 1, isDay: true },
    heldItem: null,
    inventory: { items: () => [], slots: [], emptySlotCount: () => 36 },
    getEquipmentDestSlot: () => 0,
    entities: {},
  }) as unknown as Bot;

  const Vec3 = require("vec3").Vec3 as typeof import("vec3").Vec3;
  const World = require("prismarine-world")(bot.registry) as new (provider: null, storage: null) => { sync: { setColumn(x: number, z: number, column: unknown): void } & Bot["world"] };
  const Chunk = require("prismarine-chunk")(bot.registry) as new () => {
    setBlockStateId(position: InstanceType<typeof Vec3>, stateId: number): void;
  };
  const blocksPlugin = require("mineflayer/lib/plugins/blocks") as (bot: Bot, options: Record<string, unknown>) => void;

  const blockRegistry = registry as unknown as { blocksByName: Record<string, { defaultState: number }> };
  const state = (name: string): number => {
    const block = blockRegistry.blocksByName[name];
    if (!block) throw new Error(`Block '${name}' is not in the 1.20.4 registry.`);
    return block.defaultState;
  };
  const ids = {
    air: state("air"),
    stone: state("stone"),
    dirt: state("dirt"),
    grass: state("grass_block"),
    sand: state("sand"),
    water: state("water"),
    log: state("oak_log"),
    leaves: state("oak_leaves"),
    coal: state("coal_ore"),
    iron: state("iron_ore"),
  };

  const SEA_LEVEL = 62;
  const heightAt = (x: number, z: number): number => {
    const ridge = Math.sin(x * 0.19 + seed) * Math.cos(z * 0.23 - seed * 0.1);
    const roll = Math.sin((x + z) * 0.41) * 0.6;
    return Math.round(SEA_LEVEL + 2 + ridge * 4 + roll);
  };

  // `.sync` is the synchronous view of prismarine-world; the async view returns promises for every read.
  const world = new World(null, null).sync;
  bot.world = world;
  bot.game = { minY: 0, height: 256, dimension: "overworld", gameMode: "survival" } as unknown as Bot["game"];
  blocksPlugin(bot, { version: "1.20.4", hideErrors: true });
  bot.world = world;

  let blocksWritten = 0;
  const spawnX = options.spawn?.x ?? 0;
  const spawnZ = options.spawn?.z ?? 0;
  for (let cx = -chunkRadius; cx <= chunkRadius; cx += 1) {
    for (let cz = -chunkRadius; cz <= chunkRadius; cz += 1) {
      const column = new Chunk();
      for (let lx = 0; lx < 16; lx += 1) {
        for (let lz = 0; lz < 16; lz += 1) {
          const x = cx * 16 + lx;
          const z = cz * 16 + lz;
          const surface = heightAt(x, z);
          const inWaterPool = x >= 8 && x <= 14 && z >= -10 && z <= -4;
          const top = inWaterPool ? SEA_LEVEL - 2 : surface;
          for (let y = 0; y <= top; y += 1) {
            let stateId = ids.stone;
            if (y >= top - 3) stateId = inWaterPool ? ids.sand : y === top ? ids.grass : ids.dirt;
            else if (random() < 0.012) stateId = ids.coal;
            else if (random() < 0.004) stateId = ids.iron;
            column.setBlockStateId(new Vec3(lx, y, lz), stateId);
            blocksWritten += 1;
          }
          if (inWaterPool) {
            for (let y = top + 1; y <= SEA_LEVEL; y += 1) {
              column.setBlockStateId(new Vec3(lx, y, lz), ids.water);
              blocksWritten += 1;
            }
          }
        }
      }
      // Trees: a trunk and a leaf canopy on a sparse, deterministic grid, away from the water pool.
      for (let t = 0; t < 3; t += 1) {
        const lx = 2 + Math.floor(random() * 12);
        const lz = 2 + Math.floor(random() * 12);
        const x = cx * 16 + lx;
        const z = cz * 16 + lz;
        if (x >= 6 && x <= 16 && z >= -12 && z <= -2) continue;
        const base = heightAt(x, z) + 1;
        for (let dy = 0; dy < 5; dy += 1) {
          column.setBlockStateId(new Vec3(lx, base + dy, lz), ids.log);
          blocksWritten += 1;
        }
        for (let dx = -2; dx <= 2; dx += 1) {
          for (let dz = -2; dz <= 2; dz += 1) {
            for (let dy = 3; dy <= 5; dy += 1) {
              const nx = lx + dx;
              const nz = lz + dz;
              if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
              if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
              column.setBlockStateId(new Vec3(nx, base + dy, nz), ids.leaves);
              blocksWritten += 1;
            }
          }
        }
      }
      world.setColumn(cx, cz, column);
    }
  }
  // Mineflayer's findBlocks reads the world through the bot's dimension bounds.
  bot.game = { minY: 0, height: 256, dimension: "overworld", gameMode: "survival" } as unknown as Bot["game"];

  const groundY = heightAt(spawnX, spawnZ) + 1;
  // A zombie and a cow at fixed offsets, so the entity scan and the threat logic do real work.
  const Entity = (id: number, name: string, type: string, x: number, z: number) => ({
    id,
    name,
    type,
    position: new Vec3(spawnX + x, heightAt(spawnX + x, spawnZ + z) + 1, spawnZ + z),
    yaw: 0,
    pitch: 0,
    onGround: true,
    velocity: new Vec3(0, 0, 0),
    health: 20,
  });
  (bot as unknown as { entities: Record<number, unknown> }).entities = {
    2: Entity(2, "zombie", "hostile", 6.5, 0.5),
    3: Entity(3, "cow", "animal", -9.5, 4.5),
  };
  bot.entity = {
    id: 1,
    type: "player",
    username: "GameMindBench",
    name: "GameMindBench",
    position: new Vec3(spawnX + 0.5, groundY, spawnZ + 0.5),
    yaw: 0,
    pitch: 0,
    onGround: true,
    isInWater: false,
    eyeHeight: 1.62,
    height: 1.8,
    width: 0.6,
  } as unknown as Bot["entity"];
  (bot as unknown as { username: string }).username = "GameMindBench";
  return { bot, groundY, blocksWritten };
}
