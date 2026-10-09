import { z } from "zod";

const vectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
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
  nearbyBlocks: z.array(
    z.object({
      position: z.object({
        x: z.number().int(),
        y: z.number().int(),
        z: z.number().int(),
      }),
      name: z.string(),
      type: z.number().int(),
      boundingBox: z.string(),
    }),
  ),
  sampledRegion: z.object({
    radius: z.number().int().positive(),
    sampledCells: z.number().int().nonnegative(),
    unknownCells: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});

export type MinecraftObservation = z.infer<typeof minecraftObservationSchema>;
export type MinecraftVector = z.infer<typeof vectorSchema>;
