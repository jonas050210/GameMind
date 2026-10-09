import { countItemAndEquipment } from "./recipes.js";
import type { MinecraftObservation } from "./observation.js";

export interface PostconditionResult {
  /** `null` when the observation needed to check the contract is unavailable. */
  readonly verified: boolean | null;
  readonly evidence: string;
}

/**
 * Independent check of a confirmed action against the next observation. The adapter's own
 * confirmation is one signal; this contract re-derives the expected effect from observed state so
 * that a confirmation the world does not back up is not counted as progress.
 */
export function verifySkillPostcondition(
  skillId: string,
  input: unknown,
  before: MinecraftObservation | null,
  after: MinecraftObservation | null,
): PostconditionResult {
  if (!after) {
    return { verified: null, evidence: "No post-action observation was available; the adapter confirmation stands." };
  }
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const countBefore = (name: string): number => (before ? countItemAndEquipment(before.inventory, before.equipment, name) : 0);
  const countAfter = (name: string): number => countItemAndEquipment(after.inventory, after.equipment, name);

  switch (skillId) {
    case "minecraft.inspect-block":
      return { verified: true, evidence: "Read-only skill; no state change is expected." };
    case "minecraft.navigate": {
      const x = Number(record.x);
      const y = Number(record.y);
      const z = Number(record.z);
      const range = Number(record.range ?? 1);
      const position = after.player.position;
      const horizontal = Math.hypot(position.x - (x + 0.5), position.z - (z + 0.5));
      const vertical = Math.abs(position.y - y);
      const verified = horizontal <= range + 1.5 && vertical <= 2;
      return {
        verified,
        evidence: `Observed player ${horizontal.toFixed(2)} blocks horizontally and ${vertical.toFixed(2)} vertically from the goal.`,
      };
    }
    case "minecraft.collect-log":
    case "minecraft.pickup-item":
    case "minecraft.harvest-berries": {
      const item =
        skillId === "minecraft.collect-log"
          ? String(record.blockName)
          : skillId === "minecraft.pickup-item"
            ? String(record.itemName)
            : "sweet_berries";
      const delta = countAfter(item) - countBefore(item);
      return {
        verified: delta > 0,
        evidence: `Observed ${item} inventory change ${delta >= 0 ? "+" : ""}${delta}.`,
      };
    }
    case "minecraft.craft-item": {
      const item = String(record.item);
      const requested = Number(record.count ?? 1);
      const delta = countAfter(item) - countBefore(item);
      return {
        verified: delta > 0 || countAfter(item) >= requested,
        evidence: `Observed ${item} inventory change ${delta >= 0 ? "+" : ""}${delta}; requested ${requested}.`,
      };
    }
    case "minecraft.eat-food": {
      const item = String(record.item);
      const hungerBefore = before?.player.food ?? null;
      const hungerAfter = after.player.food;
      const verified =
        hungerBefore !== null && hungerAfter !== null && hungerAfter > hungerBefore && countAfter(item) < countBefore(item);
      return { verified, evidence: `Observed hunger ${hungerBefore ?? "?"} → ${hungerAfter ?? "?"} and ${item} count change.` };
    }
    case "minecraft.place-crafting-table": {
      const x = Number(record.x);
      const y = Number(record.y);
      const z = Number(record.z);
      const seen = [...after.nearbyBlocks, ...after.resourceSightings].some(
        (block) => block.name === "crafting_table" && block.position.x === x && block.position.y === y && block.position.z === z,
      );
      return { verified: seen, evidence: `Crafting table ${seen ? "observed" : "not observed"} at the placement cell.` };
    }
    case "minecraft.rest": {
      const healthBefore = before?.player.health ?? null;
      const healthAfter = after.player.health;
      return {
        verified: healthBefore !== null && healthAfter !== null && healthAfter > healthBefore,
        evidence: `Observed health ${healthBefore ?? "?"} → ${healthAfter ?? "?"} during rest.`,
      };
    }
    case "minecraft.orient": {
      const yaw = Number(record.yaw);
      const pitch = Number(record.pitch);
      const verified =
        Math.abs(Math.atan2(Math.sin(after.player.orientation.yaw - yaw), Math.cos(after.player.orientation.yaw - yaw))) <= 0.02 &&
        Math.abs(after.player.orientation.pitch - pitch) <= 0.02;
      return { verified, evidence: "Observed orientation compared with the requested yaw and pitch." };
    }
    case "minecraft.equip-item": {
      const destination = String(record.destination);
      const slot = destination === "off-hand" ? after.equipment.offhand : after.equipment[destination as "hand" | "head" | "torso" | "legs" | "feet"];
      const verified = slot?.name === String(record.item);
      return { verified, evidence: `Observed equipment in '${destination}': ${slot?.name ?? "empty"}.` };
    }
    default:
      return { verified: null, evidence: `No postcondition contract is defined for '${skillId}'.` };
  }
}
