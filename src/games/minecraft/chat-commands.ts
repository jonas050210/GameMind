import { minecraftCraftTaskItemNames, minecraftLogNames } from "./capabilities.js";
import { minecraftMineableBlockNames, miningDropFor } from "./mining.js";
import type { LargeHouseConceptId } from "./house-blueprint.js";

export type MinecraftChatCommand =
  | { readonly kind: "mode"; readonly mode: "follow" | "come" | "hold" | "stop" | "status" }
  | { readonly kind: "confirm"; readonly yes: boolean }
  | { readonly kind: "resource"; readonly resourceName: string; readonly itemName: string; readonly count: number; readonly countMode: "additional" | "total"; readonly label: string }
  | { readonly kind: "continue-resource"; readonly count: number; readonly countMode: "additional" | "total" }
  | { readonly kind: "craft"; readonly itemName: string; readonly count: number }
  | { readonly kind: "shelter" }
  | { readonly kind: "house"; readonly coordinates: { readonly x: number; readonly y: number; readonly z: number } | null }
  | { readonly kind: "house_plan" }
  | { readonly kind: "house_blueprint"; readonly conceptId: LargeHouseConceptId }
  | { readonly kind: "farm_wheat"; readonly width: number; readonly depth: number; readonly coordinates: { readonly x: number; readonly y: number; readonly z: number } | null }
  | { readonly kind: "food" }
  | { readonly kind: "excavate"; readonly width: number; readonly height: number; readonly depth: number; readonly coordinates: { readonly x: number; readonly y: number; readonly z: number } | null }
  | { readonly kind: "help" };

interface ResourceAlias {
  readonly aliases: readonly string[];
  readonly resourceName: string;
  readonly itemName: string;
  readonly label: string;
}

const resourceAliases: readonly ResourceAlias[] = [
  { aliases: ["diamond", "diamonds", "diamant", "diamanten", "diamond ore", "diamantenerz"], resourceName: "diamond_ore", itemName: "diamond", label: "Diamanten" },
  { aliases: ["iron", "eisen", "iron ore", "eisenerz", "raw iron", "roheisen"], resourceName: "iron_ore", itemName: "raw_iron", label: "Roheisen" },
  { aliases: ["coal", "kohle", "coal ore", "kohleerz"], resourceName: "coal_ore", itemName: "coal", label: "Kohle" },
  { aliases: ["copper", "kupfer", "copper ore", "kupfererz"], resourceName: "copper_ore", itemName: "raw_copper", label: "Rohkupfer" },
  { aliases: ["stone", "stein", "cobblestone", "bruchstein"], resourceName: "stone", itemName: "cobblestone", label: "Bruchstein" },
  { aliases: ["deepslate", "tiefenschiefer"], resourceName: "deepslate", itemName: "cobbled_deepslate", label: "Tiefenschiefer" },
  { aliases: ["oak log", "oak logs", "oak_log", "oak_logs", "log", "logs", "holz", "stamm", "stämme", "baumstamm", "baumstämme"], resourceName: "oak_log", itemName: "oak_log", label: "Eichenstämme" },
  { aliases: ["birch log", "birch logs", "birkenstamm", "birkenstämme"], resourceName: "birch_log", itemName: "birch_log", label: "Birkenstämme" },
  { aliases: ["spruce log", "spruce logs", "fichtenstamm", "fichtenstämme"], resourceName: "spruce_log", itemName: "spruce_log", label: "Fichtenstämme" },
];

const craftAliases: readonly { readonly aliases: readonly string[]; readonly itemName: string }[] = [
  { aliases: ["wooden pickaxe", "wooden_pickaxe", "holzspitzhacke"], itemName: "wooden_pickaxe" },
  { aliases: ["stone pickaxe", "stone_pickaxe", "steinspitzhacke"], itemName: "stone_pickaxe" },
  { aliases: ["wooden axe", "wooden_axe", "holzaxt"], itemName: "wooden_axe" },
  { aliases: ["stone axe", "stone_axe", "steinaxt"], itemName: "stone_axe" },
  { aliases: ["wooden sword", "wooden_sword", "holzs sword", "holzsword"], itemName: "wooden_sword" },
  { aliases: ["stick", "sticks", "stock", "stöcke"], itemName: "stick" },
  { aliases: ["planks", "oak planks", "oak_planks", "bretter"], itemName: "oak_planks" },
  { aliases: ["crafting table", "crafting_table", "crafting table", "werkbank"], itemName: "crafting_table" },
];

function normalizeChatText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[×✕]/g, "x")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}_x\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchAlias(text: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, "[_ ]?");
    return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "i").test(text);
  });
}

/** Parses a deliberately small command grammar; unrecognised chat remains ordinary conversation. */
export function parseMinecraftChatCommand(raw: string): MinecraftChatCommand | null {
  const withoutSlashPrefix = raw.replace(/^\s*\/+\s*(?:gamemind\s+)?/i, "");
  const text = normalizeChatText(withoutSlashPrefix);
  if (!text) return null;

  if (/^(?:follow|follow me|folge|folge mir|folg mir|mir folgen)$/.test(text)) return { kind: "mode", mode: "follow" };
  if (/^(?:come|come here|come to me|komm|komm her|komm zu mir|zu mir kommen)$/.test(text)) return { kind: "mode", mode: "come" };
  if (/^(?:hold|stay|wait|bleib|bleib hier|warte|warte hier|halt position)$/.test(text)) return { kind: "mode", mode: "hold" };
  if (/^(?:stop|stopp|halt|abbruch|cancel|brich ab)$/.test(text)) return { kind: "mode", mode: "stop" };
  if (/^(?:status|zustand|wie gehts|wie geht es dir|was machst du)$/.test(text)) return { kind: "mode", mode: "status" };
  if (/^(?:ja|yes|y|okay|ok|bestätigt|bestaetigt)$/.test(text)) return { kind: "confirm", yes: true };
  if (/^(?:nein|no|n|nicht|nope)$/.test(text)) return { kind: "confirm", yes: false };
  if (/^(?:help|hilfe|befehle)$/.test(text)) return { kind: "help" };
  const housePlan = text.match(/^(?:plan|design|show|zeige|zeig|plane|entwirf) (?:the |ein(?:en|e)? )?(?:large |big |groß(?:e|es)? )?(?:house|haus)(?: (?:concept|plan|entwurf|option))? ([abc])$|^(?:house|haus) (?:plan|entwurf|concept|konzept) ([abc])$/);
  const housePlanId = housePlan?.[1] ?? housePlan?.[2];
  if (housePlanId) return { kind: "house_blueprint", conceptId: housePlanId.toUpperCase() as LargeHouseConceptId };
  const houseIntent = /\b(?:build|construct|make|create|baue|bau|errichte|mach)\b.*\b(?:house|home|cabin|haus|hütte|huette|starterhaus)\b/.test(text);
  if (houseIntent) {
    const explicitStarter = /\b(?:starter\s+(?:house|home)|starterhaus(?:-prototyp)?|(?:small|test|prototype|prototyp)\s+(?:starter\s+)?(?:house|home)|klein(?:e|es|er|en)\s+(?:starter\s+)?(?:haus|hütte|huette))\b/.test(text);
    if (!explicitStarter) return { kind: "house_plan" };
    const coordinates = text.match(/\b(?:at|bei|coordinates?|koordinaten)\s+(-?\d{1,8})\s+(-?\d{1,3})\s+(-?\d{1,8})\b/);
    return {
      kind: "house",
      coordinates: coordinates ? { x: Number(coordinates[1]), y: Number(coordinates[2]), z: Number(coordinates[3]) } : null,
    };
  }
  if (/^(?:build|baue|bau|errichte|baue mir) (?:a |the )?(?:shelter|unterstand|schutzhaus)$/.test(text)) return { kind: "shelter" };
  if (/^(?:get|bring|find|sammle|hol|hole|besorg|beschaffe|secure|sichere) (?:me )?(?:some )?(?:food|essen|nahrung)$/.test(text)) return { kind: "food" };

  const dimensions = text.match(/\b(\d{1,2})\s*x\s*(\d{1,2})\s*x\s*(\d{1,2})\b/);
  const excavationVerb = /\b(?:dig|excavate|excavation|grabe|graben|ausgraben|baggere|aushub)\b/.test(text);
  if (dimensions && excavationVerb) {
    const coordinates = text.match(/\b(?:at|bei|coordinates?|koordinaten)\s+(-?\d{1,8})\s+(-?\d{1,3})\s+(-?\d{1,8})\b/);
    return {
      kind: "excavate",
      width: Number(dimensions[1]),
      height: Number(dimensions[2]),
      depth: Number(dimensions[3]),
      coordinates: coordinates
        ? { x: Number(coordinates[1]), y: Number(coordinates[2]), z: Number(coordinates[3]) }
        : null,
    };
  }

  const farmDimensions = text.match(/\b(\d{1,2})\s*x\s*(\d{1,2})\b/);
  const wheatFarmIntent = /\b(?:wheat|wheatfield|weizen|weizenfarm|weizenfeld|wheat farm)\b/.test(text) &&
    /\b(?:farm|plant|grow|build|make|create|baue|bau|pflanze|anlegen|errichte|feld)\b/.test(text);
  if (wheatFarmIntent) {
    const coordinates = text.match(/\b(?:at|bei|coordinates?|koordinaten)\s+(-?\d{1,8})\s+(-?\d{1,3})\s+(-?\d{1,8})\b/);
    return {
      kind: "farm_wheat",
      width: farmDimensions ? Number(farmDimensions[1]) : 5,
      depth: farmDimensions ? Number(farmDimensions[2]) : 5,
      coordinates: coordinates
        ? { x: Number(coordinates[1]), y: Number(coordinates[2]), z: Number(coordinates[3]) }
        : null,
    };
  }

  const countMatch = text.match(/\b(\d{1,2})\b/);
  const count = countMatch ? Number(countMatch[1]) : 1;
  if (count < 1 || count > 64) return null;
  const totalMode = /\b(?:until|bis|insgesamt|gesamt|total|until you have|bis du|bis ich)\b/.test(text);
  const additionalMode = /\b(?:more|noch|weitere|zus[aä]tzlich|additional)\b/.test(text);
  // A bare numeric resource request means that total inventory target; only an explicit “more/noch” adds to it.
  const countMode: "additional" | "total" = totalMode ? "total" : additionalMode ? "additional" : countMatch ? "total" : "additional";
  if (/^(?:(?:mach weiter|farme weiter|mine weiter|hol weiter|hole weiter|continue|keep going)\s+)?(?:bis du|until you have)\s+\d{1,2}(?:\s+(?:hast|have))?$/.test(text)) {
    return { kind: "continue-resource", count, countMode: "total" };
  }
  if (/^(?:(?:get|bring|mine|dig|hol|hole|sammle|farme|collect)\s+)?(?:noch|weitere|more|additional|zus[aä]tzlich)?\s*\d{1,2}(?:\s+(?:more|additional|weitere|zus[aä]tzlich))?$/.test(text)) {
    return { kind: "continue-resource", count, countMode: totalMode || (Boolean(countMatch) && !additionalMode) ? "total" : "additional" };
  }

  if (/\b(?:craft|make|create|herstell|crafting|bau)\b/.test(text)) {
    const item = craftAliases.find(({ aliases }) => matchAlias(text, aliases));
    if (item && (minecraftCraftTaskItemNames as readonly string[]).includes(item.itemName)) {
      return { kind: "craft", itemName: item.itemName, count };
    }
  }

  const hasResourceVerb = /\b(?:get|mine|mining|miniere|dig|grabe|abbau|abbaue|suchen|such|find|finde|gather|collect|sammle|sammeln|hol|hole|bring|besorg|beschaffe|farm|farme)\b/.test(text);
  if (!hasResourceVerb) return null;
  const resource = resourceAliases.find(({ aliases }) => matchAlias(text, aliases));
  if (!resource) return null;
  if (resource.resourceName === "oak_log" || resource.resourceName === "birch_log" || resource.resourceName === "spruce_log") {
    if (!(minecraftLogNames as readonly string[]).includes(resource.resourceName)) return null;
    return { kind: "resource", resourceName: resource.resourceName, itemName: resource.itemName, count, countMode, label: resource.label };
  }
  if (!(minecraftMineableBlockNames as readonly string[]).includes(resource.resourceName)) return null;
  const itemName = miningDropFor(resource.resourceName);
  if (!itemName || itemName !== resource.itemName) return null;
  return { kind: "resource", resourceName: resource.resourceName, itemName, count, countMode, label: resource.label };
}

export function describeMinecraftChatHelp(language: "en" | "de" = "de"): string {
  if (language === "en") {
    return "Commands: status, help, stop, hold/stay, follow me, come; gather/mine [count] allowlisted resources; craft <tool>; build starter house [at X Y Z] (fixed 5×5; project and gathering need separate approvals); plan house A/B/C for a planning-only layer/material blueprint; build house never silently chooses a design or starts a build; farm wheat up to 25×50 on existing hydrated farmland; dig up to 10×10×10 here or at X Y Z.";
  }
  return "Befehle: folge mir, komm, bleib, stopp, status; hol/sammle/miniere [Anzahl] Ressourcen; craft <Werkzeug>; baue Starterhaus [bei x y z] (nur 5×5; Bau und Materialsammlung getrennt freigeben); plane Haus A/B/C für einen reinen Entwurfs-, Schicht- und Materialplan; baue Haus wählt niemals stillschweigend einen Entwurf und startet keinen Bau; Weizenfeld bis 25×50 auf bestehendem bewässertem Ackerboden; grabe bis 10×10×10 hier oder bei <x> <y> <z>.";
}
