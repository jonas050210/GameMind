import type { MinecraftObservation } from "./observation.js";
import { bestPickaxeTier, canMineWithTier, isMineableBlockName, minecraftMiningRequirements } from "./mining.js";
import { isHostileMinecraftEntity } from "./threats.js";

export interface ActionAvailabilityResult {
  readonly available: boolean;
  readonly reason: string | null;
  readonly details?: Record<string, unknown>;
}

export interface ActionInput {
  readonly capability: string;
  readonly input: unknown;
}

function inputRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null ? input as Record<string, unknown> : null;
}

function countInventory(observation: MinecraftObservation, itemName: string): number {
  return observation.inventory.filter((item) => item.name === itemName).reduce((sum, item) => sum + item.count, 0);
}

function deny(reason: string, details?: Record<string, unknown>): ActionAvailabilityResult {
  return { available: false, reason, ...(details ? { details } : {}) };
}

/**
 * Cheap observation-based preflight hints. This deliberately does not replace adapter checks: live positions,
 * inventory and threats are always revalidated by the action implementation immediately before a world change.
 */
export function checkActionAvailability(action: ActionInput, observation: MinecraftObservation): ActionAvailabilityResult {
  const input = inputRecord(action.input);
  if (!input) return deny("INVALID_INPUT");
  switch (action.capability) {
    case "minecraft.mine_block": {
      const blockName = typeof input.blockName === "string" ? input.blockName : "";
      if (!isMineableBlockName(blockName)) return deny("BLOCK_NOT_MINEABLE", { blockName });
      const tools = [
        ...observation.inventory.map((item) => ({ name: item.name })),
        ...Object.values(observation.equipment).flatMap((item) => item ? [{ name: item.name }] : []),
      ];
      const tier = bestPickaxeTier(tools).tier;
      const verdict = canMineWithTier(blockName, tier);
      if (!verdict.mineable) return deny(verdict.code, { blockName, tier, requiredTier: minecraftMiningRequirements[blockName].minPickaxeTier });
      const radius = typeof input.dangerRadius === "number" ? input.dangerRadius : 6;
      const target = { x: Number(input.x), y: Number(input.y), z: Number(input.z) };
      if (observation.entities.some((entity) => isHostileMinecraftEntity(entity.name, entity.type) && Math.hypot(entity.position.x - target.x, entity.position.y - target.y, entity.position.z - target.z) <= radius)) {
        return deny("HOSTILE_NEARBY", { blockName, target });
      }
      return { available: true, reason: null };
    }
    case "minecraft.give_item": {
      const itemName = typeof input.itemName === "string" ? input.itemName : "";
      const count = typeof input.count === "number" ? input.count : 0;
      if (!itemName || !Number.isInteger(count) || count < 1) return deny("INVALID_INPUT");
      const held = countInventory(observation, itemName);
      return held >= count ? { available: true, reason: null } : deny("ITEM_NOT_IN_INVENTORY", { itemName, held, requested: count });
    }
    default:
      return { available: true, reason: null };
  }
}

export function getUnavailableReason(reason: string): string {
  const messages: Readonly<Record<string, string>> = {
    INVALID_INPUT: "The action input is invalid.",
    BLOCK_NOT_MINEABLE: "This block is not on the mining allowlist.",
    TOOL_REQUIRED: "A pickaxe is required for this block.",
    TOOL_TIER_INSUFFICIENT: "The carried pickaxe is not strong enough for this block.",
    HOSTILE_NEARBY: "A visible hostile is too close to the requested target.",
    ITEM_NOT_IN_INVENTORY: "The requested item amount is not in inventory.",
  };
  return messages[reason] ?? `Action is not currently available: ${reason}`;
}
