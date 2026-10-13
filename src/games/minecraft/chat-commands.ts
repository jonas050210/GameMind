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

/** Folds umlauts and punctuation so a typo'd word can be compared with its canonical spelling. */
function canonicalFuzzyText(input: string): string {
  return normalizeChatText(input)
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance with an early exit once `limit` is exceeded. */
function withinEditDistance(left: string, right: string, limit: number): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > limit) return false;
  const rightChars = Array.from(right);
  const width = rightChars.length;
  let previous = Array.from({ length: width + 1 }, (_, index) => index);
  for (const leftChar of left) {
    const current: number[] = [(previous[0] ?? 0) + 1];
    let best = current[0] ?? 0;
    let column = 1;
    for (const rightChar of rightChars) {
      const above = previous[column] ?? limit + 1;
      const diagonal = previous[column - 1] ?? limit + 1;
      const cost = leftChar === rightChar ? 0 : 1;
      const value = Math.min(above + 1, (current[column - 1] ?? limit + 1) + 1, diagonal + cost);
      current.push(value);
      if (value < best) best = value;
      column += 1;
    }
    if (best > limit) return false;
    previous = current;
  }
  return (previous[width] ?? limit + 1) <= limit;
}

/** Control words a fuzzy match may correct. Short confirmations ("ja", "no") stay exact-only. */
const FUZZY_COMMAND_PHRASES: readonly { readonly canonical: string; readonly command: MinecraftChatCommand }[] = [
  { canonical: "help", command: { kind: "help" } },
  { canonical: "hilfe", command: { kind: "help" } },
  { canonical: "befehle", command: { kind: "help" } },
  { canonical: "commands", command: { kind: "help" } },
  { canonical: "kommandos", command: { kind: "help" } },
  { canonical: "menu", command: { kind: "help" } },
  { canonical: "optionen", command: { kind: "help" } },
  { canonical: "was kannst du", command: { kind: "help" } },
  { canonical: "stop", command: { kind: "mode", mode: "stop" } },
  { canonical: "stopp", command: { kind: "mode", mode: "stop" } },
  { canonical: "stoppen", command: { kind: "mode", mode: "stop" } },
  { canonical: "halt", command: { kind: "mode", mode: "stop" } },
  { canonical: "abbruch", command: { kind: "mode", mode: "stop" } },
  { canonical: "cancel", command: { kind: "mode", mode: "stop" } },
  { canonical: "hold", command: { kind: "mode", mode: "hold" } },
  { canonical: "stay", command: { kind: "mode", mode: "hold" } },
  { canonical: "wait", command: { kind: "mode", mode: "hold" } },
  { canonical: "bleib", command: { kind: "mode", mode: "hold" } },
  { canonical: "warte", command: { kind: "mode", mode: "hold" } },
  { canonical: "bleib hier", command: { kind: "mode", mode: "hold" } },
  { canonical: "warte hier", command: { kind: "mode", mode: "hold" } },
  { canonical: "follow", command: { kind: "mode", mode: "follow" } },
  { canonical: "folge", command: { kind: "mode", mode: "follow" } },
  { canonical: "folg", command: { kind: "mode", mode: "follow" } },
  { canonical: "follow me", command: { kind: "mode", mode: "follow" } },
  { canonical: "folge mir", command: { kind: "mode", mode: "follow" } },
  { canonical: "folg mir", command: { kind: "mode", mode: "follow" } },
  { canonical: "come", command: { kind: "mode", mode: "come" } },
  { canonical: "komm", command: { kind: "mode", mode: "come" } },
  { canonical: "come here", command: { kind: "mode", mode: "come" } },
  { canonical: "komm her", command: { kind: "mode", mode: "come" } },
  { canonical: "komm zu mir", command: { kind: "mode", mode: "come" } },
  { canonical: "status", command: { kind: "mode", mode: "status" } },
  { canonical: "zustand", command: { kind: "mode", mode: "status" } },
  { canonical: "wie gehts", command: { kind: "mode", mode: "status" } },
  { canonical: "was machst du", command: { kind: "mode", mode: "status" } },
];

/** Politeness words that carry no command meaning; they are dropped before a fuzzy comparison. */
const FUZZY_POLITENESS_WORDS: ReadonlySet<string> = new Set([
  "bitte", "please", "mal", "doch", "eben", "hey", "hi", "hallo", "hello", "danke", "thanks", "nun", "jetzt", "now",
]);

function fuzzyCommandInput(text: string): string {
  return text
    .split(" ")
    .filter((word) => word !== "" && !FUZZY_POLITENESS_WORDS.has(word))
    .join(" ");
}

/**
 * Matches a short control phrase that was typed with a small typo ("hikfe", "folg mir", "stoppp").
 * Ordinary conversation keeps at least one edit per few letters of distance from every phrase, so it stays
 * conversation; the word count must match so "stop it" or "come on" are never read as commands.
 */
function matchFuzzyChatCommand(text: string): MinecraftChatCommand | null {
  const candidate = fuzzyCommandInput(text);
  if (!candidate || /\d/.test(candidate)) return null;
  const words = candidate.split(" ");
  if (words.length > 3 || candidate.length > 24) return null;
  let best: { readonly command: MinecraftChatCommand; readonly limit: number; readonly length: number } | null = null;
  for (const { canonical, command } of FUZZY_COMMAND_PHRASES) {
    if (canonical.length < 4) continue; // "ja", "no", "ok" are short enough to be dangerous when fuzzed
    if (canonical.split(" ").length !== words.length) continue;
    const limit = canonical.length >= 8 ? 2 : 1;
    if (!withinEditDistance(candidate, canonical, limit)) continue;
    if (!best || limit < best.limit || (limit === best.limit && canonical.length < best.length)) {
      best = { command, limit, length: canonical.length };
    }
  }
  return best?.command ?? null;
}

/**
 * The closest known control phrase for an unrecognized message, for a "Meintest du …?" hint. It never executes
 * anything: the operator still has to send the suggested words. Only longer phrases (≥ 6 characters) are
 * suggested, and only when the difference is at most two edits, so ordinary chat does not get a guess.
 */
export function suggestMinecraftChatCommand(raw: string): string | null {
  const candidate = fuzzyCommandInput(normalizeChatText(raw.replace(/^\s*\/+\s*(?:gamemind\s+)?/i, "")));
  if (!candidate || /\d/.test(candidate) || candidate.length > 24) return null;
  let best: { readonly canonical: string; readonly length: number } | null = null;
  for (const { canonical } of FUZZY_COMMAND_PHRASES) {
    if (canonical.length < 6 || canonical.includes(" ") || candidate.includes(" ")) continue;
    if (!withinEditDistance(candidate, canonical, 2)) continue;
    if (!best || canonical.length > best.length) best = { canonical, length: canonical.length };
  }
  return best?.canonical ?? null;
}

/** Resource names typed with a small typo ("steine", "eisenn"); only used once a resource verb is present. */
function matchFuzzyResourceAlias(text: string): ResourceAlias | null {
  const words = text.split(" ").filter((word) => word.length >= 4);
  let best: { readonly alias: ResourceAlias; readonly limit: number } | null = null;
  for (const alias of resourceAliases) {
    for (const phrase of alias.aliases) {
      const canonical = canonicalFuzzyText(phrase);
      if (canonical.length < 5 || canonical.includes(" ")) continue;
      const limit = canonical.length >= 9 ? 2 : 1;
      for (const word of words) {
        const candidate = canonicalFuzzyText(word);
        if (candidate.length < 4) continue;
        if (!withinEditDistance(candidate, canonical, limit)) continue;
        if (!best || limit < best.limit) best = { alias, limit };
      }
    }
  }
  return best?.alias ?? null;
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
  if (/^(?:help|hilfe|befehle|commands|kommandos|menu|menü|optionen|(?:was )?(?:kannst|kannste) du(?: so| alles)?|(?:hilfe|befehle|commands) bitte)$/.test(text)) return { kind: "help" };
  // A typo in a short control word ("hikfe", "folg mir", "stoppp") is corrected here instead of being
  // forwarded to the language model, which is not allowed to decide anything.
  const fuzzyCommand = matchFuzzyChatCommand(text);
  if (fuzzyCommand) return fuzzyCommand;
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
  const resource = resourceAliases.find(({ aliases }) => matchAlias(text, aliases)) ?? matchFuzzyResourceAlias(text);
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

/**
 * The help text as one short line per command group. Each line is sent as its own Minecraft chat message
 * (mineflayer chat has no line breaks), so the operator reads a list instead of one run-on sentence.
 */
export function describeMinecraftChatHelp(language: "en" | "de" = "de"): readonly string[] {
  if (language === "en") {
    return [
      "Commands: status | help | stop | hold | follow me | come",
      "Resources: get/mine [count] stone, iron, coal, copper, wood, diamond (max 64)",
      "Crafting: craft <tool>, for example craft stone pickaxe",
      "Build: build starter house [at x y z] - fixed 5×5, asks before gathering and building",
      "Plan: plan house A/B/C - relative block, layer and material preview only, never a build",
      "Farm: plant wheat field [WxD] [at x y z] - max 25×50 on hydrated farmland",
      "Dig: dig WxHxD [at x y z] - max 10×10×10, here or at coordinates",
      "Confirm: yes / no - every build, dig and farm job needs a yes/no answer",
      "Unknown messages get a short answer; write help for this list",
    ];
  }
  return [
    "Befehle: status | hilfe | stopp | bleib | folge mir | komm",
    "Ressourcen: hol/sammle/miniere [Anzahl] Stein, Eisen, Kohle, Kupfer, Holz, Diamanten (max 64)",
    "Craften: craft <Werkzeug>, z. B. craft Steinspitzhacke",
    "Bauen: baue Starterhaus [bei x y z] - feste 5×5, fragt vor Sammeln und Bau",
    "Planung: plane Haus A/B/C - reiner Entwurf aus Blöcken, Schichten und Material, kein Bau",
    "Farm: pflanze Weizenfeld [BxT] [bei x y z] - max 25×50 auf bewässertem Ackerboden",
    "Graben: grabe BxHxT [bei x y z] - max 10×10×10, hier oder bei Koordinaten",
    "Bestätigung: ja / nein - jeder Bau-, Grab- und Farmauftrag braucht Ja/Nein",
    "Unbekannte Eingaben werden kurz beantwortet; hilfe zeigt diese Liste",
  ];
}

/**
 * Short answer for chat that is not a command: the most-used commands instead of the full list, so an
 * unrecognized message still teaches the operator something.
 */
export function describeUnknownChatFallback(language: "en" | "de" = "de"): readonly string[] {
  if (language === "en") {
    return [
      "I did not understand that. The most-used commands:",
      "status | stop | hold | follow me | come",
      "get/mine [count] stone, iron, coal, copper, wood or diamond",
      "build starter house | plan house A/B/C | plant wheat field | dig WxHxD",
      "Write help for the full list.",
    ];
  }
  return [
    "Das habe ich nicht verstanden. Die häufigsten Befehle:",
    "status | stopp | bleib | folge mir | komm",
    "hol/sammle [Anzahl] Stein, Eisen, Kohle, Kupfer, Holz oder Diamanten",
    "baue Starterhaus | plane Haus A/B/C | pflanze Weizenfeld | grabe BxHxT",
    "Schreibe hilfe für die vollständige Liste.",
  ];
}

/** One note when the optional local helper cannot answer, so the operator knows why chat stays terse. */
export function describeChatHelperUnavailable(language: "en" | "de", reason: string): string {
  return language === "en"
    ? `Note: the optional chat helper is not ready (${reason}). The fixed commands keep working; help lists them.`
    : `Hinweis: der optionale Chat-Helfer ist nicht bereit (${reason}). Die festen Befehle funktionieren weiter; hilfe zeigt die Liste.`;
}

const GERMAN_CHAT_MARKERS: ReadonlySet<string> = new Set(
  "der die das und ich du mir dir dich sich uns ein eine einem einen einer im am in den dem des auch noch mal schon jetzt nicht keine kein was wie wo wer warum sage sag erkläre befehle verfügbar nur mit von zu auf für hilfe danke hallo gut okay genau verstanden verstehe kannst könnte wir sie er ihr status stopp bleib folge komm baue plane haus weizen graben sammeln abbauen ja nein".split(" "),
);
const ENGLISH_CHAT_MARKERS: ReadonlySet<string> = new Set(
  "the and you your please help not no what how where who why say tell explain command commands available only with from to for of on in is are was were can could should would will may might have has had i me my we our do does did try use send ask status stop hold follow come build plan house farm wheat think need sure dig excavate gather mine collect craft yes hello hi thanks great here there this that it".split(" "),
);

/** Best guess at the operator's language from the words used; a tie falls back to the caller's default. */
export function detectChatLanguage(raw: string, fallback: "de" | "en"): "de" | "en" {
  let german = 0;
  let english = 0;
  for (const word of normalizeChatText(raw).split(" ")) {
    if (GERMAN_CHAT_MARKERS.has(word)) german += 1;
    if (ENGLISH_CHAT_MARKERS.has(word)) english += 1;
  }
  if (german > english) return "de";
  if (english > german) return "en";
  return fallback;
}
