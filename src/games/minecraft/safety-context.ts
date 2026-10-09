import type { SafetyPolicy } from "../../core/safety-broker.js";
import type { SafetyWorldContextInput } from "../../core/game-mind-runtime.js";
import type { MinecraftObservation } from "./observation.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { observedHazards } from "./block-classes.js";

/** Night window in Java Edition day ticks, used when the adapter did not classify it itself. */
export const MINECRAFT_NIGHT_START_TICKS = 13_000;
export const MINECRAFT_NIGHT_END_TICKS = 23_000;

export function isNightTicks(dayTicks: number | null | undefined, reported?: boolean): boolean {
  if (reported !== undefined) return reported;
  if (dayTicks === null || dayTicks === undefined) return false;
  return dayTicks >= MINECRAFT_NIGHT_START_TICKS && dayTicks < MINECRAFT_NIGHT_END_TICKS;
}

/**
 * Projects a Minecraft observation onto the small set of facts the Safety Broker needs. Keeping this
 * in the Minecraft layer means the broker stays game-agnostic while still failing closed when the
 * player state or the observation itself is unusable.
 */
export function minecraftSafetyContext(
  state: MinecraftObservation,
  meta: { readonly observedAtMs: number },
): SafetyWorldContextInput {
  const hostiles = state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type));
  const nearest = hostiles.reduce<number | null>(
    (best, entity) => (best === null || entity.distance < best ? entity.distance : best),
    null,
  );
  const hazards = observedHazards(state.nearbyBlocks, state.player.position);
  const nearestHazard = hazards.length > 0 ? hazards.reduce((best, entry) => (entry.distance < best.distance ? entry : best)) : null;
  return {
    observedAtMs: meta.observedAtMs,
    health: state.player.health,
    food: state.player.food,
    gameMode: state.player.gameMode,
    visibleHostiles: hostiles.length,
    nearestHostileDistance: nearest,
    isNight: isNightTicks(state.time?.dayTicks, state.time?.isNight),
    dimension: state.player.dimension,
    positionY: state.player.position.y,
    nearestHazardDistance: nearestHazard?.distance ?? null,
    nearestHazardName: nearestHazard?.name ?? null,
    // `oxygenLevel` is normalised to air ticks by both adapters (300 = full lungs, 0 = drowning).
    oxygenTicks: state.player.oxygenLevel,
  };
}

/**
 * The policy the Minecraft agent runs with by default. Attack is the only high-risk capability, so
 * the `medium` ceiling denies it; an operator unlocks it through `optedInCapabilities`, and the
 * per-capability budget bounds how many swings a single run may take even then.
 */
export const MINECRAFT_SAFETY_POLICY: SafetyPolicy = {
  id: "gamemind-minecraft-v1",
  enabled: true,
  maxRisk: "medium",
  allowlist: [],
  denylist: [],
  optedInCapabilities: [],
  maxActionsPerRun: 100,
  perCapabilityMaxPerRun: { "minecraft.attack_hostile": 6 },
  cooldownMsByCapability: {},
  protectedHealthFloor: null,
  protectedStateRecoverySkills: [
    "minecraft.eat-food",
    "minecraft.rest",
    "minecraft.navigate",
    "minecraft.pickup-item",
    "minecraft.harvest-berries",
  ],
  maxObservationAgeMs: 120_000,
  readOnlyCapabilities: ["minecraft.look", "minecraft.inspect_block"],
  // Standing in lava or drowning is refused for the capabilities that keep the agent in place. Fleeing,
  // looking, eating and dropping stay allowed: escaping is exactly what the agent must be able to do.
  hazardMaxDistance: 2.5,
  hazardBlockedCapabilities: [
    "minecraft.mine_block",
    "minecraft.place_block",
    "minecraft.build_shelter",
    "minecraft.attack_hostile",
    "minecraft.rest",
    "minecraft.craft_item",
  ],
  drowningBlockedCapabilities: ["minecraft.rest", "minecraft.mine_block", "minecraft.build_shelter"],
};

export const MINECRAFT_COMBAT_CAPABILITY = "minecraft.attack_hostile";
