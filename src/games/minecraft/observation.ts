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
  /** Ticks into the current day cycle (Java Edition: 0 through 23999). */
  dayTicks: z.number().finite().min(0).max(24_000),
  day: z.number().int().nonnegative(),
  isNight: z.boolean(),
});

export type MinecraftTimeInfo = z.infer<typeof minecraftTimeInfoSchema>;

export const minecraftObservationSchema = z.object({
  player: z.object({
    username: z.string(),
    position: vectorSchema,
    orientation: orientationSchema,
    dimension: z.string(),
    gameMode: z.string(),
    health: z.number().finite().nullable(),
    food: z.number().finite().nullable(),
    foodSaturation: z.number().finite().nullable(),
    /** Air supply in **ticks** (0-300); 300 means full lungs. Null when the adapter cannot read it. */
    oxygenLevel: z.number().finite().nullable(),
    onGround: z.boolean(),
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
    }),
  ),
  /** Resource-class blocks found in a wider radius; absence is only meaningful when not truncated. */
  resourceSightings: z.array(minecraftResourceSightingSchema),
  resourceScan: z.object({
    radius: z.number().finite().positive(),
    limit: z.number().int().positive(),
    center: blockPositionSchema,
    truncated: z.boolean(),
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
});

export type MinecraftObservation = z.infer<typeof minecraftObservationSchema>;
export type MinecraftVector = z.infer<typeof vectorSchema>;
export type MinecraftBlockPosition = z.infer<typeof blockPositionSchema>;
