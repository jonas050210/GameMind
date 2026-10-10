import { z } from "zod";

const vectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

const blockPositionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

const orientationSchema = z.object({
  yaw: z.number().finite(),
  pitch: z.number().finite(),
});

export const minecraftItemStackSchema = z.object({
  slot: z.number().int().nonnegative(),
  name: z.string(),
  type: z.number().int(),
  count: z.number().int().nonnegative(),
  metadata: z.number().int().nullable(),
  durabilityUsed: z.number().finite().nullable(),
});

export type MinecraftItemStack = z.infer<typeof minecraftItemStackSchema>;

/** A block of a resource class (log, crafting table, sweet berry bush) found by the wide scan. */
export const minecraftResourceSightingSchema = z.object({
  name: z.string(),
  position: blockPositionSchema,
  distance: z.number().finite().nonnegative(),
  /** Mineflayer line-of-sight result at observation time. Missing means the adapter could not test it. */
  visible: z.boolean().optional(),
  /** Only included for block classes whose state matters (sweet berry bush `age`). */
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type MinecraftResourceSighting = z.infer<typeof minecraftResourceSightingSchema>;

/** A dropped item entity, identified through Mineflayer's dropped-item metadata. */
export const minecraftItemDropSchema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number().int().positive(),
  position: vectorSchema,
  distance: z.number().finite().nonnegative(),
});

export type MinecraftItemDrop = z.infer<typeof minecraftItemDropSchema>;

/** Day-cycle information, used to decide when to prepare shelter before dark. */
export const minecraftTimeInfoSchema = z.object({
  /** Ticks into the current day cycle (Java Edition: 0 through 23999); null when only the day flag arrived. */
  dayTicks: z.number().finite().min(0).max(24_000).nullable(),
  /** Day counter as reported by the session; null when the session never sent one. */
  day: z.number().int().nonnegative().nullable(),
  isNight: z.boolean(),
  /** Which live field the night judgement came from, so a guess is never read as a measurement. */
  source: z.string().optional(),
});

export type MinecraftTimeInfo = z.infer<typeof minecraftTimeInfoSchema>;

const minecraftChunkCoordinateSchema = z.object({
  x: z.number().int(),
  z: z.number().int(),
});

/** One live session fact, with the evidence behind it. */
export const minecraftSessionFieldSchema = z.object({
  /** The value the agent will act on; null when the session did not report one it understands. */
  value: z.string().nullable(),
  /** `verified` needs two independent live sources agreeing; `unreported` means nothing usable arrived. */
  evidence: z.enum(["verified", "single-source", "unreported", "conflicting"]),
  source: z.string(),
  /** The raw values read from the session, formatted for a log line or tooltip. */
  observed: z.string(),
  note: z.string().nullable(),
});

export type MinecraftSessionField = z.infer<typeof minecraftSessionFieldSchema>;

export const minecraftObservationSchema = z.object({
  player: z.object({
    username: z.string(),
    position: vectorSchema,
    orientation: orientationSchema,
    /** Canonical dimension name (`overworld`, `the_nether`, `the_end`, or a server-provided name). */
    dimension: z.string().nullable(),
    /** Canonical game mode (`survival`, `hardcore`, `creative`, `adventure`, `spectator`). */
    gameMode: z.string().nullable(),
    health: z.number().finite().nullable(),
    food: z.number().finite().nullable(),
    foodSaturation: z.number().finite().nullable(),
    /** Air supply in **ticks** (0-300); 300 means full lungs. Null when the adapter cannot read it. */
    oxygenLevel: z.number().finite().nullable(),
    onGround: z.boolean(),
    /** Mineflayer's body-in-water flag (physics), null when the session did not report it. */
    inWater: z.boolean().nullable().optional(),
    /** True when the block at eye height is water. This is what drowning depends on. Null when unknown. */
    headInWater: z.boolean().nullable().optional(),
    /**
     * True when the world reports that no further item can enter the inventory. Only an explicit read-out
     * from the adapter counts: a planner that merely *guessed* the inventory was full could drop items the
     * agent still needs.
     */
    inventoryFull: z.boolean().optional(),
    /** Mineflayer's life state. Null/undefined means the session did not prove it; never a guess. */
    alive: z.boolean().nullable().optional(),
    /** Death events observed by this adapter process; a counter survives an automatic respawn. */
    deathCount: z.number().int().nonnegative().optional(),
    /**
     * How the dimension, game mode and vitals were obtained. The dashboard shows this verbatim so an
     * operator can tell "survival, verified" from "survival, guessed from one field".
     */
    session: z
      .object({
        dimension: minecraftSessionFieldSchema.optional(),
        gameMode: minecraftSessionFieldSchema.optional(),
        /** `update_health`/entity-metadata timestamps, so a vitals value can be called fresh or stale. */
        vitalsObservedAt: z.string().nullable().optional(),
        /** Whether the air figure is a measurement, and from which gauge. */
        airEvidence: z.enum(["verified", "single-source", "unreported", "conflicting"]).optional(),
        /** Raw session read-out of the vitals, for the diagnostic panel. */
        vitalsObserved: z.string().optional(),
      })
      .optional(),
  }),

  inventory: z.array(minecraftItemStackSchema),
  equipment: z.object({
    hand: minecraftItemStackSchema.nullable(),
    offhand: minecraftItemStackSchema.nullable(),
    head: minecraftItemStackSchema.nullable(),
    torso: minecraftItemStackSchema.nullable(),
    legs: minecraftItemStackSchema.nullable(),
    feet: minecraftItemStackSchema.nullable(),
  }),
  entities: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      position: vectorSchema,
      distance: z.number().finite().nonnegative(),
      health: z.number().finite().nullable(),
    }),
  ),
  /** Local cube around the scan center: every non-air block, nearest and resource blocks first. */
  nearbyBlocks: z.array(
    z.object({
      position: blockPositionSchema,
      name: z.string(),
      type: z.number().int(),
      boundingBox: z.string(),
      /** Distance from the player eye/entity position at this observation. */
      distance: z.number().finite().nonnegative().optional(),
      /** A real ray/line-of-sight result. Missing is unknown, never assumed visible. */
      visible: z.boolean().optional(),
    }),
  ),
  /** Resource-class blocks found in a wider radius; absence is only meaningful when not truncated. */
  resourceSightings: z.array(minecraftResourceSightingSchema),
  resourceScan: z.object({
    radius: z.number().finite().positive(),
    limit: z.number().int().positive(),
    center: blockPositionSchema,
    truncated: z.boolean(),
    /** Exact chunk columns the client currently has loaded inside the scan radius. Missing means unknown. */
    loadedChunks: z.array(minecraftChunkCoordinateSchema).optional(),
    /** Age of the scan result when it was reused from an earlier tick; 0 for a fresh scan. */
    ageMs: z.number().finite().nonnegative().optional(),
    /** True when this result was reused from the cache, not re-run this tick. */
    cached: z.boolean().optional(),
  }),
  /**
   * Mineable stone-class and ore blocks found by a second wide scan. Optional so older adapters and
   * fixtures stay valid; the planner treats "absent" as "not scanned", never as "nothing to mine".
   */
  minableSightings: z.array(minecraftResourceSightingSchema).optional(),
  minableScan: z
    .object({
      radius: z.number().finite().positive(),
      limit: z.number().int().positive(),
      center: blockPositionSchema,
      truncated: z.boolean(),
      /** True when the scanner could not distinguish the block state, e.g. an unloaded chunk. */
      approximate: z.boolean().optional(),
      /** Exact loaded chunk columns when the adapter can enumerate them. */
      loadedChunks: z.array(minecraftChunkCoordinateSchema).optional(),
      ageMs: z.number().finite().nonnegative().optional(),
      cached: z.boolean().optional(),
    })
    .optional(),
  time: minecraftTimeInfoSchema.optional(),
  itemDrops: z.array(minecraftItemDropSchema),
  sampledRegion: z.object({
    radius: z.number().int().positive(),
    verticalRadius: z.number().int().nonnegative(),
    center: blockPositionSchema,
    sampledCells: z.number().int().nonnegative(),
    unknownCells: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  /** Actual cost and yield of the last perception pass, measured by the adapter. */
  perception: z.object({
    totalMs: z.number().finite().nonnegative(),
    localScanMs: z.number().finite().nonnegative(),
    strategicScanMs: z.number().finite().nonnegative(),
    entityScanMs: z.number().finite().nonnegative(),
    validationMs: z.number().finite().nonnegative(),
    sampledCells: z.number().int().nonnegative(),
    unknownCells: z.number().int().nonnegative(),
    localBlocksFound: z.number().int().nonnegative(),
    localBlocksReturned: z.number().int().nonnegative(),
    entitiesReturned: z.number().int().nonnegative(),
    resourceSightings: z.number().int().nonnegative(),
    minableSightings: z.number().int().nonnegative(),
    loadedChunks: z.number().int().nonnegative().nullable(),
  }).optional(),
});

export type MinecraftObservation = z.infer<typeof minecraftObservationSchema>;
export type MinecraftVector = z.infer<typeof vectorSchema>;
export type MinecraftBlockPosition = z.infer<typeof blockPositionSchema>;
export type MinecraftChunkCoordinate = z.infer<typeof minecraftChunkCoordinateSchema>;
