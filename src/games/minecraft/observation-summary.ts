import { isHostileMinecraftEntity } from "./threats.js";
import type { MinecraftObservation } from "./observation.js";

/**
 * Compact, bounded view of one Minecraft observation for the durable trace. A full observation carries up to
 * 100 nearby blocks, 192 sightings and the whole inventory; writing that every tick was about 26 KB per second.
 * The summary keeps what an operator needs to reconstruct a decision (vitals, water state, threat counts, scan
 * freshness and per-phase timings) and stays under roughly half a kilobyte. The full state remains in memory.
 */
export function minecraftObservationSummary(state: MinecraftObservation): Record<string, unknown> {
  const player = state.player;
  const perception = state.perception;
  return {
    alive: player.alive ?? null,
    dimension: player.dimension,
    health: player.health,
    food: player.food,
    airTicks: player.oxygenLevel,
    inWater: player.inWater ?? null,
    headInWater: player.headInWater ?? null,
    onGround: player.onGround,
    position: {
      x: Math.round(player.position.x * 10) / 10,
      y: Math.round(player.position.y * 10) / 10,
      z: Math.round(player.position.z * 10) / 10,
    },
    hostiles: state.entities.filter((entity) => isHostileMinecraftEntity(entity.name, entity.type)).length,
    entities: state.entities.length,
    nearbyBlocks: state.nearbyBlocks.length,
    resourceSightings: state.resourceSightings.length,
    minableSightings: state.minableSightings?.length ?? null,
    itemDrops: state.itemDrops.length,
    wideScan: { cached: state.resourceScan.cached ?? false, ageMs: state.resourceScan.ageMs ?? null },
    perceptionMs: perception
      ? {
          total: round(perception.totalMs),
          local: round(perception.localScanMs),
          strategic: round(perception.strategicScanMs),
          entities: round(perception.entityScanMs),
          validation: round(perception.validationMs),
        }
      : null,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
