import type { SkillDefinition } from "../../core/skill-runtime.js";
import {
  MINECRAFT_COLLECT_BLOCK_CAPABILITY,
  MINECRAFT_CRAFT_CAPABILITY,
  MINECRAFT_EAT_CAPABILITY,
  MINECRAFT_PLACE_TABLE_CAPABILITY,
  MINECRAFT_EQUIP_CAPABILITY,
  MINECRAFT_INSPECT_BLOCK_CAPABILITY,
  MINECRAFT_LOOK_CAPABILITY,
  MINECRAFT_NAVIGATE_CAPABILITY,
  minecraftCollectBlockInputSchema,
  minecraftCraftItemInputSchema,
  minecraftEatFoodInputSchema,
  minecraftPlaceTableInputSchema,
  minecraftEquipInputSchema,
  minecraftInspectBlockInputSchema,
  minecraftLookInputSchema,
  minecraftNavigateInputSchema,
} from "./capabilities.js";

export const minecraftSkills: readonly SkillDefinition[] = [
  {
    id: "minecraft.orient",
    description: "Safely orient the Minecraft player and confirm the local view state.",
    capability: MINECRAFT_LOOK_CAPABILITY,
    inputSchema: minecraftLookInputSchema,
  },
  {
    id: "minecraft.inspect-block",
    description: "Inspect a locally loaded block without modifying the world.",
    capability: MINECRAFT_INSPECT_BLOCK_CAPABILITY,
    inputSchema: minecraftInspectBlockInputSchema,
  },
  {
    id: "minecraft.navigate",
    description: "Reach a nearby coordinate with conservative pathfinding.",
    capability: MINECRAFT_NAVIGATE_CAPABILITY,
    inputSchema: minecraftNavigateInputSchema,
  },
  {
    id: "minecraft.collect-log",
    description: "Collect one observed log block and verify that its item entered inventory.",
    capability: MINECRAFT_COLLECT_BLOCK_CAPABILITY,
    inputSchema: minecraftCollectBlockInputSchema,
  },
  {
    id: "minecraft.equip-item",
    description: "Equip an inventory item into a selected equipment slot and verify it.",
    capability: MINECRAFT_EQUIP_CAPABILITY,
    inputSchema: minecraftEquipInputSchema,
  },
  {
    id: "minecraft.craft-item",
    description: "Craft only a supported plank, stick, crafting-table, or wooden tool item using verified inventory prerequisites.",
    capability: MINECRAFT_CRAFT_CAPABILITY,
    inputSchema: minecraftCraftItemInputSchema,
  },
  {
    id: "minecraft.eat-food",
    description: "Eat an allowlisted food when hunger is below the survival threshold and verify both hunger and inventory changes.",
    capability: MINECRAFT_EAT_CAPABILITY,
    inputSchema: minecraftEatFoodInputSchema,
  },
  {
    id: "minecraft.place-crafting-table",
    description: "Place a crafting table on a visible solid support block after local collision and danger checks.",
    capability: MINECRAFT_PLACE_TABLE_CAPABILITY,
    inputSchema: minecraftPlaceTableInputSchema,
  },
];
