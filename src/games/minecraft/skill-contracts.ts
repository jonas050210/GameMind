import { countItemAndEquipment } from "./recipes.js";
import type { MinecraftObservation } from "./observation.js";
import { COMBAT_APPROACH_MAX_BLOCKS } from "./combat.js";

/** Number of the four cardinal cells around the player that are observed solid at feet level. */
export function shelterCardinalSolidCount(state: MinecraftObservation): number {
  const player = state.player.position;
  const feetX = Math.floor(player.x);
  const feetY = Math.floor(player.y);
  const feetZ = Math.floor(player.z);
  return (
    [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const
  ).filter(([dx, dz]) =>
    state.nearbyBlocks.some(
      (block) =>
        block.position.x === feetX + dx &&
        block.position.y === feetY &&
        block.position.z === feetZ + dz &&
        block.boundingBox === "block",
    ),
  ).length;
}

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
    case "minecraft.mine-block": {
      const blockName = String(record.blockName);
      const drops: Record<string, string> = {
        stone: "cobblestone",
        cobblestone: "cobblestone",
        deepslate: "cobbled_deepslate",
        cobbled_deepslate: "cobbled_deepslate",
        coal_ore: "coal",
        deepslate_coal_ore: "coal",
        iron_ore: "raw_iron",
        deepslate_iron_ore: "raw_iron",
        copper_ore: "raw_copper",
        deepslate_copper_ore: "raw_copper",
      };
      const item = drops[blockName] ?? blockName;
      const delta = countAfter(item) - countBefore(item);
      const gone = ![...(after.nearbyBlocks ?? [])].some(
        (block) => block.position.x === Number(record.x) && block.position.y === Number(record.y) && block.position.z === Number(record.z),
      );
      return {
        verified: delta > 0 || gone,
        evidence: `Observed ${item} inventory change ${delta >= 0 ? "+" : ""}${delta}; source block ${gone ? "no longer observed" : "still observed"}.`,
      };
    }
    case "minecraft.place-block": {
      const x = Number(record.x);
      const y = Number(record.y);
      const z = Number(record.z);
      const expected = String(record.blockName);
      const seen = [...after.nearbyBlocks, ...after.resourceSightings, ...(after.minableSightings ?? [])].some(
        (block) =>
          block.position.x === x && block.position.y === y && block.position.z === z &&
          (block.name === expected || (expected === "cobblestone" && block.name === "cobblestone")),
      );
      return {
        verified: seen,
        evidence: `Placed ${expected} ${seen ? "observed" : "not observed"} at ${x},${y},${z}.`,
      };
    }
    case "minecraft.build-shelter": {
      // The contract counts how many cardinal sides are solid before and after: progress must be
      // visible in the world, not only in the adapter's own report.
      const solidAfter = shelterCardinalSolidCount(after);
      const solidBefore = before ? shelterCardinalSolidCount(before) : 0;
      const verified = solidAfter > solidBefore;
      return {
        verified,
        evidence: `Cardinal sides closed around the player went from ${solidBefore}/4 to ${solidAfter}/4.`,
      };
    }
    case "minecraft.attack-hostile": {
      const entityId = String(record.entityId);
      const stillVisible = after.entities.some((entity) => entity.id === entityId);
      // "Gone from the list" alone is not a kill (render-distance edge). It counts only when the target was within
      // melee range before, and the adapter's own confirmation (entityDead) has already gated this check.
      const wasNear = before
        ? before.entities.some((entity) => entity.id === entityId && entity.distance <= COMBAT_APPROACH_MAX_BLOCKS)
        : false;
      const verified = !stillVisible && wasNear;
      return {
        verified,
        evidence: stillVisible
          ? `The entity ${entityId} is still visible; the swing did not remove the threat.`
          : wasNear
            ? `Entity ${entityId} was within ${COMBAT_APPROACH_MAX_BLOCKS} blocks and is no longer observed.`
            : `Entity ${entityId} is absent now, but it was not observed within ${COMBAT_APPROACH_MAX_BLOCKS} blocks before, so its removal is not verified as a kill.`,
      };
    }
    case "minecraft.swim-to-surface": {
      // Verified only by the observed state after the swim: out of the water entirely, both body and head.
      const out = after.player.inWater === false && after.player.headInWater === false;
      const wasIn = before ? before.player.inWater === true || before.player.headInWater === true : false;
      return {
        verified: out && wasIn,
        evidence: out
          ? "Observed body and head out of water after the swim."
          : `Still in water after the swim (body ${after.player.inWater ?? "unknown"}, head ${after.player.headInWater ?? "unknown"}).`,
      };
    }
    case "minecraft.drop-item": {
      const item = String(record.itemName);
      const count = Number(record.count ?? 1);
      const delta = countBefore(item) - countAfter(item);
      return {
        verified: delta >= count,
        evidence: `Observed ${item} inventory decrease of ${delta} for a requested drop of ${count}.`,
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
