/**
 * Action availability checks for Minecraft.
 * This module provides functions to check if an action can be executed given the current world state.
 * Prevents the bot from attempting actions that are guaranteed to fail (e.g., mining stone without a pickaxe).
 */

import type { MinecraftObservation } from "./observation.js";
import { isMineableBlockName, minecraftMiningRequirements, canMineWithTier } from "./mining.js";
import { isHostileMinecraftEntity } from "./threats.js";
import { distanceBetween } from "./block-classes.js";

export interface ActionAvailabilityResult {
  readonly available: boolean;
  readonly reason: string | null;
  readonly details?: Record<string, unknown>;
}

export interface ActionInput {
  readonly capability: string;
  readonly input: unknown;
}

/**
 * Checks if the player has a specific item in their inventory.
 */
function hasItem(inventory: Array<{ name: string; count: number }>, itemName: string, minCount = 1): boolean {
  return inventory.some((item) => item.name === itemName && item.count >= minCount);
}

/**
 * Checks if the player has any pickaxe (wooden, stone, iron, diamond, netherite).
 */
function hasAnyPickaxe(inventory: Array<{ name: string; count: number }>): boolean {
  const pickaxeNames = ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"];
  return pickaxeNames.some((name) => hasItem(inventory, name));
}

/**
 * Checks if the player has a pickaxe that can mine the specified block.
 */
function hasSuitablePickaxe(inventory: Array<{ name: string; count: number }>, blockName: string): boolean {
  const requirement = minecraftMiningRequirements.get(blockName);
  if (!requirement) return false; // Block is not mineable or doesn't require a pickaxe
  
  const pickaxeTier = bestPickaxeTier(inventory);
  return canMineWithTier(pickaxeTier, requirement.miningTier);
}

/**
 * Checks if a block is within reach (default 3 blocks).
 */
function isWithinReach(playerPos: { x: number; y: number; z: number }, blockPos: { x: number; y: number; z: number }, maxRange = 3): boolean {
  return distanceBetween(playerPos, blockPos) <= maxRange;
}

/**
 * Checks if there's a hostile entity too close to the target position.
 */
function hasHostileNearby(entities: Array<{ name: string; position: { x: number; y: number; z: number } }>, targetPos: { x: number; y: number; z: number }, dangerRadius = 6): boolean {
  return entities.some((entity) => 
    isHostileMinecraftEntity(entity.name) && 
    distanceBetween(entity.position, targetPos) <= dangerRadius
  );
}

/**
 * Checks if the player has enough food to eat.
 */
function hasFoodToEat(inventory: Array<{ name: string; count: number }>): boolean {
  const foodNames = ["bread", "cooked_beef", "cooked_porkchop", "cooked_chicken", "apple", "golden_apple", "sweet_berries"];
  return foodNames.some((name) => hasItem(inventory, name));
}

/**
 * Checks if the player has enough health to perform the action.
 */
function hasEnoughHealth(health: number | null, minHealth = 1): boolean {
  return health !== null && health >= minHealth;
}

/**
 * Checks if the player has enough hunger to need eating.
 */
function needsFood(food: number | null, hungerThreshold = 18): boolean {
  return food !== null && food < hungerThreshold;
}

/**
 * Main function to check if an action is available given the current observation.
 */
export function checkActionAvailability(
  action: ActionInput,
  observation: MinecraftObservation
): ActionAvailabilityResult {
  const player = observation.player;
  const inventory = player.inventory ?? [];
  const entities = observation.entities ?? [];
  const blocks = observation.blocks ?? [];
  
  switch (action.capability) {
    // --- Mining actions ---
    case "minecraft.mine_block": {
      const input = action.input as { x: number; y: number; z: number; blockName: string };
      const blockName = input?.blockName;
      const blockPos = input ? { x: input.x, y: input.y, z: input.z } : null;
      
      // Check if block exists
      if (!blockName || !blockPos) {
        return { available: false, reason: "INVALID_INPUT", details: { input } };
      }
      
      // Check if block is mineable
      if (!isMineableBlockName(blockName)) {
        return { available: false, reason: "BLOCK_NOT_MINEABLE", details: { blockName } };
      }
      
      // Check if player has suitable pickaxe
      if (!hasSuitablePickaxe(inventory, blockName)) {
        return { available: false, reason: "NO_SUITABLE_PICKAXE", details: { blockName, requiredTier: minecraftMiningRequirements.get(blockName)?.miningTier } };
      }
      
      // Check if block is within reach
      if (player.position && !isWithinReach(player.position, blockPos, 3)) {
        return { available: false, reason: "BLOCK_OUT_OF_REACH", details: { blockPos, playerPos: player.position } };
      }
      
      // Check for hostiles nearby
      if (hasHostileNearby(entities, blockPos)) {
        return { available: false, reason: "HOSTILE_NEARBY", details: { blockPos } };
      }
      
      return { available: true };
    }
    
    // --- Collect actions ---
    case "minecraft.collect_block": {
      const input = action.input as { x: number; y: number; z: number; blockName: string };
      const blockName = input?.blockName;
      const blockPos = input ? { x: input.x, y: input.y, z: input.z } : null;
      
      if (!blockName || !blockPos) {
        return { available: false, reason: "INVALID_INPUT", details: { input } };
      }
      
      // Check if block is in the collectable list (logs)
      const collectableLogs = ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"];
      if (!collectableLogs.includes(blockName)) {
        return { available: false, reason: "BLOCK_NOT_COLLECTABLE", details: { blockName } };
      }
      
      // Check if block is within reach
      if (player.position && !isWithinReach(player.position, blockPos, 3)) {
        return { available: false, reason: "BLOCK_OUT_OF_REACH", details: { blockPos, playerPos: player.position } };
      }
      
      // Check for hostiles nearby
      if (hasHostileNearby(entities, blockPos)) {
        return { available: false, reason: "HOSTILE_NEARBY", details: { blockPos } };
      }
      
      return { available: true };
    }
    
    // --- Crafting actions ---
    case "minecraft.craft_item": {
      const input = action.input as { targetItem: string; count?: number };
      const targetItem = input?.targetItem;
      
      if (!targetItem) {
        return { available: false, reason: "INVALID_INPUT", details: { input } };
      }
      
      // Check if player has a crafting table or can craft in inventory
      const hasCraftingTable = hasItem(inventory, "crafting_table");
      const canCraftInInventory = true; // Most simple items can be crafted in 2x2 grid
      
      if (!hasCraftingTable && !canCraftInInventory) {
        return { available: false, reason: "NO_CRAFTING_TABLE", details: { targetItem } };
      }
      
      return { available: true };
    }
    
    // --- Eat actions ---
    case "minecraft.eat_food": {
      if (!hasFoodToEat(inventory)) {
        return { available: false, reason: "NO_FOOD_IN_INVENTORY" };
      }
      
      if (!needsFood(player.food)) {
        return { available: false, reason: "FOOD_NOT_NEEDED", details: { food: player.food } };
      }
      
      return { available: true };
    }
    
    // --- Rest actions ---
    case "minecraft.rest": {
      if (!hasEnoughHealth(player.health, 1)) {
        return { available: false, reason: "HEALTH_TOO_LOW_TO_REST", details: { health: player.health } };
      }
      
      // Don't rest if health is already full
      if (player.health >= 20) {
        return { available: false, reason: "HEALTH_ALREADY_FULL" };
      }
      
      return { available: true };
    }
    
    // --- Navigation actions ---
    case "minecraft.navigate": {
      const input = action.input as { x: number; y: number; z: number; range?: number };
      const targetPos = input ? { x: input.x, y: input.y, z: input.z } : null;
      
      if (!targetPos) {
        return { available: false, reason: "INVALID_INPUT", details: { input } };
      }
      
      // Check if target is within navigation range
      if (player.position) {
        const maxRange = input.range ?? 32;
        if (distanceBetween(player.position, targetPos) > maxRange) {
          return { available: false, reason: "TARGET_OUT_OF_NAVIGATION_RANGE", details: { targetPos, maxRange } };
        }
      }
      
      return { available: true };
    }
    
    // --- Place block actions ---
    case "minecraft.place_block": {
      const input = action.input as { blockName: string; x: number; y: number; z: number };
      const blockName = input?.blockName;
      
      if (!blockName) {
        return { available: false, reason: "INVALID_INPUT", details: { input } };
      }
      
      // Check if player has the block in inventory
      if (!hasItem(inventory, blockName)) {
        return { available: false, reason: "BLOCK_NOT_IN_INVENTORY", details: { blockName } };
      }
      
      return { available: true };
    }
    
    // --- Harvest berries ---
    case "minecraft.harvest_berries": {
      const input = action.input as { x: number; y: number; z: number };
      const bushPos = input ? { x: input.x, y: input.y, z: input.z } : null;
      
      if (!bushPos) {
        return { available: false, reason: "INVALID_INPUT", details: { input } };
      }
      
      // Check if there's a ripe berry bush at the position
      const berryBush = blocks.find((block) => 
        block.name === "sweet_berry_bush" && 
        block.x === bushPos.x && 
        block.y === bushPos.y && 
        block.z === bushPos.z
      );
      
      if (!berryBush) {
        return { available: false, reason: "NO_BERRY_BUSH_AT_POSITION", details: { bushPos } };
      }
      
      // Check if bush is ripe (age 2 or 3)
      if (berryBush.properties?.age !== 2 && berryBush.properties?.age !== 3) {
        return { available: false, reason: "BERRY_BUSH_NOT_RIPE", details: { age: berryBush.properties?.age } };
      }
      
      return { available: true };
    }
    
    // --- Default: action is available ---
    default:
      return { available: true };
  }
}

/**
 * Returns a user-friendly message explaining why an action is not available.
 */
export function getUnavailableReason(reason: string): string {
  const messages: Record<string, string> = {
    "INVALID_INPUT": "Ungültige Eingabe für diese Aktion.",
    "BLOCK_NOT_MINEABLE": "Dieser Block kann nicht abgebaut werden.",
    "NO_SUITABLE_PICKAXE": "Du brauchst eine bessere Spitzhacke für diesen Block.",
    "BLOCK_OUT_OF_REACH": "Der Block ist zu weit entfernt.",
    "HOSTILE_NEARBY": "Es gibt Gegner in der Nähe – zu gefährlich!",
    "BLOCK_NOT_COLLECTABLE": "Dieser Block kann nicht gesammelt werden.",
    "NO_CRAFTING_TABLE": "Du brauchst einen Werkbank, um dieses Item zu craften.",
    "NO_FOOD_IN_INVENTORY": "Du hast kein Essen im Inventar.",
    "FOOD_NOT_NEEDED": "Du hast genug Hunger – kein Essen nötig.",
    "HEALTH_TOO_LOW_TO_REST": "Deine Gesundheit ist zu niedrig, um zu warten.",
    "HEALTH_ALREADY_FULL": "Deine Gesundheit ist bereits voll.",
    "TARGET_OUT_OF_NAVIGATION_RANGE": "Das Ziel ist zu weit entfernt für Navigation.",
    "BLOCK_NOT_IN_INVENTORY": "Du hast diesen Block nicht im Inventar.",
    "NO_BERRY_BUSH_AT_POSITION": "Es gibt keinen Brombeerstrauch an dieser Position.",
    "BERRY_BUSH_NOT_RIPE": "Der Brombeerstrauch ist noch nicht reif.",
  };
  return messages[reason] ?? `Aktion nicht verfügbar: ${reason}`;
}
